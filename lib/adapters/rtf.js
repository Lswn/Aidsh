/**
 * RTF adapter.
 *
 * RTF carries author information in the `{\info ...}` destination. The adapter
 * locates that group with a brace-aware scan (so `\{`, `\}` and `\\` do not
 * confuse it), rewrites only `\author`, `\creatim` and `\revtim`, and never
 * re-serializes the rest of the document.
 */

import { SkipError } from '../errors.js'
import { toRtfDate } from '../time.js'

export const id = 'rtf'
export const extensions = ['.rtf']

/** Encode text as RTF, using `\uN?` for everything outside ASCII. */
export function encodeRtf(text) {
  let out = ''
  for (const character of String(text)) {
    const code = character.codePointAt(0)
    if (character === '\\' || character === '{' || character === '}') {
      out += `\\${character}`
    } else if (code >= 0x20 && code < 0x7f) {
      out += character
    } else if (code <= 0xffff) {
      out += `\\u${code > 0x7fff ? code - 0x10000 : code}?`
    } else {
      // Astral characters become a surrogate pair, one \u each.
      const offset = code - 0x10000
      const high = 0xd800 + (offset >> 10)
      const low = 0xdc00 + (offset & 0x3ff)
      out += `\\u${high - 0x10000}?\\u${low - 0x10000}?`
    }
  }
  return out
}

/** Index of the brace that closes the group starting at `start`, or -1. */
export function findGroupEnd(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const character = text[i]
    if (character === '\\') {
      i += 1
      // Control symbols such as \'hh carry two hex digits as plain characters.
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function infoGroup(author, created, modified) {
  return (
    '{\\info' +
    `{\\author ${encodeRtf(author)}}` +
    `{\\creatim${toRtfDate(created)}}` +
    `{\\revtim${toRtfDate(modified)}}` +
    '}'
  )
}

function replaceControl(text, name, replacement) {
  const pattern = new RegExp(`\\\\${name}(?![a-zA-Z])[^;}]*;?`, 'g')
  if (!pattern.test(text)) return null
  return text.replace(pattern, () => replacement)
}

export function rewriteRtf(text, meta) {
  const author = `\\author ${encodeRtf(meta.author)};`
  const created = `\\creatim${toRtfDate(meta.created)};`
  const modified = `\\revtim${toRtfDate(meta.modified)};`

  const infoAt = text.indexOf('{\\info')
  if (infoAt < 0) {
    const header = /^\{\\rtf1[0-9]*/.exec(text)
    if (!header) return null
    const at = header[0].length
    return `${text.slice(0, at)}${infoGroup(meta.author, meta.created, meta.modified)}${text.slice(at)}`
  }

  const end = findGroupEnd(text, infoAt)
  if (end < 0) return null
  const before = text.slice(0, infoAt)
  let inner = text.slice(infoAt, end + 1)
  const after = text.slice(end + 1)

  inner = replaceControl(inner, 'author', author) ?? inner.replace('{\\info', `{\\info{${author}}`)
  inner = replaceControl(inner, 'creatim', created) ?? inner.replace('{\\info', `{\\info{${created}}`)
  inner = replaceControl(inner, 'revtim', modified) ?? inner.replace('{\\info', `{\\info{${modified}}`)

  return before + inner + after
}

export function stamp(buffer, meta) {
  const text = buffer.toString('latin1')
  if (!text.startsWith('{\\rtf')) throw new SkipError('不是 RTF 文件')

  const rewritten = rewriteRtf(text, meta)
  if (rewritten === null) throw new SkipError('RTF 头部无法识别')

  const output = Buffer.from(rewritten, 'latin1')
  if (output.length === 0) throw new SkipError('RTF 改写结果为空')
  return { buffer: output, format: 'rtf' }
}
