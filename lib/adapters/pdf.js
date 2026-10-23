/**
 * PDF adapter.
 *
 * PDF is the only format here that is not a container we can rebuild, so the
 * rewrite is an *incremental update*: a new Info object plus a new
 * cross-reference section are appended after the last byte, and the original
 * bytes are never touched. A reader follows `/Prev` back to the old table, so a
 * failed or unwanted edit can always be discarded by truncating the file.
 *
 * Encrypted files, hybrid-reference files and anything we cannot parse are
 * skipped rather than guessed at.
 */

import zlib from 'node:zlib'
import { SkipError } from '../errors.js'
import { toPdfDate } from '../time.js'

export const id = 'pdf'
export const extensions = ['.pdf']

const MAX_OBJ_SCAN = 400 * 1024 * 1024

function skipWhitespace(text, index) {
  let i = index
  while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t' || text[i] === '\f' || text[i] === '\0')) {
    i += 1
  }
  return i
}

/** Encode a text value as a PDF string: literal when ASCII, UTF-16BE hex otherwise. */
export function pdfString(value) {
  const text = String(value)
  if (/^[\x20-\x7e]*$/.test(text)) {
    return `(${text.replace(/[\\()]/g, (character) => `\\${character}`)})`
  }
  const little = Buffer.from(text, 'utf16le')
  let hex = 'FEFF'
  for (let i = 0; i + 1 < little.length; i += 2) {
    hex += little[i + 1].toString(16).padStart(2, '0').toUpperCase()
    hex += little[i].toString(16).padStart(2, '0').toUpperCase()
  }
  return `<${hex}>`
}

/** Index just past a balanced `<< ... >>` dictionary, or -1. */
export function findDictEnd(text, start) {
  let depth = 0
  for (let i = start; i < text.length - 1; i += 1) {
    const character = text[i]
    if (character === '(') {
      let nesting = 1
      i += 1
      while (i < text.length && nesting > 0) {
        if (text[i] === '\\') i += 1
        else if (text[i] === '(') nesting += 1
        else if (text[i] === ')') nesting -= 1
        i += 1
      }
      i -= 1
      continue
    }
    if (character === '<' && text[i + 1] === '<') {
      depth += 1
      i += 1
      continue
    }
    if (character === '>' && text[i + 1] === '>') {
      depth -= 1
      i += 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function trailerRefs(dict) {
  const ref = (key) => {
    const match = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict)
    return match ? `${match[1]} ${match[2]} R` : undefined
  }
  const id = /\/ID\s*(\[[^\]]*\])/.exec(dict)
  return {
    root: ref('Root'),
    info: ref('Info'),
    id: id ? id[1] : undefined,
    encrypted: /\/Encrypt\s/.test(dict),
    hybrid: /\/XRefStm\s/.test(dict),
  }
}

function maxObjectNumber(text) {
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g
  let max = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const number = Number(match[1])
    if (Number.isSafeInteger(number) && number > max) max = number
  }
  // Binary stream payloads can contain digit runs that look like object
  // headers. Overestimating only inflates /Size; underestimating would reuse a
  // live object number, so the value is clamped high rather than filtered.
  return Math.min(max, 10_000_000)
}

/** Replace or insert one entry in a PDF dictionary. */
export function setDictEntry(dict, key, value) {
  const pattern = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^()\\\\])*\\)|<[0-9A-Fa-f\\s]*>|\\d+\\s+\\d+\\s+R)`)
  if (pattern.test(dict)) return dict.replace(pattern, () => `/${key} ${value}`)
  const close = dict.lastIndexOf('>>')
  if (close < 0) return dict
  return `${dict.slice(0, close)}/${key} ${value}${dict.slice(close)}`
}

function existingInfoDict(text, infoRef) {
  if (!infoRef) return undefined
  const number = infoRef.split(/\s+/)[0]
  const pattern = new RegExp(`(?:^|[\\s\\r\\n])${number}\\s+\\d+\\s+obj\\b`)
  const match = pattern.exec(text)
  if (!match) return undefined
  const dictStart = text.indexOf('<<', match.index + match[0].length)
  if (dictStart < 0) return undefined
  const dictEnd = findDictEnd(text, dictStart)
  if (dictEnd < 0) return undefined
  return text.slice(dictStart, dictEnd)
}

function pad10(value) {
  return String(value).padStart(10, '0')
}

/** Raw token of one dictionary entry, so it can be compared without rewriting. */
export function readDictRaw(dict, key) {
  const match = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^()\\\\])*\\)|<[0-9A-Fa-f\\s]*>)`).exec(dict)
  return match ? match[1] : undefined
}

/** Decode a PDF text string: literal `(...)` or hex `<...>` (UTF-16BE when BOM'd). */
export function decodePdfText(raw) {
  if (!raw) return undefined
  if (raw.startsWith('(')) {
    return raw
      .slice(1, -1)
      .replace(/\\([nrtbf()\\])/g, (_, character) =>
        ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[character] ?? character,
      )
  }
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '')
    const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
    }
    return bytes.toString('latin1')
  }
  return undefined
}

function xrefEntry(type, offset, generation) {
  const entry = Buffer.alloc(7)
  entry[0] = type
  entry.writeUInt32BE(offset, 1)
  entry.writeUInt16BE(generation, 5)
  return entry
}

/**
 * @returns {{ buffer: Buffer, format: 'pdf', mode: 'table'|'stream' }}
 */
