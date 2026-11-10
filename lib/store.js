// Persistent chunk store with an in-memory BM25 index.
//
// Layout under `<dataDir>`:
//   sources.json  { version, nextId, totals, sources: [...] }
//   chunks.jsonl  one {"s":sourceId,"o":ordinal,"b":body,"t":title} per line
//
// The store is intentionally boring: append-only chunk log, small metadata file
// rewritten atomically, oldest sources dropped when limits are exceeded.

import fs from 'node:fs'
import path from 'node:path'
import { chunkText } from './chunk.js'
import { byteLength, makeSnippet, queryTerms, tokenize } from './text.js'

const K1 = 1.2
const B = 0.75
const RRF_K = 60

export class Store {
  constructor(dir, limits = {}) {
    this.dir = dir
    this.maxSources = limits.maxSources ?? 4000
    this.maxBytes = limits.maxBytes ?? 64 * 1024 * 1024
    this.maxChunkBytes = limits.maxChunkBytes ?? 4096
    this.sourcesFile = path.join(dir, 'sources.json')
    this.chunksFile = path.join(dir, 'chunks.jsonl')
    this.sources = []
    this.byId = new Map()
    this.chunks = []
    this.postings = new Map()
    this.nextId = 1
    this.totalBytes = 0
    this.totals = { indexed: 0, returned: 0 }
    this.load()
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      if (fs.existsSync(this.sourcesFile)) {
        const data = JSON.parse(fs.readFileSync(this.sourcesFile, 'utf8'))
        this.nextId = Math.max(1, Number(data.nextId) || 1)
        if (data.totals) {
          this.totals.indexed = Number(data.totals.indexed) || 0
          this.totals.returned = Number(data.totals.returned) || 0
        }
        for (const src of Array.isArray(data.sources) ? data.sources : []) {
          if (!src || !Number.isFinite(src.id)) continue
          this.sources.push(src)
          this.byId.set(src.id, src)
          this.nextId = Math.max(this.nextId, src.id + 1)
        }
      }
    } catch {
      this.sources = []
      this.byId = new Map()
    }
    try {
      if (fs.existsSync(this.chunksFile)) {
        const raw = fs.readFileSync(this.chunksFile, 'utf8')
        for (const line of raw.split('\n')) {
          if (!line) continue
          try {
            const rec = JSON.parse(line)
            if (!this.byId.has(rec.s)) continue
            this.pushChunk(rec.s, Number(rec.o) || 0, String(rec.b ?? ''), String(rec.t ?? ''))
          } catch {
            /* skip corrupt line */
          }
        }
      }
    } catch {
      /* keep whatever loaded */
    }
  }

  pushChunk(sid, ord, body, title) {
    const tokens = new Map()
    for (const t of tokenize(body)) tokens.set(t, (tokens.get(t) ?? 0) + 1)
    let len = 0
    for (const n of tokens.values()) len += n
    const idx = this.chunks.length
    this.chunks.push({ sid, ord, body, title, bytes: byteLength(body), tokens, len, titleTokens: new Set(tokenize(title)) })
    for (const t of tokens.keys()) {
      let set = this.postings.get(t)
      if (!set) {
        set = new Set()
        this.postings.set(t, set)
      }
      set.add(idx)
    }
    const src = this.byId.get(sid)
    if (src) {
      src.count = (src.count ?? 0) + 1
      this.totalBytes += byteLength(body)
    }
  }

  /** @returns {{id:number,label:string,bytes:number,count:number}|null} */
  addSource({ text, label, kind = 'auto', session = '', title = '' }) {
    const body = String(text ?? '')
    if (!body.trim()) return null
    const chunks = chunkText(body, kind, this.maxChunkBytes)
    if (!chunks.length) return null
    // Re-indexing the same label in the same session replaces the old source
    // instead of piling up duplicates (a file read twice keeps one handle).
    const wanted = label || ''
    const existing = wanted
      ? this.sources.find((s) => (s.label ?? '') === wanted && (s.session ?? '') === session)
      : null
    const id = existing ? existing.id : this.nextId++
    const created = existing?.created ?? Date.now()
    if (existing) this.dropSource(existing.id)
    const src = {
      id,
      label: label || `source ${id}`,
      kind,
      session,
      title,
      bytes: 0,
      count: 0,
      ret: 0,
      created,
      accessed: Date.now(),
    }
    this.sources.push(src)
    this.byId.set(id, src)
    const lines = []
    chunks.forEach((chunk, ord) => {
      this.pushChunk(id, ord, chunk.text, chunk.title)
      lines.push(JSON.stringify({ s: id, o: ord, b: chunk.text, t: chunk.title }))
    })
    src.bytes = chunks.reduce((n, c) => n + c.bytes, 0)
    if (lines.length) fs.appendFileSync(this.chunksFile, `${lines.join('\n')}\n`, 'utf8')
    this.totals.indexed += src.bytes
    this.save()
    this.prune()
    return src
  }

  /** Remove a source and its chunks, then rewrite the chunk log. */
  dropSource(sid) {
    const src = this.byId.get(sid)
    if (!src) return
    this.sources = this.sources.filter((s) => s.id !== sid)
    this.byId.delete(sid)
    this.totals.indexed = Math.max(0, this.totals.indexed - (src.bytes ?? 0))
    this.chunks = this.chunks.filter((c) => c.sid !== sid)
    this.postings = new Map()
    this.totalBytes = 0
    this.chunks.forEach((c, i) => {
      for (const t of c.tokens.keys()) {
        let set = this.postings.get(t)
        if (!set) {
          set = new Set()
          this.postings.set(t, set)
        }
        set.add(i)
      }
      this.totalBytes += c.bytes
    })
    this.rewriteLog()
  }

  rewriteLog() {
    try {
      const lines = this.chunks.map((c) => JSON.stringify({ s: c.sid, o: c.ord, b: c.body, t: c.title }))
      const tmp = `${this.chunksFile}.tmp`
      fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
      fs.renameSync(tmp, this.chunksFile)
    } catch {
      /* the next save repairs it */
    }
  }

  markReturned(sid, returnedBytes) {
    const src = this.byId.get(Number(sid))
    if (!src) return
    const add = Math.max(0, Number(returnedBytes) || 0)
    if (!add) return
    src.ret = (src.ret ?? 0) + add
    this.totals.returned += add
    this.saveSoon()
  }

  save() {
    const payload = {
      version: 1,
      nextId: this.nextId,
      totals: this.totals,
      sources: this.sources,
    }
    const tmp = `${this.sourcesFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, this.sourcesFile)
  }

  saveSoon() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.save()
      } catch {
        /* ignore */
      }
    }, 2000)
    this.timer.unref?.()
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      this.save()
    } catch {
      /* ignore */
    }
  }

  prune() {
    if (this.sources.length <= this.maxSources && this.totalBytes <= this.maxBytes) return
    const keep = []
    let bytes = 0
    for (const src of [...this.sources].sort((a, b) => (b.accessed ?? b.created) - (a.accessed ?? a.created))) {
      if (keep.length >= this.maxSources) break
      if (bytes + (src.bytes ?? 0) > this.maxBytes && keep.length > 0) break
      keep.push(src)
      bytes += src.bytes ?? 0
    }
    const keepIds = new Set(keep.map((s) => s.id))
    this.sources = keep
    this.byId = new Map(keep.map((s) => [s.id, s]))
    for (const src of keep) src.count = 0
    this.chunks = []
    this.postings = new Map()
    this.totalBytes = 0
    const lines = []
    // rebuild from the file, keeping only retained sources
    try {
      if (fs.existsSync(this.chunksFile)) {
        for (const line of fs.readFileSync(this.chunksFile, 'utf8').split('\n')) {
          if (!line) continue
          try {
            const rec = JSON.parse(line)
            if (!keepIds.has(rec.s)) continue
            this.pushChunk(rec.s, Number(rec.o) || 0, String(rec.b ?? ''), String(rec.t ?? ''))
            lines.push(line)
          } catch {
            /* skip */
          }
        }
      }
      const tmp = `${this.chunksFile}.tmp`
      fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
      fs.renameSync(tmp, this.chunksFile)
    } catch {
      /* ignore */
    }
    this.save()
  }

  resolve(handle) {
    if (handle == null) return null
    const m = /^s?(\d+)$/i.exec(String(handle).trim())
    if (!m) return null
    return this.byId.get(Number(m[1])) ?? null
  }

  chunksOf(sid) {
    return this.chunks.filter((c) => c.sid === sid)
  }

  /** @returns {{hits:object[], total:number, candidates:number}} */
  search({ queries = [], session = '', limit = 8, offset = 0, snippetBytes = 800, source = null }) {
    const qs = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q ?? '').trim()).filter(Boolean)
    const scoped = source ? this.chunksOf(source.id) : this.chunks
    if (!qs.length) {
      const hits = scoped.slice(0, limit + offset).slice(offset).map((c) => this.toHit(c, [], snippetBytes, source))
      return { hits, total: scoped.length, candidates: scoped.length }
    }
    const N = Math.max(1, scoped.length)
    const fused = new Map()
    let candidates = 0
    qs.forEach((query) => {
      const terms = queryTerms(query)
      if (!terms.length) return
      const scores = new Map()
      for (const term of terms) {
        const list = this.postings.get(term)
        if (!list || !list.size) continue
        const df = list.size
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        for (const idx of list) {
          const chunk = this.chunks[idx]
          if (!chunk) continue
          if (source && chunk.sid !== source.id) continue
          const tf = chunk.tokens.get(term) ?? 0
          if (!tf) continue
          const norm = 1 - B + (B * chunk.len) / 120
          let score = (idf * (tf * (K1 + 1))) / (tf + K1 * norm)
          if (chunk.titleTokens.has(term)) score += idf * 0.6
          scores.set(idx, (scores.get(idx) ?? 0) + score)
        }
      }
      candidates += scores.size
      const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400)
      ranked.forEach(([idx, score], rank) => {
        const prev = fused.get(idx) ?? { score: 0, rank: rank }
        fused.set(idx, { score: prev.score + 1 / (RRF_K + rank + 1) + score * 1e-6, rank: Math.min(prev.rank, rank) })
      })
    })
    const terms = qs.flatMap((q) => queryTerms(q))
    const display = snippetTerms(qs)
    const ordered = [...fused.entries()].sort((a, b) => {
      const ca = this.chunks[a[0]]
      const cb = this.chunks[b[0]]
      const sa = ca.sid && session && this.byId.get(ca.sid)?.session === session ? 1 : 0
      const sb = cb.sid && session && this.byId.get(cb.sid)?.session === session ? 1 : 0
      if (sa !== sb) return sb - sa
      if (b[1].score !== a[1].score) return b[1].score - a[1].score
      const ta = this.byId.get(ca.sid)?.created ?? 0
      const tb = this.byId.get(cb.sid)?.created ?? 0
      if (ta !== tb) return tb - ta
      return ca.ord - cb.ord
    })
    const total = ordered.length
    const hits = ordered.slice(offset, offset + limit).map(([idx]) => this.toHit(this.chunks[idx], display.length ? display : terms, snippetBytes))
    return { hits, total, candidates }
  }

  toHit(chunk, terms, snippetBytes, source) {
    const src = this.byId.get(chunk.sid) ?? source ?? {}
    src.accessed = Date.now()
    this.saveSoon()
    const count = src.count ?? 0
    return {
      handle: `s${chunk.sid}`,
      ordinal: chunk.ord + 1,
      count,
      title: chunk.title || src.title || '',
      label: src.label ?? `source ${chunk.sid}`,
      session: src.session ?? '',
      created: src.created ?? 0,
      bytes: chunk.bytes,
      sourceBytes: src.bytes ?? 0,
      snippet: makeSnippet(chunk.body, terms, snippetBytes),
      body: chunk.body,
    }
  }

  stats() {
    const sessions = new Set(this.sources.map((s) => s.session).filter(Boolean))
    const byBytes = [...this.sources].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 10)
    const newest = this.sources.reduce((n, s) => Math.max(n, s.created ?? 0), 0)
    return {
      dir: this.dir,
      sources: this.sources.length,
      chunks: this.chunks.length,
      bytes: this.totalBytes,
      sessions: sessions.size,
      newest,
      totals: { ...this.totals },
      saved: Math.max(0, this.totals.indexed - this.totals.returned),
      top: byBytes.map((s) => ({
        handle: `s${s.id}`,
        label: s.label,
        bytes: s.bytes ?? 0,
        chunks: s.count ?? 0,
        created: s.created ?? 0,
      })),
    }
  }
}

function snippetTerms(queries) {
  const out = new Set()
  for (const q of queries) {
    for (const w of String(q).toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
      if (w.length >= 2) out.add(w)
    }
  }
  return [...out]
}
