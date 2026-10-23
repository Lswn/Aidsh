/**
 * EPUB adapter.
 *
 * The package document (OPF) is located through `META-INF/container.xml`, then
 * `dc:creator`, `dc:date` and the EPUB 3 `dcterms:modified` meta are rewritten.
 * The last one is mandatory in EPUB 3 and readers reject packages where it does
 * not match the actual modification, so it moves together with the date.
 */

import { readZip, writeZip, readText, findEntryName } from '../zip.js'
import { SkipError } from '../errors.js'
import { escapeXml, stripControls, setElementText, setPropertyMeta } from '../xml.js'
import { toW3cdtf } from '../time.js'

export const id = 'epub'
export const extensions = ['.epub']

const CONTAINER = 'META-INF/container.xml'
const DC = 'xmlns:dc="http://purl.org/dc/elements/1.1/"'

export function findOpfPath(containerXml) {
  const match =
    /<rootfile\b[^>]*full-path\s*=\s*"([^"]+)"/i.exec(containerXml) ||
    /<rootfile\b[^>]*full-path\s*=\s*'([^']+)'/i.exec(containerXml)
  return match ? match[1] : undefined
}

export function rewriteOpf(xml, meta) {
  const author = escapeXml(stripControls(meta.author))
  const modified = toW3cdtf(meta.modified)
  let next = xml

  next = setElementText(next, 'dc:creator', author, 'metadata', DC)
  if (next === null) return null

  const dated = setElementText(next, 'dc:date', modified, 'metadata', DC)
  if (dated === null) return null
  next = dated

  const withMeta = setPropertyMeta(next, 'dcterms:modified', modified, 'metadata')
  if (withMeta === null) return null
  return withMeta
}

export function stamp(buffer, meta) {
  const zip = readZip(buffer)
  const containerName = findEntryName(zip, CONTAINER)
  if (!containerName) throw new SkipError('缺少 META-INF/container.xml，可能不是标准 EPUB')

  const opfPath = findOpfPath(readText(zip, containerName))
  if (!opfPath) throw new SkipError('无法定位 OPF 包文档')

  const opfName = findEntryName(zip, opfPath)
  if (!opfName) throw new SkipError(`OPF 文件不存在: ${opfPath}`)

  const rewritten = rewriteOpf(readText(zip, opfName), meta)
  if (rewritten === null) throw new SkipError('OPF 结构无法识别')

  const replacements = new Map([[opfName, Buffer.from(rewritten, 'utf8')]])
  return { buffer: writeZip(zip, replacements), format: 'epub' }
}
