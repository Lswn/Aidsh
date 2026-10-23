/**
 * Plugin config.
 *
 * Deliberately dependency-free: the only source of configuration is the loader's
 * `config` object, and every field falls back to `DEFAULTS`. The package used to
 * declare the host's schema library to render a settings form, but third-party
 * plugins do not get a form in the current host, so the schema bought nothing
 * while forcing every install to resolve an extra package.
 *
 * `unwrap()` is kept because a host may hand over reference-wrapped values
 * (`{ get() }`) instead of plain ones; treating one as a string would silently
 * write "[object Object]" into a document.
 */

export const DEFAULTS = {
  author: '',
  lastModifiedBy: '',
  notifySkipped: true,
  allowMacro: false,
  maxBytes: 50 * 1024 * 1024,
  dryRun: false,
  pdfMode: 'metadata-only',
  debug: false,
}

/** Read a value that may be wrapped in a `{ get() }` reference. */
export function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}
