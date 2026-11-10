// Post-execute hook: any tool result over the threshold is indexed whole and
// replaced by a compact digest (header + head/excerpt + a search pointer).
//
// Rules that keep this safe:
//  - never throw: on any failure the original decision is returned unchanged
//  - never touch non-text results (images, attachments)
//  - never touch the plugin's own tools or errored results

import { byteLength, oneLine, truncateBytes } from './text.js'
import { setDefaultWorkdir } from './exec.js'

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return null
  const parts = []
  for (const b of blocks) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') return null
    parts.push(b.text)
  }
  return parts.join('\n')
}

function argHint(args) {
  if (!args || typeof args !== 'object') return ''
  const preferred = ['path', 'file_path', 'filePath', 'command', 'cmd', 'pattern', 'query', 'url', 'notebook_path']
  for (const key of preferred) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function queryFrom(exec, hint) {
  const bits = [exec.name, hint]
  for (const v of Object.values(exec.arguments ?? {})) {
    if (typeof v === 'string') bits.push(v.slice(0, 200))
    else if (typeof v === 'number') bits.push(String(v))
  }
  return bits.join(' ').replace(/\s+/g, ' ').slice(0, 800)
}

function formatBytes(n) {
  const num = Number(n) || 0
  if (num < 1024) return `${num} B`
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`
  return `${(num / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * DSH's `read` wraps its payload in <path>/<type>/<content> tags. Index and show
 * the file body rather than the envelope, and keep the path for the label.
 */
function unwrap(text) {
  if (!text.includes('<content>')) return { body: text, path: '', range: '' }
  const body = /<content>\s*\n?([\s\S]*?)\n?\s*<\/content>/.exec(text)?.[1] ?? text
  const filePath = /<path>([\s\S]*?)<\/path>/.exec(text)?.[1]?.trim() ?? ''
  const first = /^\s*(\d+):/m.exec(body)?.[1] ?? ''
  let last = ''
  const all = [...body.matchAll(/^\s*(\d+):/gm)]
  if (all.length) last = all[all.length - 1][1]
  const range = first ? `lines ${first}${last && last !== first ? `-${last}` : ''}` : ''
  return { body, path: filePath, range }
}

/** Keep whole lines, up to `maxBytes` and `maxLines`. */
function clipLines(text, maxBytes, maxLines = 8) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
  let out = ''
  let count = 0
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line
    if (out && byteLength(next) > maxBytes) break
    out = byteLength(next) > maxBytes ? truncateBytes(line, maxBytes) : next
    count += 1
    if (count >= maxLines) break
  }
  return out
}

export function buildDigest({ store, cfg, exec, text }) {
  const hint = argHint(exec.arguments)
  const { body, path: filePath, range } = exec.name === 'read' ? unwrap(text) : { body: text, path: '', range: '' }
  const label = filePath || (hint ? `${exec.name}: ${oneLine(hint, 90)}` : `${exec.name} result`)
  const source = store.addSource({
    text: body,
    label,
    kind: 'auto',
    session: typeof exec.agent?.id === 'string' ? exec.agent.id : '',
    title: exec.name,
  })
  if (!source) return null

  const header = `[context-mode] ${formatBytes(byteLength(text))} of \`${exec.name}\` output kept out of the context → source s${source.id} (${source.count} chunks)`
  const meta = filePath ? `file: ${filePath}${range ? ` · ${range}` : ''}` : hint ? `from: ${oneLine(hint, 100)}` : ''
  const pointer = `read: ctx_search({ source: "s${source.id}" }) · or search it with your own keywords`

  const budget = Math.max(200, cfg.digestBytes - byteLength(header) - byteLength(meta) - byteLength(pointer) - 24)
  const headShare = filePath ? 0.95 : 0.6
  const headBudget = Math.max(180, Math.floor(budget * headShare))
  const excerptBudget = Math.max(0, budget - headBudget - 40)
  const parts = [header]
  if (meta) parts.push(meta)
  const head = clipLines(body, headBudget, 12)
  if (head) parts.push('', head)
  if (!filePath && excerptBudget >= 120) {
    try {
      const found = store.search({ queries: [queryFrom(exec, hint)], limit: 1, snippetBytes: excerptBudget, source })
      const snippet = found.hits[0]?.snippet ?? ''
      if (snippet && !head.includes(snippet.slice(0, 40))) parts.push('…', clipLines(snippet, excerptBudget, 5))
    } catch {
      /* excerpt is a bonus, never a failure */
    }
  }
  parts.push('', pointer)
  let digest = parts.join('\n')
  if (byteLength(digest) > cfg.digestBytes) digest = truncateBytes(digest, cfg.digestBytes)
  store.markReturned(String(source.id), byteLength(digest))
  return { digest, source }
}

export function installHook({ ctx, cfg, store }) {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const args = exec?.arguments ?? {}
      const dir = args.workdir ?? args.cwd ?? args.dir
      if (typeof dir === 'string' && dir.trim()) setDefaultWorkdir(dir.trim())
    } catch {
      /* ignore */
    }
    const decision = await next()
    try {
      if (!decision || decision.kind !== 'accept') return decision
      const name = String(exec?.name ?? '')
      if (!name || name.startsWith('ctx_') || cfg.skipTools.includes(name)) return decision
      if (result?.isError || result?.error) return decision
      const content = decision.content ?? result?.content
      const text = blocksToText(content)
      if (text == null) return decision
      if (byteLength(text) <= cfg.externalizeOverBytes) return decision
      const built = buildDigest({ store, cfg, exec, text })
      if (!built) return decision
      return {
        kind: 'accept',
        content: [{ type: 'text', text: built.digest }],
        ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
      }
    } catch {
      return decision
    }
  })
}
