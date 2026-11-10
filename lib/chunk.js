// Markdown-aware chunker: chunks never cross a heading, fenced code blocks stay
// whole when they fit, and every chunk is at most `maxBytes` UTF-8 bytes.

import { byteLength, truncateBytes } from './text.js'

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const FENCE_RE = /^(`{3,}|~{3,})/

export function normalizeText(src) {
  let s = String(src ?? '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  return s.replace(/\r\n?/g, '\n')
}

export function headingOf(line) {
  const m = HEADING_RE.exec(line)
  if (!m) return null
  let text = (m[2] ?? '').trim()
  text = text.replace(/[ \t]+#+[ \t]*$/, '').trim()
  return { level: m[1].length, text }
}

export function fenceOf(line) {
  const m = FENCE_RE.exec(line.trimStart())
  return m ? m[1] : null
}

export function closesFence(line, fence) {
  const t = line.trim()
  if (!t || t[0] !== fence[0]) return false
  let n = 0
  while (n < t.length && t[n] === fence[0]) n += 1
  return n === t.length && n >= fence.length
}

export function hasMdStructure(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (headingOf(line) || fenceOf(line)) return true
  }
  return false
}

/** Split one oversized unit into pieces of at most `cap` bytes, line-aware. */
export function splitLong(text, cap) {
  if (byteLength(text) <= cap) return [text]
  const lines = text.split('\n')
  const pieces = []
  let buf = []
  let bytes = 0
  const flush = () => {
    if (!buf.length) return
    pieces.push(buf.join('\n'))
    buf = []
    bytes = 0
  }
  for (const line of lines) {
    const lb = byteLength(line)
    if (lb > cap) {
      flush()
      let rest = line
      while (byteLength(rest) > cap) {
        const head = truncateBytes(rest, cap)
        pieces.push(head)
        rest = rest.slice(head.length)
      }
      if (rest) pieces.push(rest)
      continue
    }
    const add = lb + (buf.length ? 1 : 0)
    if (bytes + add > cap) flush()
    buf.push(line)
    bytes += lb + (buf.length > 1 ? 1 : 0)
  }
  flush()
  return pieces
}

function fencePieces(opener, inner, closer, cap) {
  const room = cap - byteLength(opener) - byteLength(closer) - 2
  if (room < 16) return null
  const pieces = splitLong(inner.join('\n'), room)
  return pieces.map((p) => `${opener}\n${p}\n${closer}`)
}

function packUnits(units, cap) {
  const out = []
  let cur = null
  for (const unit of units) {
    const text = unit.text
    if (!text) continue
    const bytes = byteLength(text)
    if (!cur) {
      cur = { title: unit.title, parts: [text], bytes }
      continue
    }
    const add = bytes + 1
    const sameSection = !cur.title || !unit.title || cur.title === unit.title
    if (sameSection && cur.bytes + add <= cap) {
      cur.parts.push(text)
      cur.bytes += add
    } else {
      out.push(cur)
      cur = { title: unit.title, parts: [text], bytes }
    }
  }
  if (cur) out.push(cur)
  return out
}

function mdUnits(text, cap) {
  const lines = text.split('\n')
  const blocks = []
  const stack = []
  let title = ''
  let cur = []
  let fence = null
  let mode = 'plain'

  const flush = () => {
    if (!cur.length) return
    blocks.push({ text: cur.join('\n'), title })
    cur = []
  }

  for (const line of lines) {
    if (fence) {
      cur.push(line)
      if (closesFence(line, fence)) {
        flush()
        fence = null
        mode = 'plain'
      }
      continue
    }
    const open = fenceOf(line)
    if (open) {
      flush()
      fence = open
      mode = 'fence'
      cur = [line]
      continue
    }
    const heading = headingOf(line)
    if (heading) {
      flush()
      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop()
      stack.push(heading)
      title = stack
        .map((h) => h.text)
        .filter(Boolean)
        .join(' > ')
      if (heading.text) blocks.push({ text: line, title })
      else cur = [line]
      continue
    }
    if (!line.trim()) {
      flush()
      mode = 'plain'
      continue
    }
    const isTable = line.trimStart().startsWith('|')
    if (isTable) {
      if (mode !== 'table') {
        flush()
        mode = 'table'
      }
      cur.push(line)
      continue
    }
    if (mode === 'table') {
      flush()
      mode = 'plain'
    }
    cur.push(line)
  }
  flush()
  if (fence) {
    // unterminated fence: still emit what we have
  }

  const units = []
  for (const block of blocks) {
    if (byteLength(block.text) <= cap) {
      units.push(block)
      continue
    }
    const first = block.text.split('\n')[0] ?? ''
    const opener = fenceOf(first)
    if (opener) {
      const all = block.text.split('\n')
      const closer = closesFence(all[all.length - 1], opener) ? all[all.length - 1] : null
      const inner = closer ? all.slice(1, -1) : all.slice(1)
      const pieces = closer ? fencePieces(opener, inner, closer, cap) : null
      if (pieces) {
        for (const p of pieces) units.push({ text: p, title: block.title })
        continue
      }
    }
    for (const p of splitLong(block.text, cap)) units.push({ text: p, title: block.title })
  }
  return units
}

/**
 * @param {string} text
 * @param {'md'|'html'|'text'|'auto'} kind
 * @param {number} maxBytes
 * @returns {{text: string, title: string, bytes: number}[]}
 */
export function chunkText(text, kind = 'auto', maxBytes = 4096) {
  const src = normalizeText(text)
  if (!src.trim()) return []
  const md = kind === 'md' || (kind === 'auto' && hasMdStructure(src))
  const units = md ? mdUnits(src, maxBytes) : splitLong(src, maxBytes).map((t) => ({ text: t, title: '' }))
  const chunks = packUnits(units, maxBytes)
    .map((c) => {
      const body = c.parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
      return { text: body, title: c.title || '', bytes: byteLength(body) }
    })
    .filter((c) => c.text.length > 0)
  return chunks
}
