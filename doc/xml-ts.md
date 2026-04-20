# XML plugin for Jsonic (TypeScript)

A Jsonic syntax plugin that parses XML 1.0 documents into plain
JavaScript objects, with support for attributes, mixed content,
namespaces, CDATA sections, comments, processing instructions, DOCTYPE
internal-subset entities and attribute defaults, UTF-8 / UTF-16 /
UTF-32 input with byte-order marks, and an embed mode that lets XML
literals appear as values in Jsonic source.

```bash
npm install @jsonic/xml
```

Requires `jsonic` >= 2 as a peer dependency.


## Tutorials

### Parse a basic XML document

Register the plugin on a Jsonic instance, then call it with an XML
string. The result is a plain object describing the root element:

```typescript
import { Jsonic } from 'jsonic'
import { Xml } from '@jsonic/xml'

const j = Jsonic.make().use(Xml)

j('<greeting>Hello, World!</greeting>')
// {
//   name: 'greeting',
//   localName: 'greeting',
//   attributes: {},
//   children: ['Hello, World!'],
// }
```

Every element has a `name` (the qualified name as written), a
`localName` (the part after any `:` prefix), an `attributes` map,
and a `children` array of nested elements and text strings in
document order.

### Parse attributes, self-closing tags, and mixed content

Attributes arrive as a plain string map; text runs and nested
elements interleave in `children`:

```typescript
const j = Jsonic.make().use(Xml)

j('<a><b x="1"/><c>inside</c>trailing</a>')
// {
//   name: 'a',
//   localName: 'a',
//   attributes: {},
//   children: [
//     { name: 'b', localName: 'b', attributes: { x: '1' }, children: [] },
//     { name: 'c', localName: 'c', attributes: {}, children: ['inside'] },
//     'trailing',
//   ],
// }
```

### Resolve namespaces and xml:* attributes

xmlns declarations scope through descendants; every element gains
`prefix`, `localName` and `namespace` fields where applicable.
`xml:lang` and `xml:space` are also inherited and annotated when
set to a non-default value:

```typescript
const j = Jsonic.make().use(Xml)

j('<root xmlns:svg="http://www.w3.org/2000/svg"><svg:rect xml:space="preserve"/></root>')
// {
//   name: 'root', localName: 'root',
//   attributes: { 'xmlns:svg': 'http://www.w3.org/2000/svg' },
//   children: [{
//     name: 'svg:rect', prefix: 'svg', localName: 'rect',
//     namespace: 'http://www.w3.org/2000/svg',
//     attributes: { 'xml:space': 'preserve' },
//     space: 'preserve',
//     children: [],
//   }],
// }
```

### Embed XML literals in Jsonic source

With `embed: true` the plugin splices an alternate into Jsonic's
`val` rule so a literal XML element can appear anywhere Jsonic
expects a value — inside maps, lists, or at the top level:

```typescript
const j = Jsonic.make().use(Xml, { embed: true })

j(`{
  title: "order-42",
  payload: <order id="42">
    <item qty="2">Widget</item>
    <item qty="1">Gadget</item>
  </order>,
}`)
// {
//   title: 'order-42',
//   payload: {
//     name: 'order', localName: 'order',
//     attributes: { id: '42' },
//     children: [
//       { name: 'item', ..., attributes: { qty: '2' }, children: ['Widget'] },
//       { name: 'item', ..., attributes: { qty: '1' }, children: ['Gadget'] },
//     ],
//   },
// }
```


## How-to guides

### Define custom named entities

Register additional `&name;` expansions beyond the five predefined
ones (`amp`, `lt`, `gt`, `quot`, `apos`):

```typescript
const j = Jsonic.make().use(Xml, {
  customEntities: { nbsp: '\u00a0', copy: '\u00a9' },
})

j('<p>&copy; 2025&nbsp;All rights reserved.</p>')
// { ..., children: ['© 2025\u00a0All rights reserved.'] }
```

