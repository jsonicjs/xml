# XML plugin for Jsonic (Go)

A Jsonic syntax plugin that parses XML 1.0 documents into Go maps,
with support for attributes, mixed content, namespaces, CDATA
sections, comments, processing instructions, DOCTYPE internal-subset
entities and attribute defaults, UTF-8 / UTF-16 / UTF-32 input with
byte-order marks, and an embed mode that lets XML literals appear as
values in Jsonic source.

```go
import (
    jsonic "github.com/jsonicjs/jsonic/go"
    xml "github.com/jsonicjs/xml/go"
)
```

```bash
go get github.com/jsonicjs/xml/go@latest
```


## Tutorials

### Parse a basic XML document

Register the plugin on a Jsonic instance with `UseDefaults`, then
call `Parse`. The result is a `map[string]any` describing the root
element:

```go
j := jsonic.Make()
j.UseDefaults(xml.Xml, xml.Defaults)

result, _ := j.Parse("<greeting>Hello, World!</greeting>")
// map[string]any{
//     "name":       "greeting",
//     "localName":  "greeting",
//     "attributes": map[string]any{},
//     "children":   []any{"Hello, World!"},
// }
```

Every element has a `name` (the qualified name as written), a
`localName` (the part after any `:` prefix), an `attributes` map,
and a `children` slice of nested elements and text strings in
document order.

### Parse attributes, self-closing tags, and mixed content

Attributes arrive as a `map[string]any` of string values; text
runs and nested elements interleave in `children`:

```go
result, _ := j.Parse(`<a><b x="1"/><c>inside</c>trailing</a>`)
// map[string]any{
//     "name":       "a",
//     "localName":  "a",
//     "attributes": map[string]any{},
//     "children": []any{
//         map[string]any{"name": "b", "localName": "b",
//             "attributes": map[string]any{"x": "1"}, "children": []any{}},
//         map[string]any{"name": "c", "localName": "c",
//             "attributes": map[string]any{}, "children": []any{"inside"}},
//         "trailing",
//     },
// }
```

### Resolve namespaces and xml:* attributes

xmlns declarations scope through descendants; every element gains
`prefix`, `localName`, and `namespace` fields where applicable.
`xml:lang` and `xml:space` are also inherited and annotated when
set to a non-default value:

```go
src := `<root xmlns:svg="http://www.w3.org/2000/svg"><svg:rect xml:space="preserve"/></root>`
result, _ := j.Parse(src)
// map[string]any{
//     "name": "root", "localName": "root",
//     "attributes": map[string]any{"xmlns:svg": "http://www.w3.org/2000/svg"},
//     "children": []any{
//         map[string]any{
//             "name": "svg:rect", "prefix": "svg", "localName": "rect",
//             "namespace": "http://www.w3.org/2000/svg",
//             "attributes": map[string]any{"xml:space": "preserve"},
//             "space": "preserve",
//             "children": []any{},
//         },
//     },
// }
```

### Embed XML literals in Jsonic source

With `embed: true` the plugin splices an alternate into Jsonic's
`val` rule so a literal XML element can appear anywhere Jsonic
expects a value — inside maps, slices, or at the top level:

```go
j := jsonic.Make()
j.UseDefaults(xml.Xml, xml.Defaults, map[string]any{"embed": true})

src := `{
  title: "order-42",
  payload: <order id="42">
    <item qty="2">Widget</item>
    <item qty="1">Gadget</item>
  </order>,
}`

result, _ := j.Parse(src)
// map[string]any{
//   "title": "order-42",
//   "payload": map[string]any{
//     "name": "order", "attributes": map[string]any{"id": "42"},
//     "children": []any{
//       map[string]any{"name": "item",
//         "attributes": map[string]any{"qty": "2"},
//         "children": []any{"Widget"}},
//       ...
//     },
//   },
// }
```


## How-to guides

### Define custom named entities

Register additional `&name;` expansions beyond the five predefined
ones (`amp`, `lt`, `gt`, `quot`, `apos`):

```go
j := jsonic.Make()
j.UseDefaults(xml.Xml, xml.Defaults, map[string]any{
    "customEntities": map[string]string{
        "nbsp": "\u00a0",
        "copy": "\u00a9",
    },
})

result, _ := j.Parse("<p>&copy; 2025&nbsp;All rights reserved.</p>")
// children: []any{"© 2025\u00a0All rights reserved."}
```

### Use DOCTYPE-declared entities and attribute defaults

`<!ENTITY>` declarations in the DOCTYPE internal subset are parsed
and used to resolve `&name;` references. `<!ATTLIST>` declarations
supply default attribute values for elements that don't carry
them:

```go
src := `<!DOCTYPE doc [
  <!ENTITY corp "Acme Corp.">
  <!ATTLIST item currency CDATA "USD">
]>
<doc>
  <item price="42">Copyright &corp;</item>
</doc>`

result, _ := j.Parse(src)
// item attributes: map[string]any{"price": "42", "currency": "USD"}
// item children:   []any{"Copyright Acme Corp."}
```

### Parse files of unknown encoding

`DecodeBOM` accepts a raw byte slice reinterpreted as a string and
returns a transcoded UTF-8 string, detecting UTF-8, UTF-16 LE/BE,
UTF-32 LE/BE byte-order marks:

```go
body, _ := os.ReadFile("data.xml")
result, _ := j.Parse(xml.DecodeBOM(string(body)))
```

