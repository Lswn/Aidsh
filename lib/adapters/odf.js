/**
 * ODF adapter: .odt / .ods / .odp.
 *
 * OpenDocument packages are ZIP archives too, but the author lives in
 * `meta.xml` under different names than OOXML. Signed or encrypted packages are
 * refused: rewriting a signed part would invalidate the signature, and an
 * encrypted package cannot be edited at all.
 */

import { readZip, writeZip, readText, findEntryName, hasEncryptedEntry } from '../zip.js'
import { SkipError } from '../errors.js'
import { escapeXml, stripControls, setElementText } from '../xml.js'
import { toOdfDate } from '../time.js'

export const id = 'odf'
export const extensions = ['.odt', '.ods', '.odp']

const META = 'meta.xml'
const MANIFEST = 'META-INF/manifest.xml'
const SIGNATURES = 'META-INF/documentsignatures.xml'

const DC = 'xmlns:dc="http://purl.org/dc/elements/1.1/"'
const META_NS = 'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"'

export function rewriteMeta(xml, meta) {
  const author = escapeXml(stripControls(meta.author))
  const created = toOdfDate(meta.created)
  const modified = toOdfDate(meta.modified)
  let next = xml

  next = setElementText(next, 'meta:initial-creator', author, 'office:meta', META_NS)
  if (next === null) return null
  next = setElementText(next, 'dc:creator', author, 'office:meta', DC)
  if (next === null) return null
  next = setElementText(next, 'meta:creation-date', created, 'office:meta', META_NS)
  if (next === null) return null
  next = setElementText(next, 'dc:date', modified, 'office:meta', DC)
  if (next === null) return null
  next = setElementText(next, 'meta:editing-cycles', '1', 'office:meta', META_NS)
  return next
}

export function stamp(buffer, meta) {
  const zip = readZip(buffer)
  if (hasEncryptedEntry(zip)) throw new SkipError('文件已加密，无法改写属性')

  if (findEntryName(zip, SIGNATURES)) throw new SkipError('文件带有数字签名，改写会使其失效')

  const manifestName = findEntryName(zip, MANIFEST)
  if (manifestName) {
    const manifest = readText(zip, manifestName)
    if (/encryption-data/i.test(manifest)) throw new SkipError('文件已加密，无法改写属性')
  }

  const metaName = findEntryName(zip, META)
  if (!metaName) throw new SkipError('缺少 meta.xml，可能不是标准 ODF 文件')

  const rewritten = rewriteMeta(readText(zip, metaName), meta)
  if (rewritten === null) throw new SkipError('meta.xml 结构无法识别')

  const replacements = new Map([[metaName, Buffer.from(rewritten, 'utf8')]])
  return { buffer: writeZip(zip, replacements), format: 'odf' }
}
