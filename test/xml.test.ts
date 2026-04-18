/* Copyright (c) 2021-2025 Richard Rodger and other contributors, MIT License */

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { Jsonic } from 'jsonic'
import { Xml } from '../dist/xml'

// Build a plain element literal in the shape the parser emits. Optional
// namespace / prefix fields are only present when actually resolved.
function elem(
  name: string,
  children: any[] = [],
  attributes: Record<string, string> = {},
  extras: Record<string, string> = {},
) {
  const out: any = {
    name,
    localName: extras.localName ?? name,
    attributes,
    children,
  }
  if (extras.prefix) out.prefix = extras.prefix
  if (extras.namespace) out.namespace = extras.namespace
  return out
}

describe('xml', () => {
  test('empty-element', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a></a>'), elem('a'))
  })

  test('self-closing-element', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a/>'), elem('a'))
    assert.deepEqual(jx('<br />'), elem('br'))
  })

  test('text-content', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a>hello</a>'), elem('a', ['hello']))
    assert.deepEqual(
      jx('<greet>hello world</greet>'),
      elem('greet', ['hello world']),
    )
  })

  test('nested-elements', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a><b></b></a>'), elem('a', [elem('b')]))
    assert.deepEqual(jx('<a><b>x</b></a>'), elem('a', [elem('b', ['x'])]))
  })

  test('deeply-nested', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a><b><c>x</c></b></a>'),
      elem('a', [elem('b', [elem('c', ['x'])])]),
    )
  })

  test('multiple-children', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a><b/><c/></a>'),
      elem('a', [elem('b'), elem('c')]),
    )
    assert.deepEqual(
      jx('<a><b>1</b><c>2</c></a>'),
      elem('a', [elem('b', ['1']), elem('c', ['2'])]),
    )
  })

  test('mixed-content', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a>hello<b>inner</b>world</a>'),
      elem('a', ['hello', elem('b', ['inner']), 'world']),
    )
  })

  test('tag-name-variants', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a-b>x</a-b>'), elem('a-b', ['x']))
    assert.deepEqual(jx('<a.b>x</a.b>'), elem('a.b', ['x']))
    assert.deepEqual(jx('<a_b>x</a_b>'), elem('a_b', ['x']))
  })

  test('mismatched-tag', () => {
    const jx = Jsonic.make().use(Xml)
    assert.throws(() => jx('<a></b>'), /xml_mismatched_tag|mismatched/i)
  })

  test('multiline-content', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<root>\n  <a>1</a>\n  <b>2</b>\n</root>'),
      elem('root', [
        '\n  ',
        elem('a', ['1']),
        '\n  ',
        elem('b', ['2']),
        '\n',
      ]),
    )
  })

  test('preserves-whitespace-text', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<p>  hello   world  </p>'),
      elem('p', ['  hello   world  ']),
    )
  })

  test('attributes-basic', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a x="1"/>'),
      elem('a', [], { x: '1' }),
    )
    assert.deepEqual(
      jx('<a x="1" y="2"/>'),
      elem('a', [], { x: '1', y: '2' }),
    )
    assert.deepEqual(
      jx('<a x="hello world">text</a>'),
      elem('a', ['text'], { x: 'hello world' }),
    )
  })

  test('attributes-single-quote', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx(`<a x='value'/>`),
      elem('a', [], { x: 'value' }),
    )
    assert.deepEqual(
      jx(`<a x='it says "hi"'/>`),
      elem('a', [], { x: 'it says "hi"' }),
    )
  })

  test('attributes-spacing-variants', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a  x = "1"   y="2" />'),
      elem('a', [], { x: '1', y: '2' }),
    )
    assert.deepEqual(
      jx('<a\n  x="1"\n  y="2"\n/>'),
      elem('a', [], { x: '1', y: '2' }),
    )
  })

  test('attributes-with-dashes-and-dots', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a data-x="1" v.2="ok"/>'),
      elem('a', [], { 'data-x': '1', 'v.2': 'ok' }),
    )
  })

  test('entities-predefined-in-text', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a>&amp;&lt;&gt;&quot;&apos;</a>'),
      elem('a', [`&<>"'`]),
    )
    assert.deepEqual(
      jx('<a>Tom &amp; Jerry</a>'),
      elem('a', ['Tom & Jerry']),
    )
  })

  test('entities-numeric-references', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a>&#65;&#66;</a>'), elem('a', ['AB']))
    assert.deepEqual(jx('<a>&#x41;&#x42;</a>'), elem('a', ['AB']))
    assert.deepEqual(jx('<a>&#x1F600;</a>'), elem('a', ['\u{1F600}']))
  })

  test('entities-in-attribute-values', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a title="Tom &amp; Jerry"/>'),
      elem('a', [], { title: 'Tom & Jerry' }),
    )
    assert.deepEqual(
      jx('<a v="&#65;&#x42;"/>'),
      elem('a', [], { v: 'AB' }),
    )
  })

  test('entities-unknown-passthrough', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a>&unknown;</a>'),
      elem('a', ['&unknown;']),
    )
  })

  test('entities-custom', () => {
    const jx = Jsonic.make().use(Xml, {
      customEntities: { nbsp: '\u00a0', copy: '\u00a9' },
    })
    assert.deepEqual(
      jx('<a>&copy; 2025&nbsp;all rights</a>'),
      elem('a', ['\u00a9 2025\u00a0all rights']),
    )
  })

  test('entities-disabled', () => {
    const jx = Jsonic.make().use(Xml, { entities: false })
    assert.deepEqual(jx('<a>&amp;</a>'), elem('a', ['&amp;']))
  })

  test('comments-ignored', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<!-- hi --><a/>'), elem('a'))
    assert.deepEqual(
      jx('<a><!-- comment -->hello</a>'),
      elem('a', ['hello']),
    )
    assert.deepEqual(
      jx('<a><!-- c1 --><b/><!-- c2 --></a>'),
      elem('a', [elem('b')]),
    )
  })

  test('processing-instructions-ignored', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<?xml version="1.0" encoding="UTF-8"?><a/>'),
      elem('a'),
    )
    assert.deepEqual(
      jx('<?xml-stylesheet href="s.xsl"?><root/>'),
      elem('root'),
    )
  })

  test('doctype-ignored', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<!DOCTYPE html><html/>'),
      elem('html'),
    )
    assert.deepEqual(
      jx(
        '<!DOCTYPE note SYSTEM "Note.dtd"><note><body>hi</body></note>',
      ),
      elem('note', [elem('body', ['hi'])]),
    )
  })

  test('doctype-with-internal-subset', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<!DOCTYPE a [<!ENTITY x "y">]><a/>'),
      elem('a'),
    )
  })

  test('cdata-section', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a><![CDATA[<not a tag> & raw text]]></a>'),
      elem('a', ['<not a tag> & raw text']),
    )
  })

  test('namespaces-default', () => {
    const jx = Jsonic.make().use(Xml)
    const result = jx('<a xmlns="http://example.com"><b/></a>')
    assert.deepEqual(result, {
      name: 'a',
      localName: 'a',
      namespace: 'http://example.com',
      attributes: { xmlns: 'http://example.com' },
      children: [
        {
          name: 'b',
          localName: 'b',
          namespace: 'http://example.com',
          attributes: {},
          children: [],
        },
      ],
    })
  })

  test('namespaces-prefixed', () => {
    const jx = Jsonic.make().use(Xml)
    const result = jx(
      '<root xmlns:x="http://x.example"><x:a x:k="v">body</x:a></root>',
    )
    assert.deepEqual(result, {
      name: 'root',
      localName: 'root',
      attributes: { 'xmlns:x': 'http://x.example' },
      children: [
        {
          name: 'x:a',
          prefix: 'x',
          localName: 'a',
          namespace: 'http://x.example',
          attributes: { 'x:k': 'v' },
          children: ['body'],
        },
      ],
    })
  })

  test('namespaces-inherited-scope', () => {
    const jx = Jsonic.make().use(Xml)
    const result = jx(
      '<a xmlns:p="http://p.example"><p:b><p:c/></p:b></a>',
    )
    assert.equal(result.children[0].namespace, 'http://p.example')
    assert.equal(result.children[0].children[0].namespace, 'http://p.example')
  })

  test('namespaces-override-in-child', () => {
    const jx = Jsonic.make().use(Xml)
    const result = jx(
      '<a xmlns="A"><b xmlns="B"><c/></b><d/></a>',
    )
    assert.equal(result.namespace, 'A')
    assert.equal(result.children[0].namespace, 'B')
    assert.equal(result.children[0].children[0].namespace, 'B')
    assert.equal(result.children[1].namespace, 'A')
  })

  test('namespaces-disabled', () => {
    const jx = Jsonic.make().use(Xml, { namespaces: false })
    const result = jx('<a xmlns="http://example.com"/>')
    assert.equal(result.namespace, undefined)
    assert.equal(result.prefix, undefined)
  })

  test('full-document', () => {
    const jx = Jsonic.make().use(Xml)
    const src = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE note>
<note lang="en">
  <!-- a simple note -->
  <to>Tove</to>
  <from>Jani</from>
  <heading>Reminder</heading>
  <body>Don't forget me this weekend! &amp; cheers</body>
  <data><![CDATA[<tag/>]]></data>
</note>`
    const result = jx(src)
    assert.equal(result.name, 'note')
    assert.equal(result.attributes.lang, 'en')
    const childElems = result.children.filter((c: any) => 'object' === typeof c)
    assert.equal(childElems.length, 5)
    assert.equal(childElems[0].name, 'to')
    assert.equal(childElems[0].children[0], 'Tove')
    assert.equal(childElems[3].children[0], "Don't forget me this weekend! & cheers")
    assert.equal(childElems[4].children[0], '<tag/>')
  })
})
