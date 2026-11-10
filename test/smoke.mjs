// Smoke test for the plugin internals; run with `node test/smoke.mjs`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chunkText } from '../lib/chunk.js'
import { Store } from '../lib/store.js'
import { createTools } from '../lib/tools.js'
import { buildDigest } from '../lib/hook.js'
import { resolveConfig } from '../index.js'
import { byteLength } from '../lib/text.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmode-'))
const cfg = { ...resolveConfig({ dataDir: dir }), dataDir: dir }
let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL ${name}: ${err.message}`)
  }
}

// ---------- chunker ----------
const md = [
  '# Alpha',
  '',
  'intro paragraph about contexts and windows',
  '',
  '## Beta',
  '',
  '```js',
  'const a = 1',
  'console.log(a)',
  '```',
  '',
  '### Gamma',
  '',
  'x'.repeat(9000),
  '',
].join('\n')

const chunks = chunkText(md, 'md', 4096)
check('chunks respect byte cap', () => {
  assert.ok(chunks.length >= 3)
  for (const c of chunks) assert.ok(byteLength(c.text) <= 4096, `chunk too big: ${byteLength(c.text)}`)
})
check('heading titles are carried', () => {
  const titles = chunks.map((c) => c.title).join(' | ')
  assert.match(titles, /Alpha/)
  assert.match(titles, /Alpha > Beta/)
})
check('fenced block is not split mid-code', () => {
  const fenced = chunks.find((c) => c.text.includes('console.log(a)'))
  assert.ok(fenced)
  assert.ok(fenced.text.includes('const a = 1'))
})
check('empty text yields no chunks', () => assert.deepEqual(chunkText('   \n\n', 'auto', 4096), []))

// ---------- store ----------
const store = new Store(dir, { maxBytes: 32 * 1024 * 1024 })
const doc = [
  '# Deployment notes',
  '',
  'The release pipeline builds the desktop bundle and uploads artifacts.',
  '',
  '## Rollback',
  '',
  'Run the rollback script, then verify the health endpoint responds.',
].join('\n')
fs.writeFileSync(path.join(dir, 'doc.md'), doc, 'utf8')
const src = store.addSource({ text: doc, label: 'notes.md', kind: 'md', session: 'sess-1' })
check('source indexed', () => {
  assert.ok(src && src.id >= 1)
  assert.ok(src.count >= 1)
})
const found = store.search({ queries: ['rollback health'], session: 'sess-1' })
check('bm25 finds the right chunk', () => {
  assert.ok(found.hits.length >= 1)
  assert.match(found.hits[0].snippet.toLowerCase(), /rollback|health/)
})
check('chinese query works', () => {
  store.addSource({ text: '上下文模式会把巨大的输出存到本地索引里，然后用摘要代替它。', label: 'zh', kind: 'text' })
  const r = store.search({ queries: ['巨大的输出'] })
  assert.ok(r.hits.length >= 1, 'no CJK hit')
})
check('search by source handle', () => {
  const resolved = store.resolve(`s${src.id}`)
  assert.ok(resolved)
  const r = store.search({ source: resolved, limit: 10 })
  assert.equal(r.total, store.chunksOf(src.id).length)
})

// persistence
const store2 = new Store(dir, {})
check('store reloads from disk', () => {
  assert.equal(store2.sources.length, store.sources.length)
  assert.equal(store2.chunks.length, store.chunks.length)
  assert.ok(store2.search({ queries: ['rollback'] }).hits.length >= 1)
})

// ---------- tools ----------
const tools = createTools({ store, cfg })
const byName = new Map(tools.map((t) => [t.name, t]))
check('all ctx tools present', () => {
  for (const name of ['ctx_execute', 'ctx_index', 'ctx_search', 'ctx_stats', 'ctx_doctor']) assert.ok(byName.has(name), name)
})
check('every tool has output.render', () => {
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function')
    const blocks = t.output.render({}, { text: 'hello' })
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, 'hello')
  }
})

const call = async (name, args, exec = { agent: { id: 'sess-1' } }) => {
  const def = byName.get(name)
  const value = await def.execute(args, exec)
  return def.output.render(args, value)[0].text
}

