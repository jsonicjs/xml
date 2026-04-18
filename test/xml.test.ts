/* Copyright (c) 2021-2025 Richard Rodger and other contributors, MIT License */

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { Jsonic } from 'jsonic'
import { Xml } from '../dist/xml'

describe('xml', () => {
  test('empty-element', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a></a>'), { name: 'a', children: [] })
  })

  test('self-closing-element', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a/>'), { name: 'a', children: [] })
    assert.deepEqual(jx('<br />'), { name: 'br', children: [] })
  })

  test('text-content', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a>hello</a>'), {
      name: 'a',
      children: ['hello'],
    })
    assert.deepEqual(jx('<greet>hello world</greet>'), {
      name: 'greet',
      children: ['hello world'],
    })
  })

  test('nested-elements', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a><b></b></a>'), {
      name: 'a',
      children: [{ name: 'b', children: [] }],
    })
    assert.deepEqual(jx('<a><b>x</b></a>'), {
      name: 'a',
      children: [{ name: 'b', children: ['x'] }],
    })
  })

  test('deeply-nested', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a><b><c>x</c></b></a>'), {
      name: 'a',
      children: [
        {
          name: 'b',
          children: [{ name: 'c', children: ['x'] }],
        },
      ],
    })
  })

  test('multiple-children', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a><b/><c/></a>'), {
      name: 'a',
      children: [
        { name: 'b', children: [] },
        { name: 'c', children: [] },
      ],
    })
    assert.deepEqual(jx('<a><b>1</b><c>2</c></a>'), {
      name: 'a',
      children: [
        { name: 'b', children: ['1'] },
        { name: 'c', children: ['2'] },
      ],
    })
  })

  test('mixed-content', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a>hello<b>inner</b>world</a>'), {
      name: 'a',
      children: [
        'hello',
        { name: 'b', children: ['inner'] },
        'world',
      ],
    })
  })

  test('tag-name-variants', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<a-b>x</a-b>'), {
      name: 'a-b',
      children: ['x'],
    })
    assert.deepEqual(jx('<a.b>x</a.b>'), {
      name: 'a.b',
      children: ['x'],
    })
    assert.deepEqual(jx('<a_b>x</a_b>'), {
      name: 'a_b',
      children: ['x'],
    })
    assert.deepEqual(jx('<ns:a>x</ns:a>'), {
      name: 'ns:a',
      children: ['x'],
    })
  })

  test('mismatched-tag', () => {
    const jx = Jsonic.make().use(Xml)
    assert.throws(() => jx('<a></b>'), /xml_mismatched_tag|mismatched/i)
  })

  test('multiline-content', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<root>\n  <a>1</a>\n  <b>2</b>\n</root>'),
      {
        name: 'root',
        children: [
          '\n  ',
          { name: 'a', children: ['1'] },
          '\n  ',
          { name: 'b', children: ['2'] },
          '\n',
        ],
      },
    )
  })

  test('preserves-whitespace-text', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(jx('<p>  hello   world  </p>'), {
      name: 'p',
      children: ['  hello   world  '],
    })
  })

  test('deeply-nested-and-siblings', () => {
    const jx = Jsonic.make().use(Xml)
    assert.deepEqual(
      jx('<a><b><c/><d>x</d></b><e/></a>'),
      {
        name: 'a',
        children: [
          {
            name: 'b',
            children: [
              { name: 'c', children: [] },
              { name: 'd', children: ['x'] },
            ],
          },
          { name: 'e', children: [] },
        ],
      },
    )
  })
})
