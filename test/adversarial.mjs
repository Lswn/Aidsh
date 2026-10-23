#!/usr/bin/env node
/**
 * Adversarial tests: the cases that are easy to get wrong and that the happy
 * path never touches. These exist because several real bugs were found here
 * (see README §10).
 *
 *   node test/adversarial.mjs
 */

import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { crc32, readZip, readEntry, readText } from '../lib/zip.js'
import { normalizeBuffer } from '../lib/normalize.js'
import { SkipError } from '../lib/errors.js'
import { pathsIn } from '../lib/classify.js'
import { rewriteRtf } from '../lib/adapters/rtf.js'
import { apply as applyPlugin } from '../lib/index.js'

let passed = 0
let failed = 0
const queue = []
const test = (name, body) => queue.push([name, body])

const META = {
  author: '张三',
  lastModifiedBy: '张三',
  created: new Date('2026-10-23T11:00:00Z'),
  modified: new Date('2026-10-23T11:05:00Z'),
}

// ---------------------------------------------------------------- helpers

/** ZIP writer with knobs for the awkward cases: data descriptors, comments, store. */
function buildZip(files, options = {}) {
  const chunks = []
  const central = []
  let offset = 0
  let counter = 0

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const useStore = options.store === true
    const compressed = useStore ? data : zlib.deflateRawSync(data)
    const nameBuffer = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const flags = 0x0800 | (options.dataDescriptor ? 0x0008 : 0)
    const extraField = options.extra === 'ut'
      ? Buffer.concat([
          Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
        ])
      : Buffer.alloc(0)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(useStore ? 0 : 8, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0x21, 12)
    if (options.dataDescriptor) {
      header.writeUInt32LE(0, 14)
      header.writeUInt32LE(0, 18)
      header.writeUInt32LE(0, 22)
    } else {
      header.writeUInt32LE(crc, 14)
      header.writeUInt32LE(compressed.length, 18)
      header.writeUInt32LE(data.length, 22)
    }
    header.writeUInt16LE(nameBuffer.length, 26)
    header.writeUInt16LE(extraField.length, 28)

    chunks.push(header, nameBuffer, extraField, compressed)
    let localSize = 30 + nameBuffer.length + extraField.length + compressed.length

    if (options.dataDescriptor) {
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(compressed.length, 8)
      descriptor.writeUInt32LE(data.length, 12)
      chunks.push(descriptor)
      localSize += 16
    }

    central.push({
      name,
      nameBuffer,
      extraField,
      crc,
      compressedLength: compressed.length,
      size: data.length,
      offset,
      flags,
      method: useStore ? 0 : 8,
    })
    offset += localSize
    counter += 1
  }

  const directory = []
  for (const entry of central) {
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(0x031e, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(entry.flags, 8)
    record.writeUInt16LE(entry.method, 10)
    record.writeUInt16LE(0, 12)
    record.writeUInt16LE(0x21, 14)
    record.writeUInt32LE(entry.crc, 16)
    record.writeUInt32LE(entry.compressedLength, 20)
    record.writeUInt32LE(entry.size, 24)
    record.writeUInt16LE(entry.nameBuffer.length, 28)
    record.writeUInt16LE(entry.extraField.length, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(entry.offset, 42)
    directory.push(record, entry.nameBuffer, entry.extraField)
  }
  const centralBuffer = Buffer.concat(directory)
  const comment = options.comment ? Buffer.from(options.comment) : Buffer.alloc(0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(counter, 8)
  end.writeUInt16LE(counter, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...chunks, centralBuffer, end, comment])
}

const CORE = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>T</dc:title><dc:creator>gen</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2013-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2013-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`

function docx(extra = {}, options = {}) {
  return buildZip({ 'docProps/core.xml': CORE, 'word/document.xml': '<x/>', ...extra }, options)
}

/** A minimal PDF whose cross-reference section is a stream (PDF 1.5 style). */
function buildPdfWithXrefStream() {
  const head = []
  let text = '%PDF-1.5\n'
  const offsets = [0]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
  ]
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(text.length)
    text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefNumber = 4
  const xrefOffset = text.length
  offsets.push(xrefOffset)

  const entries = Buffer.alloc(7 * 5)
  // object 0: free
  entries[0] = 0
  entries.writeUInt32BE(0, 1)
  entries.writeUInt16BE(0xffff, 5)
  for (let i = 1; i <= 4; i += 1) {
    const base = i * 7
    entries[base] = 1
    entries.writeUInt32BE(offsets[i], base + 1)
    entries.writeUInt16BE(0, base + 5)
  }

  text += `${xrefNumber} 0 obj\n<< /Type /XRef /Size 5 /W [1 4 2] /Root 1 0 R /Length ${entries.length} >>\nstream\n`
  head.push(Buffer.from(text, 'latin1'))
  head.push(entries)
  head.push(Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'))
  return { buffer: Buffer.concat(head), xrefOffset, infoNumber: 5, streamNumber: 6 }
}

// ---------------------------------------------------------------- tests

console.log('zip edge cases')

test('data descriptor entries survive an unrelated rewrite', () => {
  const zip = docx({}, { dataDescriptor: true })
  const before = readZip(zip)
  const result = normalizeBuffer(zip, '.docx', META)
  const after = readZip(result.buffer)
  assert.equal(after.entries.length, before.entries.length)
  assert.equal(after.entries[0].flags & 0x0008, 0, 'rewritten entry drops the descriptor flag')
})

test('archive comment is preserved', () => {
  const zip = docx({}, { comment: 'built by fixture' })
  const result = normalizeBuffer(zip, '.docx', META)
  assert.equal(readZip(result.buffer).comment.toString(), 'built by fixture')
})

test('stored (uncompressed) entries survive', () => {
  const zip = docx({}, { store: true })
  const result = normalizeBuffer(zip, '.docx', META)
  assert.equal(readEntry(readZip(result.buffer), 'word/document.xml').toString(), '<x/>')
})

test('1 MiB entry round-trips', () => {
  const big = 'A'.repeat(1024 * 1024)
  const zip = docx({ 'word/big.xml': big })
  const result = normalizeBuffer(zip, '.docx', META)
  assert.equal(readEntry(readZip(result.buffer), 'word/big.xml').length, big.length)
})

test('central-directory extra fields survive on untouched entries', () => {
  const zip = buildZip({ 'docProps/core.xml': CORE, 'word/document.xml': '<x/>' }, { extra: 'ut' })
  const before = readZip(zip).entries.find((entry) => entry.name === 'word/document.xml')
  const result = normalizeBuffer(zip, '.docx', META)
  const after = readZip(result.buffer).entries.find((entry) => entry.name === 'word/document.xml')
  assert.deepEqual(after.extra, before.extra)
  assert.ok(after.extra.length > 0)
})

test('a BOM in core.xml does not hide the elements', () => {
  const zip = buildZip({ 'docProps/core.xml': `\uFEFF${CORE}`, 'word/document.xml': '<x/>' })
  const result = normalizeBuffer(zip, '.docx', META)
  assert.match(readText(readZip(result.buffer), 'docProps/core.xml'), /<dc:creator>张三<\/dc:creator>/)
})

test('a .docx with non-ASCII part names keeps them', () => {
  const zip = buildZip({ 'docProps/core.xml': CORE, 'word/媒体/图片1.xml': '<x/>' })
  const result = normalizeBuffer(zip, '.docx', META)
  const after = readZip(result.buffer)
  assert.ok(after.entries.some((entry) => entry.name === 'word/媒体/图片1.xml'))
  assert.equal(readEntry(after, 'word/媒体/图片1.xml').toString(), '<x/>')
})

test('a zero-byte file is skipped', () => {
  assert.throws(() => normalizeBuffer(Buffer.alloc(0), '.docx', META), SkipError)
})

test('EPUB without dc:creator gets one, with a namespace declaration', () => {
  const zip = buildZip({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    'c.opf': '<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest/></package>',
  })
  const result = normalizeBuffer(zip, '.epub', META)
  const opf = readText(readZip(result.buffer), 'c.opf')
  assert.match(opf, /<dc:creator xmlns:dc="[^"]*">张三<\/dc:creator>/)
  assert.match(opf, /<dc:title>T<\/dc:title>/, 'existing metadata survives')
})

test('PDF author with parentheses round-trips through the idempotency check', () => {
  const first = normalizeBuffer(buildPdfWithXrefStream().buffer, '.pdf', { ...META, author: 'A(B)\\C' })
  const second = normalizeBuffer(first.buffer, '.pdf', { ...META, author: 'A(B)\\C' })
  assert.equal(second.changed, false)
})
test('astral characters survive docx, rtf and pdf', () => {
  const author = '张三😀'
  const doc = normalizeBuffer(docx(), '.docx', { ...META, author })
  assert.match(readText(readZip(doc.buffer), 'docProps/core.xml'), /张三😀/)

  const rtf = normalizeBuffer(Buffer.from('{\\rtf1\\ansi{\\info{\\author x}}}', 'latin1'), '.rtf', {
    ...META,
    author,
  })
  assert.match(rtf.buffer.toString('latin1'), /\\u-10179\?\\u-8704\?/, 'surrogate pair encoded')

  const pdf = normalizeBuffer(buildPdfWithXrefStream().buffer, '.pdf', { ...META, author })
  assert.match(pdf.buffer.toString('latin1'), /<FEFF5F204E09D83DDE00>/, 'utf-16be hex string')
})

console.log('author already correct')

test('a document already signed with the configured name is left untouched', () => {
  const mine = CORE.replace('>gen<', '>张三<')
  const zip = buildZip({ 'docProps/core.xml': mine, 'word/document.xml': '<x/>' })
  const before = readZip(zip)
  const result = normalizeBuffer(zip, '.docx', META)
  assert.equal(result.changed, false)
  assert.equal(result.reason, '作者已是目标值')
  assert.ok(result.buffer.equals(zip), 'byte-for-byte untouched, ancient template date included')
  assert.deepEqual(readZip(result.buffer).entries.length, before.entries.length)
})

test('a PDF already signed with the configured name is not re-appended', () => {
  const first = normalizeBuffer(buildPdfWithXrefStream().buffer, '.pdf', META)
  const second = normalizeBuffer(first.buffer, '.pdf', {
    ...META,
    created: new Date('2020-01-01T00:00:00Z'),
    modified: new Date('2020-01-01T00:00:00Z'),
  })
  assert.equal(second.changed, false)
  assert.equal(second.buffer.length, first.buffer.length)
})

test('an RTF already signed with the configured name is left untouched', () => {
  const source = '{\\rtf1\\ansi{\\info{\\author \\u24352?\\u19977?;}}{\\pard hi}}'
  const result = normalizeBuffer(Buffer.from(source, 'latin1'), '.rtf', META)
  assert.equal(result.changed, false)
  assert.equal(result.buffer.toString('latin1'), source)
})

console.log('xml escaping')

test('author with XML metacharacters is escaped, not injected', () => {
  const zip = docx()
  const result = normalizeBuffer(zip, '.docx', { ...META, author: 'A&B<C>"D"' })
  const core = readText(readZip(result.buffer), 'docProps/core.xml')
  assert.match(core, /<dc:creator>A&amp;B&lt;C&gt;&quot;D&quot;<\/dc:creator>/)
})

test('control characters are stripped instead of corrupting the part', () => {
  const zip = docx()
  const result = normalizeBuffer(zip, '.docx', { ...META, author: `A\u0001B` })
  const core = readText(readZip(result.buffer), 'docProps/core.xml')
  assert.match(core, /<dc:creator>AB<\/dc:creator>/)
})

console.log('rtf edge cases')

test('escaped braces in the body do not break group scanning', () => {
  const source = '{\\rtf1\\ansi {\\info{\\author Old}}\\pard a \\{ b \\} c}'
  const out = rewriteRtf(source, META)
  assert.ok(out.includes('a \\{ b \\} c'), 'body escapes preserved')
  assert.ok(out.includes('\\u24352?'), 'author replaced')
})

test('author with braces and backslashes is escaped', () => {
  const out = rewriteRtf('{\\rtf1\\ansi{\\info{\\author x}}}', { ...META, author: 'a{b}\\c' })
  assert.ok(out.includes('a\\{b\\}\\\\c'), `got: ${out}`)
})

test('rtf without info group gets one after the header', () => {
  const out = rewriteRtf('{\\rtf1\\ansi\\deff0 Hello}', META)
  assert.match(out, /^\{\\rtf1\{\\info\{\\author /)
})

console.log('pdf')

test('xref-stream PDFs get a matching xref-stream update', () => {
  const fixture = buildPdfWithXrefStream()
  const result = normalizeBuffer(fixture.buffer, '.pdf', META)
  const text = result.buffer.toString('latin1')
  assert.equal(result.mode, 'stream')
  assert.ok(result.buffer.subarray(0, fixture.buffer.length).equals(fixture.buffer))
  assert.match(text, new RegExp(`/Index \\[${fixture.infoNumber} 2\\]`))
  assert.match(text, new RegExp(`/Prev ${fixture.xrefOffset}`))
  assert.match(text, new RegExp(`/Info ${fixture.infoNumber} 0 R`))
  assert.match(text, /\/Type \/XRef/)
})

test('existing /Info entries are preserved', () => {
  const base = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n'
  const info = '3 0 obj\n<< /Title (Report) /Producer (Generator X) /Author (Old) >>\nendobj\n'
  let text = base + info
  const xrefOffset = text.length
  text += 'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n'
  text += `trailer\n<< /Size 4 /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  const result = normalizeBuffer(Buffer.from(text, 'latin1'), '.pdf', META)
  const out = result.buffer.toString('latin1')
  assert.match(out, /\/Title \(Report\)/)
  assert.match(out, /\/Producer \(Generator X\)/)
  assert.match(out, /\/Author <FEFF/)
})

