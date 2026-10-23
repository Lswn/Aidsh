/**
 * Deciding whether a tool call is about a document.
 *
 * The plugin cannot see intent, only the arguments the model handed to a tool,
 * so the rule is: walk every string in the arguments, and treat a supported or
 * rejected extension as a document mention. Extensions are matched longest
 * first so `.docx` never registers as `.doc`.
 */

import { SUPPORTED_EXTENSIONS, REJECTED_EXTENSIONS } from './adapters/index.js'

const ALL = [...SUPPORTED_EXTENSIONS, ...REJECTED_EXTENSIONS].sort((a, b) => b.length - a.length)

const EXTENSION_PATTERN = new RegExp(
  `(${ALL.map((extension) => extension.replace('.', '\\.')).join('|')})(?![a-z0-9])`,
  'gi',
)

/** Non-global twin: `.test()` on a global regex would advance `lastIndex`. */
const HAS_EXTENSION = new RegExp(EXTENSION_PATTERN.source, 'i')

const MAX_DEPTH = 6
const MAX_NODES = 4000
const MAX_STRING = 100_000

function walk(value, visit, depth = 0, budget = { nodes: 0 }) {
  if (budget.nodes > MAX_NODES) return
  budget.nodes += 1
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING) visit(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (depth >= MAX_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1, budget)
    return
  }
  for (const key of Object.keys(value)) walk(value[key], visit, depth + 1, budget)
}

/** All document extensions mentioned anywhere in the arguments. */
export function extensionsIn(argumentsValue) {
  const found = new Set()
  walk(argumentsValue, (text) => {
    const matches = text.match(EXTENSION_PATTERN)
    if (!matches) return
    for (const match of matches) found.add(match.toLowerCase())
  })
  return found
}

/** Split a mention set into the two policy buckets. */
export function classify(argumentsValue) {
  const found = extensionsIn(argumentsValue)
  const rejected = [...found].filter((extension) => REJECTED_EXTENSIONS.includes(extension))
  const supported = [...found].filter((extension) => SUPPORTED_EXTENSIONS.includes(extension))
  return { extensions: found, rejected, supported }
}

/**
 * Tools that name their target explicitly. Their *content* is prose or code,
 * and prose may well mention a legacy document name; only the target path
 * decides whether a document is being produced. Without this, writing a README
 * that documents the refused formats would itself be refused.
 */
const PATH_SCOPED_TOOL = /^(write|edit|multi_edit|str_replace_editor|str_replace|create_file|apply_patch)$/i

const PATH_KEY = /^(path|file_path|filepath|target|target_file|filename|file|output|out)$/i

/** Just the path-bearing fields of a tool call, for path-scoped tools. */
function pathArguments(value, depth = 0, budget = { nodes: 0 }) {
  if (value === null || typeof value !== 'object' || depth > 4 || budget.nodes > 500) return {}
  budget.nodes += 1
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && PATH_KEY.test(key)) result[key] = child
    else if (child && typeof child === 'object') {
      const nested = pathArguments(child, depth + 1, budget)
      for (const [nestedKey, nestedValue] of Object.entries(nested)) result[nestedKey] = nestedValue
    }
  }
  return result
}

/** The arguments a policy decision should look at for a given tool. */
export function scopedArguments(toolName, argumentsValue) {
  return PATH_SCOPED_TOOL.test(String(toolName ?? '')) ? pathArguments(argumentsValue) : argumentsValue
}

/**
 * Absolute-looking document paths mentioned in a tool call. Used after the call
 * succeeds, to find the file that was just written.
 *
 * Quoted strings are considered whole: a name with a space is one path, not the
 * tail token that an unquoted scan would produce.
 */
export function pathsIn(argumentsValue, resolve) {
  const found = new Set()
  const quotedPaths = []

  const consider = (candidate) => {
    const cleaned = candidate.replace(/^[('"`]+/, '').replace(/[)'"`,;]+$/, '')
    if (!cleaned) return
    const absolute = resolve(cleaned)
    if (absolute) found.add(absolute)
  }

  walk(argumentsValue, (text) => {
    for (const match of text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
      const inner = match[1].trim()
      if (HAS_EXTENSION.test(inner)) quotedPaths.push(inner)
    }
    for (const quoted of quotedPaths) consider(quoted)

    for (const match of text.matchAll(new RegExp(EXTENSION_PATTERN.source, 'gi'))) {
      const end = match.index + match[0].length
      let start = match.index
      while (start > 0 && !/[\s"'`<>,;|]/.test(text[start - 1])) start -= 1
      const token = text.slice(start, end)
      // A tail of an already-captured quoted path is not a second file.
      if (quotedPaths.some((quoted) => quoted.endsWith(token))) continue
      consider(token)
    }
  })
  return found
}