### Use DOCTYPE-declared entities and attribute defaults

`<!ENTITY>` declarations in the DOCTYPE internal subset are parsed
and used to resolve `&name;` references; `<!ATTLIST>` declarations
supply default attribute values for elements that don't carry them:

```typescript
const j = Jsonic.make().use(Xml)

j(`<!DOCTYPE doc [
  <!ENTITY corp "Acme Corp.">
  <!ATTLIST item currency CDATA "USD">
]>
<doc>
  <item price="42">Copyright &corp;</item>
</doc>`)
// { name: 'doc', ..., children: [
//   '\n  ',
//   { name: 'item', ..., attributes: { price: '42', currency: 'USD' },
//     children: ['Copyright Acme Corp.'] },
//   '\n',
// ] }
```

### Parse files of unknown encoding

`decodeBOM` accepts either a Node `Buffer` (or `Uint8Array`) or a
"binary" JS string and returns a decoded Unicode string, detecting
UTF-8 / UTF-16 LE / UTF-16 BE / UTF-32 LE / UTF-32 BE byte-order
marks:

```typescript
import { readFileSync } from 'node:fs'
import { Jsonic } from 'jsonic'
import { Xml, decodeBOM } from '@jsonic/xml'

const j = Jsonic.make().use(Xml)
const doc = j(decodeBOM(readFileSync('data.xml')))
```

### Toggle strict entity handling

By default, references to undeclared entities raise a parse error
(per XML 1.0 §4.1). Set `strictEntities: false` to leave unknown
references as literal `&name;` text (useful for templating):

```typescript
const lenient = Jsonic.make().use(Xml, { strictEntities: false })
lenient('<a>&undefined;</a>')
// { ..., children: ['&undefined;'] }
```

### Disable namespace resolution

When `namespaces: false`, elements keep their raw qualified names
and no `prefix` / `localName` / `namespace` fields are added:

```typescript
const j = Jsonic.make().use(Xml, { namespaces: false })
j('<ns:a xmlns:ns="http://x"/>')
// { name: 'ns:a', attributes: { 'xmlns:ns': 'http://x' }, children: [] }
```

### Catch well-formedness errors

Every well-formedness violation raises a Jsonic parse error whose
`code` carries the specific XML error key (see the Reference
section):

```typescript
try {
  j('<a></b>')
} catch (err) {
  // err.code === 'xml_mismatched_tag'
}
```


## Explanation

### Pure mode vs embed mode

The plugin has two operating modes selected by the `embed` option.

In **pure mode** (`embed: false`, the default) the parser is
reconfigured for XML: the start rule becomes `xml`, JSON structural
tokens (`{ } [ ] : ,`) and Jsonic's number / string / value /
comment / space / line lexers are disabled, and only the custom
`<...>` matcher produces tokens for the grammar to consume.

In **embed mode** (`embed: true`) all of Jsonic's rules stay in
place. Two alternates are spliced into the `val` rule so that when
Jsonic sees an `<` it dispatches into the `element` grammar and
builds an XML subtree as that value. A per-parse XML depth counter
lets the matcher claim raw character data between tags so commas
and colons inside XML text are not reinterpreted as JSON
separators.

### Element data structure

Every parsed element is a plain object with the following shape:

| Field        | Type                          | Notes                                                    |
|--------------|-------------------------------|----------------------------------------------------------|
| `name`       | `string`                      | Qualified name as written (`"ns:tag"`).                  |
| `localName`  | `string`                      | Part after any `:` prefix.                               |
| `prefix`     | `string` or absent            | Present only when the name is prefixed.                  |
| `namespace`  | `string` or absent            | Resolved namespace URI if any xmlns declaration is in scope. |
| `space`      | `string` or absent            | Effective `xml:space` when different from `"default"`.   |
| `lang`       | `string` or absent            | Effective `xml:lang` when set on the element or an ancestor. |
| `attributes` | `Record<string, string>`      | Raw attribute map with entity references decoded.        |
| `children`   | `Array<XmlElement \| string>` | Nested elements and text runs in document order.         |

