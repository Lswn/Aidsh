/**
 * One normalisation pass over one file.
 *
 * The rules here are the safety contract: sniff before trusting an extension,
 * refuse anything that is not clearly supported, build the new bytes in memory,
 * verify them, and only then replace the file atomically. Any failure leaves the
 * original untouched.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { adapterFor } from './adapters/index.js'
import { encodeRtf } from './adapters/rtf.js'
import { readZip, readText, findEntryName, isZip } from './zip.js'
import { SkipError } from './errors.js'

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** Container kind from the first bytes, never from the file name. */
export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return undefined
  if (isZip(buffer)) return 'zip'
  if (buffer.subarray(0, 8).equals(OLE_MAGIC)) return 'ole'
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf'
  return undefined
}

/**
 * True when the document already carries the configured author.
 *
 * The author alone decides: a file the user made themselves already has their
 * name, and rewriting its dates would only make a truthful document less
 * truthful. This is also what keeps the plugin from touching files it merely
 * noticed.
 */
function alreadyAuthored(buffer, extension, meta) {
  if (!isZip(buffer)) return false
  try {
    const zip = readZip(buffer)
    const isOdf = ['.odt', '.ods', '.odp'].includes(extension)
    const partName = isOdf ? 'meta.xml' : 'docProps/core.xml'
    const name = findEntryName(zip, partName)
    if (!name) return false
    return opcAuthor(readText(zip, name), 'dc:creator') === meta.author
  } catch {
    return false
  }
}

/** RTF stores the author as `\uN?` escapes, so compare against the encoding. */
function rtfAlreadyAuthored(buffer, meta) {
  try {
    return buffer.toString('latin1').includes(`\\author ${encodeRtf(meta.author)}`)
  } catch {
    return false
  }
}

function opcAuthor(text, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(text)
  return match ? match[1].trim() : undefined
}

/** Apply the adapter and sanity-check the result before it can reach the disk. */
export function normalizeBuffer(buffer, extension, meta) {
  const kind = sniff(buffer)
  if (kind === 'ole') throw new SkipError('旧版 Office 二进制格式，无法安全改写')
  if (kind !== 'zip' && kind !== 'pdf' && kind !== 'rtf') throw new SkipError('无法识别的文件结构')

  const adapter = adapterFor(extension)
  if (!adapter) throw new SkipError(`不支持的扩展名: ${extension || '(无)'}`)
  if (kind === 'zip' && adapter.id === 'pdf') throw new SkipError('扩展名与文件内容不符')
  if (kind === 'pdf' && adapter.id !== 'pdf') throw new SkipError('扩展名与文件内容不符')
  if (kind === 'rtf' && adapter.id !== 'rtf') throw new SkipError('扩展名与文件内容不符')
  if (kind === 'zip' && adapter.id === 'rtf') throw new SkipError('扩展名与文件内容不符')

  if (kind === 'zip' && alreadyAuthored(buffer, extension, meta)) {
    return { buffer, changed: false, reason: '作者已是目标值' }
  }
  if (kind === 'rtf' && rtfAlreadyAuthored(buffer, meta)) {
    return { buffer, changed: false, reason: '作者已是目标值' }
  }

  const result = adapter.stamp(buffer, meta)
  if (!result || !Buffer.isBuffer(result.buffer) || result.buffer.length === 0) {
    throw new SkipError('改写结果为空')
  }
  if (result.changed === false) {
    return { buffer, changed: false, reason: '已是目标属性' }
  }
  if (kind === 'zip') readZip(result.buffer)
  return { buffer: result.buffer, changed: true, format: result.format, mode: result.mode }
}

const WINDOWS_RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES'])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Read a file that another process may be holding open. Word and LibreOffice
 * keep a share lock for a moment after writing, so a transient EBUSY is normal
 * and must not be reported as a failure.
 */
async function readFileWithRetry(file, attempts = 4) {
  let last
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      return await fs.readFile(file)
    } catch (error) {
      last = error
      if (!WINDOWS_RETRYABLE.has(error.code) || attempt === attempts) break
      await sleep(60 * 2 ** attempt)
    }
  }
  throw new SkipError(`无法读取文件: ${last?.code || last?.message}`)
}

/**
 * Rewrite one file on disk.
 *
 * @returns {Promise<{changed: boolean, reason?: string, format?: string}>}
 */
export async function stampFile(file, identity = {}, options = {}) {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024
  let stat
  try {
    stat = await fs.stat(file)
  } catch (error) {
    throw new SkipError(`无法读取文件: ${error.code || error.message}`)
  }
  if (!stat.isFile()) throw new SkipError('不是普通文件')
  if (stat.size > maxBytes) throw new SkipError('超过体积上限')

  const author = String(identity.author || '').trim()
  if (!author) throw new SkipError('作者为空，跳过')

  // The dates come from the file itself: it was generated moments ago, so its
  // own timestamps are exactly the "generation date" we are asked to record.
  const meta = {
    author,
    lastModifiedBy: String(identity.lastModifiedBy || '').trim() || author,
    created: identity.created ?? new Date(stat.birthtimeMs || stat.mtimeMs),
    modified: identity.modified ?? new Date(stat.mtimeMs),
  }

  const buffer = await readFileWithRetry(file)
  const extension = path.extname(file).toLowerCase()
  const outcome = normalizeBuffer(buffer, extension, meta)
  if (!outcome.changed) return outcome

  const directory = path.dirname(file)
  const base = path.basename(file)
  const temporary = path.join(directory, `.${base}.${process.pid}.${Date.now()}.stamp.tmp`)

  try {
    await fs.writeFile(temporary, outcome.buffer, { mode: stat.mode })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, file)
        break
      } catch (error) {
        if (!WINDOWS_RETRYABLE.has(error.code) || attempt >= 4) throw error
        await sleep(80 * 2 ** attempt)
      }
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw new SkipError(`写入失败: ${error.code || error.message}`)
  }

  // Restoring the timestamps keeps the file's own "when was this generated"
  // answer intact; the metadata dates come from the same values.
  await fs.utimes(file, stat.atime, stat.mtime).catch(() => {})
  return outcome
}
