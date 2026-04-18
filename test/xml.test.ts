/* Copyright (c) 2021-2025 Richard Rodger and other contributors, MIT License */

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { Jsonic } from 'jsonic'
import { Xml } from '../dist/xml'

// ---------------------------------------------------------------------------
// Shared TSV spec runner
//
// Test cases are defined in tab-separated value files under test/spec/*.tsv.
// Each non-comment row is:
//   name<TAB>input<TAB>expected<TAB>opts
// - `input` uses the escape set \n \r \t \\
// - `expected` is raw JSON (standard JSON escapes apply) or the literal
//   token ERROR / ERROR:code for expected parse failures.
// - `opts` is optional JSON for plugin options.
// The same files drive the Go test suite in go/xml_test.go.
// ---------------------------------------------------------------------------

// At runtime this test file is loaded from `dist-test/`, so hop up one
// level to reach the shared spec directory in the project root.
const specDir = join(__dirname, '..', 'test', 'spec')

type SpecRow = {
  file: string
  line: number
  name: string
  input: string
  expected: string
  opts: string
}

function loadSpec(file: string): SpecRow[] {
  const path = join(specDir, file)
  const body = readFileSync(path, 'utf8')
  const rows: SpecRow[] = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === '' || raw.startsWith('#')) continue
    const cols = raw.split('\t')
    if (cols.length < 3) {
      throw new Error(`${file}:${i + 1}: expected >=3 tab-separated columns`)
    }
    rows.push({
      file,
      line: i + 1,
      name: cols[0],
      input: unescapeInput(cols[1]),
      expected: cols[2],
      opts: cols[3] ?? '',
    })
  }
  return rows
}

// Decode the escape sequences used in the spec `input` column. Keeps
// the behaviour identical to the Go loader so the two language test
// suites exercise the exact same XML text.
function unescapeInput(s: string): string {
  if (!s.includes('\\')) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === 'n') { out += '\n'; i++; continue }
      if (n === 'r') { out += '\r'; i++; continue }
      if (n === 't') { out += '\t'; i++; continue }
      if (n === '\\') { out += '\\'; i++; continue }
    }
    out += c
  }
  return out
}

function runSpec(file: string) {
  const rows = loadSpec(file)
  describe(file, () => {
    for (const row of rows) {
      test(row.name, () => {
        const opts = row.opts.trim() === '' ? undefined : JSON.parse(row.opts)
        const jx = opts ? Jsonic.make().use(Xml, opts) : Jsonic.make().use(Xml)

        if (row.expected.startsWith('ERROR')) {
          const code = row.expected.slice(5).replace(/^:/, '')
          assert.throws(
            () => jx(row.input),
            (err: Error) =>
              code === '' || err.message.includes(code) ||
              // Jsonic wraps codes as `jsonic/<code>`; accept that form too.
              err.message.includes('/' + code),
            `${row.file}:${row.line}: expected error ${row.expected}`,
          )
          return
        }

        const got = jx(row.input)
        const want = JSON.parse(row.expected)
        // Round-trip `got` through JSON so ordering of keys does not affect
        // structural comparison (deepEqual is already order-insensitive for
        // objects, but this also strips undefined fields cleanly).
        assert.deepEqual(
          JSON.parse(JSON.stringify(got)),
          want,
          `${row.file}:${row.line}: ${row.name}`,
        )
      })
    }
  })
}

// Auto-discover every .tsv under test/spec and run it. Keeping this
// driven by directory contents means adding a new spec file never
// requires editing the TypeScript test code.
for (const file of readdirSync(specDir)) {
  if (file.endsWith('.tsv')) runSpec(file)
}


// ---------------------------------------------------------------------------
// XML embedded in Jsonic source
//
// A common real-world pattern is to keep XML payloads inside a larger
// Jsonic configuration file as a string value. This test demonstrates
// that the stock Jsonic parser reads the outer document and the Xml
// plugin parses the embedded payload.
// ---------------------------------------------------------------------------

describe('xml-embedded-in-jsonic', () => {
  test('parses XML inside a Jsonic multiline string', () => {
    // A plain Jsonic document. The backtick string carries the XML
    // payload verbatim, with newlines and double quotes intact.
    const jsonicSrc = "{\n" +
      "  title: 'order-42',\n" +
      "  payload: `" +
      '<?xml version="1.0"?>\n' +
      '<order id="42">\n' +
      '  <item qty="2">Widget</item>\n' +
      '  <item qty="1">Gadget</item>\n' +
      '</order>' + "`,\n" +
      "}\n"

    const outer = Jsonic(jsonicSrc) as any
    assert.equal(outer.title, 'order-42')
    assert.equal(typeof outer.payload, 'string')

    const xmlParser = Jsonic.make().use(Xml)
    const parsed = xmlParser(outer.payload) as any
    assert.equal(parsed.name, 'order')
    assert.equal(parsed.attributes.id, '42')

    const items = parsed.children.filter(
      (c: any) => typeof c === 'object' && c.name === 'item',
    )
    assert.equal(items.length, 2)
    assert.equal(items[0].attributes.qty, '2')
    assert.equal(items[0].children[0], 'Widget')
    assert.equal(items[1].attributes.qty, '1')
    assert.equal(items[1].children[0], 'Gadget')
  })
})