test('pdf is idempotent: a second pass appends nothing', () => {
  const first = normalizeBuffer(buildPdfWithXrefStream().buffer, '.pdf', META)
  const second = normalizeBuffer(first.buffer, '.pdf', META)
  assert.equal(second.changed, false)
  assert.equal(second.buffer.length, first.buffer.length)
})

test('encrypted PDFs are skipped, not edited', () => {
  const text =
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 9 0 R >>\nstartxref\n9\n%%EOF\n'
  assert.throws(() => normalizeBuffer(Buffer.from(text, 'latin1'), '.pdf', META), SkipError)
})

test('hybrid-reference PDFs are skipped', () => {
  const text =
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /XRefStm 8 >>\nstartxref\n9\n%%EOF\n'
  assert.throws(() => normalizeBuffer(Buffer.from(text, 'latin1'), '.pdf', META), SkipError)
})

console.log('policy')

test('a .docx that is really an OLE container is skipped', () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)])
  assert.throws(() => normalizeBuffer(ole, '.docx', META), SkipError)
})

test('a signed ODF package is skipped', () => {
  const zip = buildZip({
    'meta.xml': '<office:document-meta xmlns:office="x"><office:meta/></office:document-meta>',
    'META-INF/documentsignatures.xml': '<signatures/>',
  })
  assert.throws(() => normalizeBuffer(zip, '.odt', META), SkipError)
})

