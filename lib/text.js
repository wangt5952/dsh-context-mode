// Text utilities: tokenization, light stemming, snippets.
// Kept dependency-free so it runs inside the Electron host without native modules.

const WORD_RE = /[\p{L}\p{N}_]+/gu
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

export const STOPWORDS = new Set(
  (
    'a an the and or but if then than that this these those of in on at to for from by with without into onto over under ' +
    'again further once here there when where why how all any both each few more most other some such no nor not only own ' +
    'same so too very can will just should now is are was were be been being do does did doing have has had having it its ' +
    'as we you your i he she they them their our us me my mine also about above after before below between during through'
  ).split(/\s+/),
)

export function isCjk(token) {
  return CJK_RE.test(token)
}

// A deliberately small suffix stripper. FTS5 in the original uses porter; this
// matches the common English inflections without pulling in a port.
function stem(word) {
  if (word.length <= 3 || isCjk(word)) return word
  let w = word
  if (/[^aeiou]ss$/.test(w) || /(us|is)$/.test(w)) return w
  const rules = [
    ['ingly', ''],
    ['edly', ''],
    ['ing', ''],
    ['ies', 'y'],
    ['ied', 'y'],
    ['es', ''],
    ['ed', ''],
    ['ly', ''],
    ['s', ''],
  ]
  for (const [suffix, repl] of rules) {
    if (w.endsWith(suffix)) {
      const cut = w.slice(0, w.length - suffix.length)
      if (cut.length >= 3) {
        w = cut + repl
        break
      }
    }
  }
  return w
}

/**
 * Split text into indexable terms.
 * Latin words are lowercased and stemmed; CJK runs become bigrams and
 * single-character runs are kept so short Chinese queries still match.
 */
export function tokenize(text) {
  const out = []
  if (!text) return out
  const lower = String(text).toLowerCase()
  const matches = lower.match(WORD_RE)
  if (!matches) return out
  for (const raw of matches) {
    if (isCjk(raw)) {
      if (raw.length === 1) {
        out.push(raw)
        continue
      }
      for (let i = 0; i + 1 < raw.length; i += 1) out.push(raw.slice(i, i + 2))
      continue
    }
    if (raw.length < 2 && !/[0-9]/.test(raw)) continue
    out.push(stem(raw))
  }
  return out
}

/** Terms used for query matching; stopwords are dropped unless nothing is left. */
export function queryTerms(text) {
  const all = tokenize(text)
  const kept = all.filter((t) => !STOPWORDS.has(t))
  return kept.length ? kept : all
}

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a surrogate pair. */
export function truncateBytes(text, maxBytes) {
  const s = String(text ?? '')
  if (byteLength(s) <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  // do not end on a lone high surrogate
  if (lo > 0 && lo < s.length) {
    const code = s.charCodeAt(lo - 1)
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1
  }
  return s.slice(0, lo)
}

function snapStart(text, pos) {
  const nl = text.lastIndexOf('\n', pos)
  if (nl >= 0 && pos - nl <= 120) return nl + 1
  return pos
}

function snapEnd(text, pos) {
  const nl = text.indexOf('\n', pos)
  if (nl >= 0 && nl - pos <= 120) return nl
  return pos
}

/**
 * Contiguous excerpt around the earliest query term, grown to whole lines and
 * capped at `maxBytes`. Mirrors the original's "one contiguous slice" rule.
 */
export function makeSnippet(body, terms, maxBytes = 800) {
  const text = String(body ?? '')
  if (!text) return ''
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    if (!term) continue
    const i = lower.indexOf(term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) at = 0
  const radius = Math.max(160, Math.floor(maxBytes / 2))
  let start = Math.max(0, at - Math.floor(radius / 2))
  start = snapStart(text, start)
  let end = Math.min(text.length, start + Math.max(maxBytes, radius))
  end = snapEnd(text, end)
  if (end <= start) end = Math.min(text.length, start + radius)
  let slice = text.slice(start, end)
  if (byteLength(slice) > maxBytes) slice = truncateBytes(slice, maxBytes)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${slice}${suffix}`
}

export function oneLine(text, maxChars = 120) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s
}
