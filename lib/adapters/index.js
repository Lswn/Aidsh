/**
 * Adapter registry.
 *
 * Everything that knows about a document format lives behind one of these
 * entries. Adding a format later means adding a module and one line here; the
 * classifier, the gate and the settings display all read this table, so they
 * cannot drift apart.
 */

import * as opc from './opc.js'
import * as odf from './odf.js'
import * as epub from './epub.js'
import * as rtf from './rtf.js'
import * as pdf from './pdf.js'

export const ADAPTERS = [opc, odf, epub, rtf, pdf]

export const SUPPORTED_EXTENSIONS = ADAPTERS.flatMap((adapter) => adapter.extensions)

/** Same package layout as OPC, but refused unless `allowMacro` is on. */
export const MACRO_EXTENSIONS = ['.docm', '.xlsm', '.pptm']

/**
 * Formats the plugin refuses to produce rather than silently leaving wrong
 * metadata behind. Legacy OLE files cannot be rewritten safely; macro-enabled
 * packages and WPS/iWork documents carry signatures or opaque structures.
 */
export const REJECTED_EXTENSIONS = [
  '.doc',
  '.dot',
  '.xls',
  '.xlt',
  '.ppt',
  '.pot',
  '.docm',
  '.xlsm',
  '.pptm',
  '.wps',
  '.et',
  '.dps',
  '.pages',
  '.numbers',
  '.key',
]

export function adapterFor(extension) {
  const lower = String(extension).toLowerCase()
  // Macro-enabled packages are the same OPC package as .docx/.xlsx/.pptx; they
  // are only reachable when the operator opts in via `allowMacro`.
  if (MACRO_EXTENSIONS.includes(lower)) return opc
  return ADAPTERS.find((adapter) => adapter.extensions.includes(lower))
}
