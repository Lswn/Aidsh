/**
 * Surgical ZIP rewriting.
 *
 * The whole point of this module is to change exactly one entry and keep every
 * other byte of the archive untouched: local headers, extra fields (the UTF-8
 * filename record lives there), compression methods, entry order and archive
 * comment all survive. A normal "unzip into entries, zip them back" library
 * destroys those details, which is why this package ships its own engine.
 *
 * Only the central directory is rebuilt, because changing one entry's size
 * shifts the offset of everything after it.
 */

import zlib from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008
const ZIP64_MARKER16 = 0xffff
const ZIP64_MARKER32 = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC-32 of a buffer, matching the value stored in ZIP headers. */
export function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function readU16(buffer, offset) {
  return buffer.readUInt16LE(offset)
}

function readU32(buffer, offset) {
  return buffer.readUInt32LE(offset)
}

/**
 * Locate the last end-of-central-directory record.
 * The record is 22 bytes plus a comment of up to 64 KiB, so the scan window is
 * bounded and the search runs backwards from the tail.
 */
function findEocd(buffer) {
  const stop = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= stop; i -= 1) {
    if (readU32(buffer, i) === SIG_EOCD) return i
  }
  return -1
}

/** Parse a ZIP archive into entries plus the pieces needed to rewrite it. */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP_TOO_SMALL')

  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('ZIP_EOCD_NOT_FOUND')

  const diskNumber = readU16(buffer, eocd + 4)
  const cdDisk = readU16(buffer, eocd + 6)
  const countOnDisk = readU16(buffer, eocd + 8)
  const count = readU16(buffer, eocd + 10)
  const cdSize = readU32(buffer, eocd + 12)
  const cdOffset = readU32(buffer, eocd + 16)
  const commentLength = readU16(buffer, eocd + 20)
  if (commentLength > buffer.length - eocd - 22) throw new Error('ZIP_EOCD_TRUNCATED')
  const comment = buffer.subarray(eocd + 22, eocd + 22 + commentLength)

  if (diskNumber !== 0 || cdDisk !== 0 || countOnDisk !== count) throw new Error('ZIP_MULTI_DISK_UNSUPPORTED')
  if (count === ZIP64_MARKER16 || cdOffset === ZIP64_MARKER32) throw new Error('ZIP64_UNSUPPORTED')
  if (cdOffset + cdSize > buffer.length) throw new Error('ZIP_CENTRAL_DIRECTORY_OUT_OF_RANGE')

  const entries = []
  let cursor = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || readU32(buffer, cursor) !== SIG_CENTRAL) {
      throw new Error('ZIP_CENTRAL_DIRECTORY_CORRUPT')
    }
    const flags = readU16(buffer, cursor + 8)
    const method = readU16(buffer, cursor + 10)
    const time = readU16(buffer, cursor + 12)
    const date = readU16(buffer, cursor + 14)
    const crc = readU32(buffer, cursor + 16)
    const compressedSize = readU32(buffer, cursor + 20)
    const uncompressedSize = readU32(buffer, cursor + 24)
    const nameLength = readU16(buffer, cursor + 28)
    const extraLength = readU16(buffer, cursor + 30)
    const commentLength2 = readU16(buffer, cursor + 32)
    const internalAttributes = readU16(buffer, cursor + 36)
    const externalAttributes = readU32(buffer, cursor + 38)
    const localOffset = readU32(buffer, cursor + 42)

    const nameStart = cursor + 46
    const extraStart = nameStart + nameLength
    const commentStart = extraStart + extraLength
    if (commentStart + commentLength2 > buffer.length) throw new Error('ZIP_ENTRY_OVERFLOWS_ARCHIVE')

    const name = buffer.toString('utf8', nameStart, nameStart + nameLength)
    const extra = Buffer.from(buffer.subarray(extraStart, extraStart + extraLength))
    const entryComment = Buffer.from(buffer.subarray(commentStart, commentStart + commentLength2))

    if (compressedSize === ZIP64_MARKER32 || uncompressedSize === ZIP64_MARKER32 || localOffset === ZIP64_MARKER32) {
      throw new Error('ZIP64_UNSUPPORTED')
    }
    if (localOffset + 30 > buffer.length || readU32(buffer, localOffset) !== SIG_LOCAL) {
      throw new Error('ZIP_LOCAL_HEADER_CORRUPT')
    }
    const localNameLength = readU16(buffer, localOffset + 26)
    const localExtraLength = readU16(buffer, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) throw new Error('ZIP_ENTRY_DATA_OUT_OF_RANGE')

    entries.push({
      name,
      flags,
      method,
      time,
      date,
      crc,
      compressedSize,
      uncompressedSize,
      internalAttributes,
      externalAttributes,
      localOffset,
      dataStart,
      extra,
      comment: entryComment,
    })

    cursor = commentStart + commentLength2
  }

  return { buffer, entries, comment, cdOffset }
}