// The DSH pwsh sandbox may deny pipe-based child processes, so subprocess
// checks are skipped when even the file-handle fallback cannot run.
const { runScript } = await import('../lib/exec.js')
const spawnable = await (async () => {
  try {
    const probe = await runScript({ command: 'console.log("probe")', language: 'node', timeoutMs: 15000 })
    return probe.code === 0
  } catch {
    return false
  }
})()

if (spawnable) {
  const out = await call('ctx_execute', {
    command: 'console.log("hello from ctx"); for (let i = 0; i < 200; i += 1) console.log("line " + i)',
    language: 'node',
  })
  check('ctx_execute returns output', () => assert.match(out, /hello from ctx/))
  check('ctx_execute reports exit and cwd', () => {
    assert.match(out, /exit 0/)
    assert.match(out, /cwd /)
  })

  const big = await call('ctx_execute', {
    command: 'for (let i = 0; i < 8000; i += 1) console.log("row " + i + " lorem ipsum dolor sit amet consectetur")',
    language: 'node',
    outputBytes: 2048,
  })
  check('ctx_execute truncates and stores the rest', () => {
    assert.match(big, /full output stored as s\d+/)
    assert.match(big, /\[output truncated\]/)
    assert.ok(byteLength(big) < 20000, `returned ${byteLength(big)} bytes`)
  })
} else {
  console.log('skip ctx_execute subprocess checks (spawn denied in this sandbox)')
}

const indexed = await call('ctx_index', { path: path.join(dir, 'doc.md'), label: 'doc' })
check('ctx_index indexes a file', () => assert.match(indexed, /indexed s\d+/))

const searched = await call('ctx_search', { queries: ['rollback script'], limit: 3 })
check('ctx_search returns hits with handles', () => {
  assert.match(searched, /hit/)
  assert.match(searched, /s\d+#\d+/)
})

// ---------- hook digest ----------
const payload = 'error: connection refused\n' + 'stack frame at module.js\n'.repeat(400)
const built = buildDigest({ store, cfg, exec: { name: 'pwsh', arguments: { command: 'npm test' }, agent: { id: 'sess-1' } }, text: payload })
check('digest is small', () => {
  assert.ok(built && built.digest.length > 0)
  assert.ok(byteLength(built.digest) <= cfg.digestBytes, `${byteLength(built.digest)} > ${cfg.digestBytes}`)
})
check('digest points at its source', () => assert.match(built.digest, new RegExp(`s${built.source.id}`)))
check('digest mentions context-mode', () => assert.match(built.digest, /\[context-mode\]/))

// ---------- pruning ----------
const prunedir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmode-prune-'))
const small = new Store(prunedir, { maxSources: 3, maxBytes: 64 * 1024 })
for (let i = 0; i < 6; i += 1) {
  small.addSource({ text: `source number ${i} `.repeat(50), label: `s${i}` })
  small.sources[small.sources.length - 1].accessed = Date.now() + i
}
small.prune()
check('prune keeps at most maxSources', () => assert.ok(small.sources.length <= 3, `${small.sources.length}`))
check('prune keeps newest sources', () => assert.ok(small.sources.some((s) => s.label === 's5')))
const small2 = new Store(prunedir, {})
check('pruned store reloads consistently', () => assert.equal(small2.sources.length, small.sources.length))

// ---------- re-indexing the same label replaces the old source ----------
const dedupe = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmode-dedupe-')), {})
const firstRead = dedupe.addSource({ text: 'alpha beta gamma', label: 'notes.md', session: 'a' })
const secondRead = dedupe.addSource({ text: 'delta epsilon zeta', label: 'notes.md', session: 'a' })
check('re-indexing a label reuses the handle', () => assert.equal(secondRead.id, firstRead.id))
check('re-indexing replaces old chunks', () => {
  assert.equal(dedupe.sources.length, 1)
  assert.equal(dedupe.search({ queries: ['alpha'], source: secondRead }).hits.length, 0)
  assert.equal(dedupe.search({ queries: ['delta'], source: secondRead }).hits.length, 1)
})
check('re-indexed store reloads consistently', () => assert.equal(new Store(dedupe.dir, {}).sources.length, 1))

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
