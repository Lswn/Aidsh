/**
 * Opt-in diagnostics.
 *
 * The host has no visible stdout for a packaged app, so when something does not
 * behave the way it should there is nowhere to look. With `debug: true` the
 * plugin appends one JSON line per decision to a file in the OS temp directory.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEBUG_FILE = path.join(os.tmpdir(), 'office-meta-stamp-debug.log')

export function debug(enabled, event, data = {}) {
  if (!enabled) return
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data })
    fs.appendFileSync(DEBUG_FILE, `${line}\n`)
  } catch {
    // Diagnostics must never affect behaviour.
  }
}
