/**
 * Timestamp formatting for each metadata dialect.
 *
 * The value always comes from the file's own timestamps, never from the wall
 * clock: a document generated seconds ago already carries the right date, and
 * inventing a different one would be both wrong and pointless.
 */

function pad(value) {
  return String(value).padStart(2, '0')
}

/** `2026-10-23T11:00:00Z` — the W3CDTF form OOXML stores. */
export function toW3cdtf(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
}

/** `2026-10-23T19:00:00` — ODF's local form, no zone suffix. */
export function toOdfDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `D:20261023190000+08'00'` — the PDF date literal. */
export function toPdfDate(date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}'${pad(
    absolute % 60,
  )}'`
}

/** RTF's `\yr \mo \dy \hr \min \sec` control-word set. */
export function toRtfDate(date) {
  return [
    `\\yr${date.getFullYear()}`,
    `\\mo${date.getMonth() + 1}`,
    `\\dy${date.getDate()}`,
    `\\hr${date.getHours()}`,
    `\\min${date.getMinutes()}`,
    `\\sec${date.getSeconds()}`,
  ].join('')
}