function localHeader({ flags, method, time, date, crc, compressedSize, uncompressedSize, nameBuffer }) {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(SIG_LOCAL, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(flags, 6)
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(compressedSize, 18)
  header.writeUInt32LE(uncompressedSize, 22)
  header.writeUInt16LE(nameBuffer.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

function centralHeader(entry, nameBuffer) {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(SIG_CENTRAL, 0)
  header.writeUInt16LE(0x031e, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(entry.flags, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.time, 12)
  header.writeUInt16LE(entry.date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compressedSize, 20)
  header.writeUInt32LE(entry.uncompressedSize, 24)
  header.writeUInt16LE(nameBuffer.length, 28)
  header.writeUInt16LE(entry.extra ? entry.extra.length : 0, 30)
  header.writeUInt16LE(entry.comment ? entry.comment.length : 0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(entry.internalAttributes, 36)
  header.writeUInt32LE(entry.externalAttributes, 38)
  header.writeUInt32LE(entry.localOffset, 42)
  return header
}

/**
 * Rebuild an archive with the given entries replaced and/or deleted.
 *
 * `replacements` maps entry name to new uncompressed content.
 * Unchanged entries are copied as raw byte ranges, so their headers, extra
 * fields and compression state survive verbatim.
 */
export function writeZip(zip, replacements = new Map(), deletions = new Set()) {
  const ordered = [...zip.entries].sort((a, b) => a.localOffset - b.localOffset)
  const chunks = []
  const rebuilt = []
  let position = 0

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]
    if (deletions.has(entry.name)) continue

    const replacement = replacements.get(entry.name)
    const regionEnd = index + 1 < ordered.length ? ordered[index + 1].localOffset : zip.cdOffset

    if (replacement === undefined) {
      const raw = zip.buffer.subarray(entry.localOffset, regionEnd)
      chunks.push(raw)
      rebuilt.push({ ...entry, localOffset: position })
      position += raw.length
      continue
    }

    const data = Buffer.isBuffer(replacement) ? replacement : Buffer.from(replacement)
    const crc = crc32(data)
    let method = 8
    let compressed = zlib.deflateRawSync(data, { level: 9 })
    if (compressed.length >= data.length) {
      method = 0
      compressed = data
    }
    // A data descriptor would need a 12-byte trailer we are not emitting, so
    // the rewritten entry always carries its sizes in the local header.
    const flags = entry.flags & ~FLAG_DATA_DESCRIPTOR
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    chunks.push(
      localHeader({
        flags,
        method,
        time: entry.time,
        date: entry.date,
        crc,
        compressedSize: compressed.length,
        uncompressedSize: data.length,
        nameBuffer,
      }),
      nameBuffer,
      compressed,
    )
    rebuilt.push({
      ...entry,
      flags,
      method,
      crc,
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      localOffset: position,
      extra: Buffer.alloc(0),
    })
    position += 30 + nameBuffer.length + compressed.length
  }

  const centralOffset = position
  const centralChunks = []
  for (const entry of rebuilt) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    centralChunks.push(
      centralHeader(entry, nameBuffer),
      nameBuffer,
      entry.extra || Buffer.alloc(0),
      entry.comment || Buffer.alloc(0),
    )
  }
  const central = Buffer.concat(centralChunks)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(rebuilt.length, 8)
  eocd.writeUInt16LE(rebuilt.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(zip.comment ? zip.comment.length : 0, 20)

  return Buffer.concat([...chunks, central, eocd, zip.comment || Buffer.alloc(0)])
}

/** Read one entry's uncompressed bytes, or undefined when absent. */
export function readEntry(zip, name) {
  const entry = zip.entries.find((candidate) => candidate.name === name)
  if (!entry) return undefined
  if (entry.flags & FLAG_ENCRYPTED) throw new Error('ZIP_ENTRY_ENCRYPTED')
  if (entry.method === 0) {
    return Buffer.from(zip.buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize))
  }
  if (entry.method === 8) {
    return zlib.inflateRawSync(zip.buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize))
  }
  throw new Error(`ZIP_METHOD_UNSUPPORTED:${entry.method}`)
}

/** Read one entry as UTF-8 text, or undefined when absent. */
export function readText(zip, name) {
  const bytes = readEntry(zip, name)
  return bytes === undefined ? undefined : bytes.toString('utf8')
}

/** Find an entry name case-insensitively (Office writers vary the casing). */
export function findEntryName(zip, wanted) {
  const lower = wanted.toLowerCase()
  const hit = zip.entries.find((entry) => entry.name.toLowerCase() === lower)
  return hit ? hit.name : undefined
}

/** True when any entry is encrypted, which makes rewriting unsafe. */
export function hasEncryptedEntry(zip) {
  return zip.entries.some((entry) => (entry.flags & FLAG_ENCRYPTED) !== 0)
}

/** Quick magic-byte sniff that never throws. */
export function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === SIG_LOCAL
}