test('an unrecognised zip is skipped instead of guessed at', () => {
  const zip = buildZip({ 'readme.txt': 'hello' })
  assert.throws(() => normalizeBuffer(zip, '.docx', META), SkipError)
})

test('uppercase extensions still match the adapter', () => {
  const result = normalizeBuffer(docx(), '.DOCX', META)
  assert.equal(result.changed, true)
})

console.log('plugin scope')

test('the gate ignores document names written inside prose or code', async () => {
  const handlers = host({ author: '张三' })
  const gate = handlers.get('tools/pre-execute')

  const prose = await gate(
    {
      name: 'write',
      arguments: { path: 'notes.md', content: 'never use .doc or .xls here' },
      agent: { session: { id: 'g1' } },
    },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(prose.kind, 'allow', 'a mention inside a markdown file is not a generation')

  const shell = await gate(
    {
      name: 'pwsh',
      arguments: { command: 'Copy-Item a.docx b.doc' },
      agent: { session: { id: 'g2' } },
    },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(shell.kind, 'deny', 'a shell command that really writes one is still refused')
})

/** Minimal host stub that records the two handlers. */
function host(config) {
  const handlers = new Map()
  const ctx = {
    on: (event, handler) => handlers.set(event, handler),
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  applyPlugin(ctx, config)
  return handlers
}

test('reading an existing document never rewrites it', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-scope-read-'))
  const file = path.join(dir, 'theirs.docx')
  await fs.writeFile(file, docx())
  const handlers = host({ author: '张三' })
  await handlers.get('tools/post-execute')(
    { name: 'read', arguments: { path: file }, agent: { session: { id: 'r1' } } },
    { content: [] },
    async () => ({ kind: 'accept' }),
  )
  const core = readText(readZip(await fs.readFile(file)), 'docProps/core.xml')
  assert.match(core, /<dc:creator>gen<\/dc:creator>/, 'author must stay untouched')
  await fs.rm(dir, { recursive: true, force: true })
})

test('an old document mentioned by a write call is left alone', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-scope-old-'))
  const file = path.join(dir, 'old.docx')
  await fs.writeFile(file, docx())
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  await fs.utimes(file, hourAgo, hourAgo)
  const handlers = host({ author: '张三' })
  await handlers.get('tools/post-execute')(
    { name: 'write', arguments: { path: path.join(dir, 'notes.md'), content: 'see old.docx' }, agent: { session: { id: 'r2' } } },
    { content: [] },
    async () => ({ kind: 'accept' }),
  )
  const core = readText(readZip(await fs.readFile(file)), 'docProps/core.xml')
  assert.match(core, /<dc:creator>gen<\/dc:creator>/, 'old file must stay untouched')
  await fs.rm(dir, { recursive: true, force: true })
})

test('volatile config references are unwrapped, not stringified', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-scope-volatile-'))
  const file = path.join(dir, 'v.docx')
  await fs.writeFile(file, docx())

  // schemastery's `.volatile()` yields `{ get() }`, never a plain string.
  const ref = (value) => ({ get: () => value })
  const handlers = host({ author: ref('王五'), maxBytes: ref(10 * 1024 * 1024), notifySkipped: ref(true) })
  await handlers.get('tools/post-execute')(
    { name: 'write', arguments: { path: file }, agent: { session: { id: 'v1' } } },
    { content: [] },
    async () => ({ kind: 'accept' }),
  )
  const core = readText(readZip(await fs.readFile(file)), 'docProps/core.xml')
  assert.match(core, /<dc:creator>王五<\/dc:creator>/)
  assert.doesNotMatch(core, /object Object/)
  await fs.rm(dir, { recursive: true, force: true })
})

console.log('paths')

test('quoted and spaced paths are extracted', () => {
  const seen = []
  pathsIn({ command: 'python gen.py --out "C:\\tmp\\周报 2026.docx"' }, (candidate) => {
    seen.push(candidate)
    return undefined
  })
  assert.deepEqual(seen, ['C:\\tmp\\周报 2026.docx'])
})

test('relative paths are offered to the resolver', () => {
  const seen = []
  pathsIn({ path: 'out/report.xlsx' }, (candidate) => {
    seen.push(candidate)
    return undefined
  })
  assert.deepEqual(seen, ['out/report.xlsx'])
})

for (const [name, body] of queue) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${error.message}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
