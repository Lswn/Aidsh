/**
 * dsh-office-meta-stamp — plugin entry.
 *
 * Three touch points, nothing else:
 *   tools/pre-execute   refuse formats we cannot rewrite (once with a hint)
 *   tools/post-execute  normalise documents the call just produced
 *   a debounced sweep   catch outputs whose names never appear in the arguments
 *
 * Every handler is wrapped so a bug here can never fail a tool call.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

import { DEFAULTS, unwrap } from './config.js'
import { classify, pathsIn, scopedArguments } from './classify.js'
import { stampFile } from './normalize.js'
import { isSkip } from './errors.js'
import { SUPPORTED_EXTENSIONS } from './adapters/index.js'
import { debug } from './debug.js'

export const name = 'office-meta-stamp'
export const inject = ['tools']

const ENTRY_ID = 'office-meta-stamp'
const SWEEP_DELAY_MS = 1500
const SWEEP_WINDOW_MS = 20_000
const SWEEP_MAX_FILES = 400
const SWEEP_SKIP_DIRS = /^(node_modules|\.git|\.hg|dist|build|out|coverage|\.cache)$/i

/**
 * Tools that never produce a document. Without this guard, reading somebody
 * else's file would rewrite that file's author — the plugin must only touch
 * files that were just generated.
 */
const READ_ONLY_TOOL = /^(read|read_file|read_text|glob|grep|list|list_dir|ls|search|find|view|open|present|web_fetch|web_search|fetch)$/i

/** A document is only "just generated" for this long. */
const RECENT_WINDOW_MS = 10 * 60 * 1000

const SUGGESTION = {
  '.doc': '.docx',
  '.dot': '.docx',
  '.docm': '.docx',
  '.xls': '.xlsx',
  '.xlt': '.xlsx',
  '.xlsm': '.xlsx',
  '.ppt': '.pptx',
  '.pot': '.pptx',
  '.pptm': '.pptx',
  '.wps': '.docx',
  '.et': '.xlsx',
  '.dps': '.pptx',
  '.pages': '.docx',
  '.numbers': '.xlsx',
  '.key': '.pptx',
}

/** The local account name, minus any `DOMAIN\` or `HOST/` prefix. */
export function systemUserName() {
  try {
    const user = os.userInfo().username || ''
    return user.replace(/^[^\\/]+[\\/]/, '').trim()
  } catch {
    return ''
  }
}

function logOf(ctx) {
  const logger = ctx?.logger
  return {
    info: (message) => logger?.info?.(message),
    warn: (message) => logger?.warn?.(message),
  }
}

async function persistAuthor(ctx, author) {
  try {
    if (typeof ctx?.settings?.update === 'function') {
      await ctx.settings.update(ENTRY_ID, { author }, undefined)
      return true
    }
  } catch {
    // No settings service, no profile entry, or a rejected revision: the
    // in-memory value still works for this session.
  }
  return false
}

function sessionKey(exec) {
  return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? 'global')
}

