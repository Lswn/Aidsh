/**
 * Minimal XML editing helpers.
 *
 * Metadata parts are small, well-known documents. This module rewrites single
 * elements in place instead of parsing and re-serializing, so everything we do
 * not own (titles, keywords, unknown extensions, namespace declarations,
 * attribute order) survives byte for byte.
 *
 * Attribute preservation is not a nicety: openpyxl declares `xmlns:dc` *on the
 * `dc:creator` element* rather than on the root, so replacing that element
 * without keeping its attributes produces an unparseable part.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ENTITIES[character])
}

/** Remove characters XML 1.0 cannot represent, so a pasted name cannot corrupt the part. */
export function stripControls(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches one element, either self-closing or with content, attributes allowed. */
function elementPattern(tag) {
  const name = escapeRegex(tag)
  return new RegExp(`<${name}(?:\\s[^>]*)?/>|<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, 'i')
}

/**
 * Replace an element's text while keeping its attributes, or insert a new
 * element before `closeTag` when it is absent.
 *
 * `attributes` is only used for insertion, and must carry the namespace
 * declarations the element needs to be valid where the root does not declare
 * them.
 */
export function setElementText(xml, tag, text, closeTag, attributes = '') {
  const pattern = elementPattern(tag)
  const match = pattern.exec(xml)
  if (match) {
    const raw = match[0]
    const open = new RegExp(`^<${escapeRegex(tag)}((?:\\s[^>]*?)?)/?>`, 'i').exec(raw)
    const kept = (open?.[1] || '').trim()
    const opening = kept ? `<${tag} ${kept}>` : `<${tag}>`
    return xml.replace(pattern, () => `${opening}${text}</${tag}>`)
  }
  if (!closeTag) return null
  const close = `</${closeTag}>`
  const at = xml.lastIndexOf(close)
  if (at < 0) return null
  const opening = attributes ? `<${tag} ${attributes}>` : `<${tag}>`
  return `${xml.slice(0, at)}${opening}${text}</${tag}>${xml.slice(at)}`
}

/** Remove every occurrence of `tag`. */
export function removeElement(xml, tag) {
  return xml.replace(new RegExp(elementPattern(tag).source, 'gi'), '')
}

/** Replace a `<meta ... property="x">` element regardless of attribute order. */
export function setPropertyMeta(xml, property, text, closeTag) {
  const pattern = new RegExp(`<meta\\b[^>]*property\\s*=\\s*"${escapeRegex(property)}"[^>]*>[\\s\\S]*?</meta>`, 'i')
  if (pattern.test(xml)) return xml.replace(pattern, () => `<meta property="${property}">${text}</meta>`)
  const close = `</${closeTag}>`
  const at = xml.lastIndexOf(close)
  if (at < 0) return null
  return `${xml.slice(0, at)}<meta property="${property}">${text}</meta>${xml.slice(at)}`
}