### Toggle strict entity handling

By default, references to undeclared entities raise a parse error
(per XML 1.0 §4.1). Set `strictEntities` to `false` to leave
unknown references as literal `&name;` text (useful for
templating):

```go
j.UseDefaults(xml.Xml, xml.Defaults, map[string]any{"strictEntities": false})
result, _ := j.Parse("<a>&undefined;</a>")
// children: []any{"&undefined;"}
```

### Disable namespace resolution

When `namespaces: false`, elements keep their raw qualified names
and no `prefix` / `localName` / `namespace` fields are added:

```go
j.UseDefaults(xml.Xml, xml.Defaults, map[string]any{"namespaces": false})
result, _ := j.Parse(`<ns:a xmlns:ns="http://x"/>`)
// map[string]any{"name": "ns:a",
//     "attributes": map[string]any{"xmlns:ns": "http://x"},
//     "children": []any{}}
```

### Catch well-formedness errors

Every well-formedness violation produces a Jsonic parse error
whose error string contains the specific XML error code (see the
Reference section):

```go
_, err := j.Parse("<a></b>")
// err != nil; err.Error() contains "xml_mismatched_tag"
```


## Explanation

### Pure mode vs embed mode

The plugin has two operating modes selected by the `embed` option.

In **pure mode** (`embed: false`, the default) the parser is
reconfigured for XML: the start rule becomes `xml`, JSON
structural tokens (`{ } [ ] : ,`) and Jsonic's number / string /
value / comment / space / line lexers are disabled, and only the
custom `<...>` matcher produces tokens for the grammar to consume.

In **embed mode** (`embed: true`) all of Jsonic's rules stay in
place. Two alternates are spliced into the `val` rule so that
when Jsonic sees `<` it dispatches into the `element` grammar and
builds an XML subtree as that value. A per-parse XML depth
counter lets the matcher claim raw character data between tags so
commas and colons inside XML text are not reinterpreted as JSON
separators.

### Element data structure

Every parsed element is a `map[string]any` with the following
keys:

| Key          | Type                           | Notes                                                    |
|--------------|--------------------------------|----------------------------------------------------------|
| `name`       | `string`                       | Qualified name as written (`"ns:tag"`).                  |
| `localName`  | `string`                       | Part after any `:` prefix.                               |
| `prefix`     | `string` (absent if no prefix) | Namespace prefix when the name is prefixed.              |
| `namespace`  | `string` (absent if unbound)   | Resolved namespace URI if any xmlns declaration is in scope. |
| `space`      | `string` (absent if default)   | Effective `xml:space` when different from `"default"`.   |
| `lang`       | `string` (absent if unset)     | Effective `xml:lang` when set on the element or an ancestor. |
| `attributes` | `map[string]any`               | Raw attribute map with entity references decoded.        |
| `children`   | `[]any`                        | Nested elements and text runs in document order.         |

Text nodes (strings in `children`) have line endings normalised
per XML 1.0 §2.11 (CR and CR-LF become LF) and entity references
expanded. CDATA section contents arrive as plain strings too,
with no special marker.

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
- reserved namespace prefix handling (`xml` must bind to its
  fixed URI; `xmlns` may not be declared) and rejection of
  unbound prefixes

What is **not** enforced: DTD-based validity (ID uniqueness,
IDREFs, content models, attribute types), full Unicode Char
production (#xFFFE/#xFFFF and unpaired surrogates), XML 1.1
syntax, and external-subset / external-entity resolution.


## Reference

### `Xml(j *jsonic.Jsonic, options map[string]any) error`

The plugin function. Register with
`j.UseDefaults(xml.Xml, xml.Defaults, opts...)`.

### `Defaults` map

The default option values, merged with caller-supplied options by
`UseDefaults`:

```go
var Defaults = map[string]any{
    "namespaces":     true,
    "entities":       true,
    "customEntities": map[string]string{},
    "strictEntities": true,
    "embed":          false,
}
```

### Option keys

| Key              | Type                | Default | Purpose                                                                                   |
|------------------|---------------------|---------|-------------------------------------------------------------------------------------------|
| `namespaces`     | `bool`              | `true`  | Resolve xmlns / xmlns:* into `prefix` / `localName` / `namespace` fields.                 |
| `entities`       | `bool`              | `true`  | Decode the five predefined entities and numeric character references.                     |
| `customEntities` | `map[string]string` | `{}`    | Additional named entities to recognise.                                                   |
| `strictEntities` | `bool`              | `true`  | Enforce XML 1.0 §4.1: reference to undeclared named entity is a parse error.              |
| `embed`          | `bool`              | `false` | Splice XML literals into Jsonic's `val` rule so `<tag>…</tag>` can appear as a value.     |

### `DecodeBOM(src string) string`

Transcodes a byte-order-marked input to UTF-8. Pass the raw file
bytes (reinterpreted as a Go string). Handles UTF-8, UTF-16 LE/BE,
UTF-32 LE/BE. Input without a BOM is returned unchanged.

### `EntityDecoder`

```go
type EntityDecoder func(s string, dtd map[string]string) string
```

Internal function type carried by the plugin's entity-decoding
closure. Returned as a side effect of `buildEntityDecoder` — not
typically called directly.

### Error codes

Raised as part of the parse error's message when a well-formedness
rule is violated:

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
