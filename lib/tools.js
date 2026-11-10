// The ctx_* tool family. Each tool returns a small object whose `text` field is
// the only thing the model sees; `output.render` turns it into a text block.

import fs from 'node:fs'
import path from 'node:path'
import { byteLength, oneLine, truncateBytes } from './text.js'
import { LANGUAGES, runScript, setDefaultWorkdir } from './exec.js'

const MAX_RETURN = 65536
const MAX_INDEX_BYTES = 8 * 1024 * 1024

export function formatBytes(n) {
  const num = Number(n) || 0
  if (num < 1024) return `${num} B`
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`
  return `${(num / (1024 * 1024)).toFixed(1)} MB`
}

export function sessionOf(exec) {
  try {
    const id = exec?.agent?.id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

function block(text) {
  return [{ type: 'text', text: String(text ?? '') }]
}

function define({ name, description, parameters, concurrency = false, timeoutMs, run }) {
  return {
    name,
    description,
    parameters,
    isConcurrencySafe: concurrency,
    ...(timeoutMs ? { timeoutMs } : {}),
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: true,
      },
      render(_args, value) {
        if (typeof value === 'string') return block(value)
        if (value && typeof value.text === 'string') return block(value.text)
        return block(JSON.stringify(value ?? {}, null, 2))
      },
    },
    async execute(args, exec) {
      const value = await run(args ?? {}, exec)
      return typeof value === 'string' ? { text: value } : { text: '', ...value }
    },
  }
}

function pickKind(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'md'
  if (ext === '.html' || ext === '.htm') return 'html'
  return 'text'
}

export function createTools({ store, cfg }) {
  const tools = []

  tools.push(
    define({
      name: 'ctx_execute',
      description:
        'Run a shell command or code snippet in a subprocess and return only a capped head of its output. ' +
        'Use this instead of tools that would dump a large result into the context (recursive listings, log tails, JSON dumps, whole-file dumps): ' +
        'only `outputBytes` (default 16 KB) come back, the full output is indexed as a searchable source, and the header tells you its handle. ' +
        'Default runner is powershell on Windows and bash elsewhere; `node` and `python` run the snippet from a temp file. ' +
        'The command runs with the session working directory unless `workdir` is given, and is killed after `timeoutMs`.',
      concurrency: false,
      timeoutMs: 600000,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command, or code when language is node/python.' },
          language: {
            type: 'string',
            enum: LANGUAGES,
            description: 'Runner. Defaults to powershell on Windows, bash elsewhere.',
          },
          workdir: { type: 'string', description: 'Working directory. Defaults to the session workspace.' },
          timeoutMs: { type: 'number', description: 'Wall-clock limit in ms. Default 120000, max 600000.' },
          outputBytes: {
            type: 'number',
            description: `Bytes of output returned to the context. Default ${cfg.outputCapBytes}, max ${MAX_RETURN}.`,
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      run: async (args, exec) => {
        const cap = Math.max(512, Math.min(Number(args.outputBytes) || cfg.outputCapBytes, MAX_RETURN))
        const res = await runScript({
          command: args.command,
          language: args.language,
          workdir: args.workdir,
          timeoutMs: args.timeoutMs ?? 120000,
        })
        if (args.workdir) setDefaultWorkdir(res.workdir)
        const combined = res.stderr ? `${res.stdout}${res.stdout.endsWith('\n') ? '' : '\n'}[stderr]\n${res.stderr}` : res.stdout
        const fullBytes = byteLength(combined)
        const body = truncateBytes(combined, cap)
        const truncated = fullBytes > byteLength(body)
        const session = sessionOf(exec)
        let source = null
        if (truncated && fullBytes > 0) {
          source = store.addSource({
            text: combined,
            label: `run: ${oneLine(String(args.command), 70)}`,
            kind: 'text',
            session,
            title: `run ${res.language}`,
          })
        }
        if (source) store.markReturned(String(source.id), byteLength(body))
        const head = [
          `exit ${res.code ?? 'killed'}${res.timedOut ? ' (timeout)' : ''} · ${res.durationMs} ms · ${formatBytes(fullBytes)} output · ${res.language} · cwd ${res.workdir}`,
          truncated
            ? `returned first ${formatBytes(byteLength(body))}; full output stored as s${source?.id} (${source?.count ?? 0} chunks) — read it with ctx_search({ source: "s${source?.id}" }) or search it with ctx_search({ queries: [...] }).`
            : `returned in full.`,
        ].join('\n')
        return { text: `${head}\n\n${body}${truncated ? '\n… [output truncated]' : ''}` }
      },
    }),
  )

  tools.push(
    define({
      name: 'ctx_index',
      description:
        'Index a file, URL, or inline text as a searchable source without reading it into the context. ' +
        'Use it when you want to be able to search a large document later (logs, exports, docs, generated reports) ' +
        'instead of pasting it into the conversation. Chunks are capped at 4 KB and markdown headings are kept as titles. ' +
        'Pass exactly one of `path`, `url`, or `text`.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          url: { type: 'string', description: 'HTTP(S) URL to fetch and index.' },
          text: { type: 'string', description: 'Literal text to index.' },
          label: { type: 'string', description: 'Display label. Defaults to the path, URL, or a short text preview.' },
          kind: { type: 'string', enum: ['auto', 'md', 'text', 'html'], description: 'Chunking mode. Default auto.' },
        },
        additionalProperties: false,
      },
      run: async (args, exec) => {
        const session = sessionOf(exec)
        let text = ''
        let label = String(args.label ?? '')
        let kind = args.kind ?? 'auto'
        let truncated = false
        if (args.path) {
          const abs = path.resolve(args.path)
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${abs}`)
          const size = fs.statSync(abs).size
          const raw = fs.readFileSync(abs, size > MAX_INDEX_BYTES ? { encoding: 'utf8' } : 'utf8')
          const maxChars = MAX_INDEX_BYTES
          text = raw.length > maxChars ? raw.slice(0, maxChars) : raw
          truncated = raw.length > maxChars
          if (kind === 'auto') kind = pickKind(abs)
          if (!label) label = abs
        } else if (args.url) {
          const res = await fetch(args.url, { signal: AbortSignal.timeout(20000) })
          if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`)
          const type = res.headers.get('content-type') ?? ''
          text = await res.text()
          if (text.length > MAX_INDEX_BYTES) {
            text = text.slice(0, MAX_INDEX_BYTES)
            truncated = true
          }
          if (kind === 'auto') kind = type.includes('html') ? 'html' : type.includes('markdown') ? 'md' : 'text'
          if (!label) label = args.url
        } else if (typeof args.text === 'string') {
          text = args.text
          if (!label) label = `text: ${oneLine(text, 60)}`
        } else {
          throw new Error('provide one of path, url, or text')
        }
        const source = store.addSource({ text, label, kind, session })
        if (!source) return { text: 'nothing to index: the content was empty.' }
        return {
          text: [
            `indexed s${source.id} · ${formatBytes(source.bytes)} · ${source.count} chunks${truncated ? ` · truncated at ${formatBytes(MAX_INDEX_BYTES)}` : ''}`,
            `source: ${source.label}`,
            `search it: ctx_search({ queries: ["..."], source: "s${source.id}" }) · read it whole: ctx_search({ source: "s${source.id}" })`,
          ].join('\n'),
        }
      },
    }),
  )

  tools.push(
    define({
      name: 'ctx_search',
      description:
        'Search everything indexed in this session (tool results the context-mode hook replaced, ctx_index sources, ctx_execute output) ' +
        'by full-text BM25 and return short snippets instead of whole documents. ' +
        'Pass one or more `queries`; they are fused, so several phrasings of the same question work better than one. ' +
        'Every hit names its source handle (s12) and chunk (3/53): `source` narrows to one source, `full: true` returns the whole chunk, ' +
        'and calling with only `source` walks that source chunk by chunk. Prefer this over re-running a command that produced a huge output.',
      concurrency: true,
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'One to four search phrasings. Optional when `source` is given.',
          },
          source: { type: 'string', description: 'Source handle (s12) to restrict to or to read whole.' },
          scope: {
            type: 'string',
            enum: ['session', 'project'],
            description: 'session = this agent only, project = every indexed source (default). Same-session hits rank first.',
          },
          limit: { type: 'number', description: 'Hits to return. Default 8, max 50.' },
          offset: { type: 'number', description: 'Skip hits for paging.' },
          full: { type: 'boolean', description: 'Return whole chunk bodies (up to 4 KB each) instead of snippets.' },
          snippetBytes: { type: 'number', description: 'Snippet budget per hit. Default 800.' },
        },
        additionalProperties: false,
      },
      run: async (args, exec) => {
        const session = sessionOf(exec)
        const scope = args.scope === 'session' ? 'session' : 'project'
        const limit = Math.max(1, Math.min(Number(args.limit) || 8, 50))
        const offset = Math.max(0, Number(args.offset) || 0)
        const source = args.source ? store.resolve(args.source) : null
        if (args.source && !source) {
          return { text: `unknown source handle: ${args.source}. Call ctx_stats to list indexed sources.` }
        }
        const queries = Array.isArray(args.queries) ? args.queries : args.queries ? [args.queries] : []
        const snippetBytes = Math.max(200, Math.min(Number(args.snippetBytes) || 800, 4096))
        const result = store.search({ queries, session, limit, offset, snippetBytes, source })
        const totalSources = store.sources.length
        const totalChunks = store.chunks.length
        if (!result.hits.length) {
          return {
            text:
              `no matches in ${totalChunks} chunks from ${totalSources} sources` +
              (source ? ` of ${source.label}` : '') +
              `.\nTry fewer or different words, or ctx_stats to list sources.` +
              (args.source ? ` Use ctx_search({ source: "${args.source}", limit: 20 }) to read it chunk by chunk.` : ''),
          }
        }
        const header = [
          `${result.total} hit${result.total === 1 ? '' : 's'}`,
          `scope ${scope} · ${totalSources} sources / ${totalChunks} chunks`,
          queries.length ? `queries ${queries.map((q) => JSON.stringify(oneLine(q, 60))).join(' | ')}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
        const lines = [header]
        result.hits.forEach((hit, i) => {
          const meta = [
            `${offset + i + 1}. ${hit.handle}#${hit.ordinal}/${hit.count}`,
            hit.title ? `"${oneLine(hit.title, 80)}"` : '',
            formatBytes(hit.bytes),
            `of ${formatBytes(hit.sourceBytes)}`,
            hit.label ? `· ${oneLine(hit.label, 90)}` : '',
          ]
            .filter(Boolean)
            .join(' ')
          lines.push(meta)
          const body = args.full ? truncateBytes(hit.body, 4096) : hit.snippet
          for (const line of String(body).split('\n')) lines.push(`   ${line}`)
        })
        if (result.total > offset + result.hits.length) {
          lines.push(`… ${result.total - offset - result.hits.length} more hit(s): ctx_search({ queries: [...], offset: ${offset + limit} })`)
        }
        return { text: lines.join('\n') }
      },
    }),
  )

  tools.push(
    define({
      name: 'ctx_stats',
      description:
        'Show what the context-mode store holds for this machine: source and chunk counts, bytes indexed versus bytes returned to the context, ' +
        'the largest sources with their handles, and the data directory. Use it to find a source handle or to check how much output was kept out of the context.',
      concurrency: true,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const s = store.stats()
        const lines = [
          `store ${s.dir}`,
          `${s.sources} sources · ${s.chunks} chunks · ${formatBytes(s.bytes)} indexed · ${s.sessions} session(s)`,
          `indexed ${formatBytes(s.totals.indexed)} · returned to context ${formatBytes(s.totals.returned)} · kept out ${formatBytes(s.saved)}`,
        ]
        if (s.top.length) {
          lines.push('largest sources:')
          for (const item of s.top) {
            lines.push(`  ${item.handle}  ${formatBytes(item.bytes)}  ${item.chunks} chunks  ${oneLine(item.label, 100)}`)
          }
        } else {
          lines.push('nothing indexed yet — run ctx_index or a command through ctx_execute.')
        }
        return { text: lines.join('\n') }
      },
    }),
  )

  tools.push(
    define({
      name: 'ctx_doctor',
      description:
        'Diagnose the context-mode plugin: runtime version, platform, working directory, data directory and file sizes, write access, ' +
        'configuration, and the tools it registered. Use it when ctx_* tools behave unexpectedly or after a plugin update.',
      concurrency: true,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const s = store.stats()
        let writable = true
        let writeError = ''
        try {
          const probe = path.join(cfg.dataDir, `.probe-${process.pid}`)
          fs.writeFileSync(probe, 'ok')
          fs.unlinkSync(probe)
        } catch (err) {
          writable = false
          writeError = String(err?.message ?? err)
        }
        const files = []
        for (const name of ['sources.json', 'chunks.jsonl']) {
          try {
            const st = fs.statSync(path.join(cfg.dataDir, name))
            files.push(`${name} ${formatBytes(st.size)}`)
          } catch {
            files.push(`${name} (missing)`)
          }
        }
        return {
          text: [
            `context-mode plugin ${cfg.version}`,
            `node ${process.versions.node} · ${process.platform} ${process.arch} · electron ${process.versions.electron ?? 'n/a'}`,
            `cwd ${process.cwd()}`,
            `data ${cfg.dataDir} · ${files.join(' · ')}`,
            `writable ${writable ? 'yes' : `NO (${writeError})`}`,
            `store ${s.sources} sources / ${s.chunks} chunks · ${formatBytes(s.bytes)}`,
            `config externalizeOverBytes=${cfg.externalizeOverBytes} digestBytes=${cfg.digestBytes} outputCapBytes=${cfg.outputCapBytes} hook=${cfg.enableHook}`,
            `tools ${tools.map((t) => t.name).join(', ')}`,
          ].join('\n'),
        }
      },
    }),
  )

  return tools
}