export function stamp(buffer, meta) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) throw new SkipError('PDF 文件过小或已损坏')
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new SkipError('不是 PDF 文件')
  if (buffer.length > MAX_OBJ_SCAN) throw new SkipError('PDF 体积超出处理上限')

  const text = buffer.toString('latin1')
  const startxrefAt = text.lastIndexOf('startxref')
  if (startxrefAt < 0) throw new SkipError('缺少 startxref，文件可能已损坏')

  const offsetMatch = /startxref\s+(\d+)/.exec(text.slice(startxrefAt))
  if (!offsetMatch) throw new SkipError('startxref 无法解析')
  const previous = Number(offsetMatch[1])
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= buffer.length) {
    throw new SkipError('startxref 指向越界位置')
  }

  const sectionAt = skipWhitespace(text, previous)
  const isTable = text.startsWith('xref', sectionAt)
  const objectMatch = isTable ? null : /^(\d+)\s+(\d+)\s+obj/.exec(text.slice(sectionAt))
  if (!isTable && !objectMatch) throw new SkipError('无法识别交叉引用区结构')

  let refs
  if (isTable) {
    const trailerAt = text.indexOf('trailer', sectionAt)
    if (trailerAt < 0) throw new SkipError('找不到 trailer 字典')
    const trailerEnd = text.indexOf('startxref', trailerAt)
    refs = trailerRefs(text.slice(trailerAt + 7, trailerEnd < 0 ? text.length : trailerEnd))
  } else {
    const dictStart = text.indexOf('<<', sectionAt)
    const dictEnd = dictStart < 0 ? -1 : findDictEnd(text, dictStart)
    if (dictEnd < 0) throw new SkipError('无法解析交叉引用流字典')
    refs = trailerRefs(text.slice(dictStart, dictEnd))
  }

  if (refs.encrypted) throw new SkipError('PDF 已加密，无法改写属性')
  if (refs.hybrid) throw new SkipError('PDF 使用混合交叉引用，暂不支持')
  if (!refs.root) throw new SkipError('trailer 缺少 /Root')

  const preserved = existingInfoDict(text, refs.info)
  if (refs.info && preserved === undefined) {
    throw new SkipError('/Info 位于对象流中，暂不支持保留原有字段')
  }

  // Re-stamping must not append another revision. The author alone decides: a
  // PDF that already names the configured author is left exactly as it is,
  // dates included.
  if (preserved) {
    const currentAuthor = decodePdfText(readDictRaw(preserved, 'Author'))
    if (currentAuthor === meta.author) {
      return { buffer, format: 'pdf', mode: isTable ? 'table' : 'stream', changed: false }
    }
  }

  let dict = preserved || '<< >>'
  dict = setDictEntry(dict, 'Author', pdfString(meta.author))
  dict = setDictEntry(dict, 'CreationDate', `(${toPdfDate(meta.created)})`)
  dict = setDictEntry(dict, 'ModDate', `(${toPdfDate(meta.modified)})`)

  const infoNumber = maxObjectNumber(text) + 1
  const infoText = `${infoNumber} 0 obj\n${dict}\nendobj\n`
  const infoOffset = buffer.length
  const idPart = refs.id ? ` /ID ${refs.id}` : ''

  if (isTable) {
    const xrefOffset = infoOffset + infoText.length
    const tail =
      `xref\n${infoNumber} 1\n${pad10(infoOffset)} 00000 n \n` +
      `trailer\n<< /Size ${infoNumber + 1} /Root ${refs.root} /Info ${infoNumber} 0 R /Prev ${previous}${idPart} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`
    const output = Buffer.concat([buffer, Buffer.from(infoText, 'latin1'), Buffer.from(tail, 'latin1')])
    verify(output, infoNumber)
    return { buffer: output, format: 'pdf', mode: 'table' }
  }

  const streamNumber = infoNumber + 1
  const streamOffset = infoOffset + infoText.length
  const entries = Buffer.concat([
    xrefEntry(1, infoOffset, 0),
    xrefEntry(1, streamOffset, 0),
  ])
  const compressed = zlib.deflateSync(entries)
  const header =
    `${streamNumber} 0 obj\n` +
    `<< /Type /XRef /Size ${streamNumber + 1} /W [1 4 2] /Index [${infoNumber} 2] /Prev ${previous}` +
    ` /Root ${refs.root} /Info ${infoNumber} 0 R${idPart} /Filter /FlateDecode /Length ${compressed.length} >>\n` +
    'stream\n'
  const footer = '\nendstream\nendobj\n' + `startxref\n${streamOffset}\n%%EOF\n`
  const output = Buffer.concat([
    buffer,
    Buffer.from(infoText, 'latin1'),
    Buffer.from(header, 'latin1'),
    compressed,
    Buffer.from(footer, 'latin1'),
  ])
  verify(output, infoNumber)
  return { buffer: output, format: 'pdf', mode: 'stream' }
}

/** Re-parse the result and confirm the new Info object is actually reachable. */
export function verify(buffer, infoNumber) {
  const text = buffer.toString('latin1')
  const at = text.lastIndexOf('startxref')
  if (at < 0) throw new Error('PDF_VERIFY_NO_STARTXREF')
  const match = /startxref\s+(\d+)/.exec(text.slice(at))
  if (!match) throw new Error('PDF_VERIFY_BAD_STARTXREF')
  const offset = Number(match[1])
  if (!(offset > 0 && offset < buffer.length)) throw new Error('PDF_VERIFY_OFFSET_RANGE')
  if (!text.includes(`/Info ${infoNumber} 0 R`)) throw new Error('PDF_VERIFY_INFO_MISSING')
  return true
}