Text nodes (strings in `children`) have line endings normalised
per XML 1.0 §2.11 (CR and CR-LF become LF) and entity references
expanded. CDATA section contents arrive as plain strings too, with
no special marker.

### Well-formedness checks

The parser enforces the subset of XML 1.0 well-formedness rules
that can be checked structurally, without DTD validation:

- matched open/close tags, single root element, correctly-closed
  constructs (CDATA, comments, PIs, DOCTYPE)
- reserved comment (`--`) and CDATA (`]]>`) markers outside their
  legal positions
- processing-instruction target validity, rejection of `<` inside
  attribute values, duplicate attribute names
- legal XML characters (C0 controls other than tab/LF/CR are
  rejected in text, CDATA, comments, PIs, and attribute values)
- entity-reference syntax and, in strict mode, entity-name
  declaration
- reserved namespace prefix handling (`xml` must bind to its fixed
  URI; `xmlns` may not be declared) and rejection of unbound
  prefixes

What is **not** enforced: DTD-based validity (ID uniqueness,
IDREFs, content models, attribute types), full Unicode Char
production (#xFFFE/#xFFFF and unpaired surrogates), XML 1.1
syntax, and external-subset / external-entity resolution.


## Reference

### `Xml` (Plugin)

The plugin function. Register with `Jsonic.make().use(Xml, options)`.

### `decodeBOM(src) -> string`

Transcodes a byte-order-marked input to UTF-8. Accepts a Node
`Buffer` / `Uint8Array` or a "binary" JS string (Latin-1-mapped
bytes). Handles UTF-8, UTF-16 LE/BE, UTF-32 LE/BE. Input without
a BOM is returned unchanged (with a leading `U+FEFF` stripped if
the string was already decoded).

### `XmlOptions`

```typescript
type XmlOptions = {
  namespaces:     boolean                  // default: true
  entities:       boolean                  // default: true
  strictEntities: boolean                  // default: true
  customEntities: Record<string, string>   // default: {}
  embed:          boolean                  // default: false
}
```

### `XmlElement`

```typescript
type XmlElement = {
  name:       string
  localName:  string
  prefix?:    string
  namespace?: string
  space?:     string
  lang?:      string
  attributes: Record<string, string>
  children:   Array<XmlElement | string>
}
```

### Error codes

Raised as the `code` field of the Jsonic `SyntaxError` thrown on
parse failure:

| Code                       | Cause                                                                    |
|----------------------------|--------------------------------------------------------------------------|
| `xml_mismatched_tag`       | `</name>` does not match the matching `<name>`                           |
| `xml_invalid_tag`          | Malformed tag syntax (empty close tag, missing `>`, etc.)                |
| `unterminated_comment`     | `<!-- ...` never closed                                                  |
| `unterminated_cdata`       | `<![CDATA[ ...` never closed                                             |
| `unterminated_doctype`     | `<!DOCTYPE ...` never closed                                             |
| `unterminated_pi`          | `<? ...` never closed                                                    |
| `comment_double_dash`      | `--` appears inside a comment body                                       |
| `cdata_terminator_in_text` | `]]>` appears in character data                                          |
| `pi_target_invalid`        | Processing-instruction target is missing or not a Name                   |
| `lt_in_attr_value`         | Literal `<` inside an attribute value                                    |
| `bad_entity_ref`           | Malformed `&...;` reference                                              |
| `undeclared_entity`        | `&name;` does not resolve (strict mode)                                  |
| `duplicate_attribute`      | Same attribute name twice in one tag                                     |
| `invalid_xml_char`         | Illegal XML character in data                                            |
| `reserved_namespace`       | Invalid use of the reserved `xml` / `xmlns` prefix or URI                |
| `unbound_prefix`           | Element or attribute uses a prefix with no in-scope declaration          |