function collectWorkingDirs(value, into, depth = 0, budget = { nodes: 0 }) {
  if (!value || typeof value !== 'object' || depth > 4 || budget.nodes > 500) return
  budget.nodes += 1
  if (Array.isArray(value)) {
    for (const item of value) collectWorkingDirs(item, into, depth + 1, budget)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /^(cwd|workdir|working_directory|directory|dir)$/i.test(key)) {
      try {
        if (fs.statSync(child).isDirectory()) into.add(path.resolve(child))
      } catch {
        // A path that does not exist yet cannot be swept.
      }
      continue
    }
    collectWorkingDirs(child, into, depth + 1, budget)
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig || {}
  const state = {
    author: String(unwrap(config.author) || '').trim(),
    hinted: new Set(),
    dirs: new Set(),
    timer: undefined,
  }

  if (!state.author) {
    const fallback = systemUserName()
    if (fallback) {
      state.author = fallback
      void persistAuthor(ctx, fallback)
    }
  }

  const logger = logOf(ctx)
  const trace = (event, data) => debug(Boolean(unwrap(config.debug)), event, data)
  trace('boot', { author: state.author, keys: Object.keys(config) })

  const current = () => ({
    author: String(unwrap(config.author) || '').trim() || state.author,
    lastModifiedBy: String(unwrap(config.lastModifiedBy) || '').trim() || undefined,
    notifySkipped: unwrap(config.notifySkipped) ?? DEFAULTS.notifySkipped,
    allowMacro: Boolean(unwrap(config.allowMacro)),
    maxBytes: Number(unwrap(config.maxBytes)) > 0 ? Number(unwrap(config.maxBytes)) : DEFAULTS.maxBytes,
    dryRun: Boolean(unwrap(config.dryRun)),
    pdfEnabled: String(unwrap(config.pdfMode) ?? DEFAULTS.pdfMode) !== 'off',
  })

  async function stampOne(file) {
    const settings = current()
    if (!settings.pdfEnabled && path.extname(file).toLowerCase() === '.pdf') return
    if (settings.dryRun) {
      logger.info(`[office-meta-stamp] dryRun: would stamp ${file}`)
      return
    }
    try {
      const result = await stampFile(
        file,
        { author: settings.author, lastModifiedBy: settings.lastModifiedBy },
        { maxBytes: settings.maxBytes },
      )
      trace('stamp', { file, changed: result.changed, reason: result.reason })
      if (result.changed) logger.info(`[office-meta-stamp] stamped ${path.basename(file)}`)
    } catch (error) {
      if (isSkip(error)) {
        trace('skip', { file, reason: error.reason })
        if (settings.notifySkipped) {
          logger.warn(`[office-meta-stamp] skipped ${path.basename(file)}: ${error.reason}`)
        }
        return
      }
      trace('fail', { file, message: String(error?.message ?? error) })
      logger.warn(`[office-meta-stamp] failed ${path.basename(file)}: ${error?.message ?? error}`)
    }
  }

  async function walk(directory, depth, cutoff, seen) {
    if (seen.size >= SWEEP_MAX_FILES) return
    let entries
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (seen.size >= SWEEP_MAX_FILES) return
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth <= 0 || SWEEP_SKIP_DIRS.test(entry.name)) continue
        await walk(full, depth - 1, cutoff, seen)
        continue
      }
      if (!entry.isFile()) continue
      if (!SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue
      let stat
      try {
        stat = await fsp.stat(full)
      } catch {
        continue
      }
      if (stat.mtimeMs < cutoff) continue
      seen.add(full)
      await stampOne(full)
    }
  }

  function scheduleSweep() {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      const cutoff = Date.now() - SWEEP_WINDOW_MS
      const seen = new Set()
      void (async () => {
        for (const directory of state.dirs) await walk(directory, 2, cutoff, seen)
      })().catch(() => {})
    }, SWEEP_DELAY_MS)
    state.timer.unref?.()
  }

  async function afterTool(exec) {
    if (READ_ONLY_TOOL.test(String(exec?.name ?? ''))) return

    const dirs = new Set(state.dirs)
    const scoped = scopedArguments(exec?.name, exec?.arguments)
    collectWorkingDirs(scoped, dirs)

    const resolve = (candidate) => {
      const cleaned = String(candidate).replace(/^['"`(]+|['"`),]+$/g, '')
      if (!cleaned) return undefined
      const attempts = []
      if (path.isAbsolute(cleaned)) attempts.push(cleaned)
      for (const directory of dirs) attempts.push(path.resolve(directory, cleaned))
      attempts.push(path.resolve(process.cwd(), cleaned))
      for (const attempt of attempts) {
        try {
          if (fs.statSync(attempt).isFile()) return attempt
        } catch {
          // keep looking
        }
      }
      return undefined
    }

    const files = pathsIn(scoped, resolve)
    trace('paths', { tool: String(exec?.name ?? ''), found: files.size, dirs: dirs.size })
    const now = Date.now()
    for (const file of files) {
      dirs.add(path.dirname(file))
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      // Only freshly generated files are in scope; an old document mentioned in
      // the arguments must keep its original author.
      if (now - stat.mtimeMs > RECENT_WINDOW_MS) continue
      await stampOne(file)
    }

    if (dirs.size === 0) return
    state.dirs = dirs
    scheduleSweep()
  }

  const register = (event, handler) => {
    try {
      ctx.on(event, handler)
      return true
    } catch (error) {
      trace('register-failed', { event, message: String(error?.message ?? error) })
      logger.warn(`[office-meta-stamp] cannot register ${event}: ${error?.message ?? error}`)
      return false
    }
  }

  register('tools/pre-execute', async (exec, next) => {
    try {
      const settings = current()
      const { rejected } = classify(scopedArguments(exec?.name, exec?.arguments))
      if (rejected.length === 0) return next()

      const extension = rejected[0]
      // A macro-enabled package is a ZIP we could technically edit, but doing so
      // breaks its signature; the operator has to opt in explicitly.
      if (settings.allowMacro !== true) {
        const key = `${sessionKey(exec)}:${extension}`
        const first = !state.hinted.has(key)
        state.hinted.add(key)
        const reason = first
          ? `无法改写 ${extension} 的属性。请改用 ${SUGGESTION[extension] || '.docx'} 输出。`
          : `无法改写 ${extension} 的属性，该格式不支持。`
        return { kind: 'deny', reason }
      }
      return next()
    } catch (error) {
      logger.warn(`[office-meta-stamp] gate error: ${error?.message ?? error}`)
      return next()
    }
  })

  register('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      trace('post', { tool: String(exec?.name ?? ''), author: current().author })
      if (!current().author) return decision
      await afterTool(exec)
    } catch (error) {
      trace('post-failed', { message: String(error?.message ?? error) })
      logger.warn(`[office-meta-stamp] post-execute error: ${error?.message ?? error}`)
    }
    return decision
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (state.timer) clearTimeout(state.timer)
    })
  }
}
