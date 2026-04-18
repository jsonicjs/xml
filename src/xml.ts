/* Copyright (c) 2021-2025 Richard Rodger, MIT License */

// Import Jsonic types used by plugins.
import {
  Jsonic,
  Rule,
  Plugin,
  Context,
  Config,
  Options,
  Lex,
} from 'jsonic'

// A parsed XML element.
//
// Fields:
//   name       - qualified name as written in the source (e.g. "ns:tag")
//   prefix     - namespace prefix if any ("ns"), else undefined
//   localName  - local part of the qualified name ("tag")
//   namespace  - URI bound to the prefix/default at parse time
//   attributes - attribute map, with entity references decoded. Namespace
//                declarations ("xmlns", "xmlns:*") are kept here too.
//   children   - mixed array of text strings and nested elements.
type XmlElement = {
  name: string
  prefix?: string
  localName: string
  namespace?: string
  attributes: Record<string, string>
  children: Array<XmlElement | string>
}

type XmlOptions = {
  // Whether to resolve namespaces (annotate elements with
  // `prefix`/`localName`/`namespace`). Default: true.
  namespaces: boolean
  // Whether to decode the five predefined entities and numeric character
  // references in text and attribute values. Default: true.
  entities: boolean
  // Additional named entities to recognise beyond the five predefined ones.
  customEntities: Record<string, string>
}

// --- BEGIN EMBEDDED xml-grammar.jsonic ---
const grammarText = `
# XML Grammar Definition (elements + attributes + mixed content)
# Parsed by a standard Jsonic instance and passed to jsonic.grammar()
# Function references (@ prefixed) are resolved against the refs map
#
# Token naming:
#   #XOP - XML open tag, e.g. <tagname attr="value">
#   #XCL - XML close tag, e.g. </tagname>
#   #XSC - XML self-close tag, e.g. <tagname attr="value"/>
#   #XIG - comment / processing instruction / DOCTYPE (ignored)
#   #TX  - text content between tags (CDATA included)
#   #ZZ  - end of input

{
  rule: xml: open: [
    { s: '#ZZ' }
    { s: '#TX' r: xml }
    { p: element }
  ]
  rule: xml: close: [
    { s: '#ZZ' }
    { s: '#TX' r: xml }
  ]

  rule: element: open: [
    { s: '#XSC' a: '@element-selfclose' u: { selfclose: 1 } }
    { s: '#XOP' p: content a: '@element-open' }
  ]
  rule: element: close: [
    { c: '@element-is-selfclosed' }
    { s: '#XCL' a: '@element-close' }
  ]

  rule: content: open: [
    { s: '#XCL' b: 1 }
    { p: child }
  ]
  rule: content: close: [
    { s: '#XCL' b: 1 }
    { r: content }
  ]

  rule: child: open: [
    { s: '#TX' a: '@child-text' }
    { s: '#XOP' b: 1 p: element }
    { s: '#XSC' b: 1 p: element }
  ]
}
`
// --- END EMBEDDED xml-grammar.jsonic ---


const Xml: Plugin = (jsonic: Jsonic, options: XmlOptions) => {
  const decodeEntity = buildEntityDecoder(options)

  // Register custom lexer matchers.
  //
  // The XML tag matcher handles any `<...>` construct: elements (open,
  // close, self-closing) with attributes, comments, CDATA, processing
  // instructions and DOCTYPE declarations.
  //
  // A text modifier decodes entity references (`&amp;` etc.) in text
  // nodes. Attribute values are decoded inside the tag matcher.
  jsonic.options({
    lex: {
      match: {
        xmltag: { order: 1e5, make: buildXmlTagMatcher(decodeEntity) },
      },
      emptyResult: undefined,
    },
    // Terminate text at `<` so tag starts are not absorbed into text runs.
    ender: ['<'],
    rule: {
      start: 'xml',
      // Strip out JSON rules so XML input is not reinterpreted.
      exclude: 'jsonic,imp',
    },
    // Disable JSON structural fixed tokens.
    fixed: {
      token: {
        '#OB': null,
        '#CB': null,
        '#OS': null,
        '#CS': null,
        '#CL': null,
        '#CA': null,
      },
    },
    // Comments and processing instructions are emitted as a dedicated
    // #XIG token and skipped by the parser via the IGNORE set. Keep the
    // default IGNORE members so that whichever lexers happen to produce
    // #SP/#LN/#CM still get skipped.
    tokenSet: {
      IGNORE: ['#SP', '#LN', '#CM', '#XIG'],
    },
    // Disable number, value, and string lexing so XML text content is
    // always a plain string.
    number: { lex: false },
    value: { lex: false },
    string: { lex: false },
    comment: { lex: false },
    // Treat whitespace and newlines as part of text content rather than
    // as separate tokens so text between tags is preserved verbatim.
    space: { lex: false },
    line: { lex: false },
    // Decode entity references in text nodes.
    text: {
      modify: (val: any) =>
        'string' === typeof val && options.entities !== false
          ? decodeEntity(val)
          : val,
    },
    error: {
      xml_mismatched_tag:
        'closing tag </$fsrc> does not match opening tag <$openname>',
      xml_invalid_tag: 'invalid tag: $fsrc',
      xml_unterminated: 'unterminated $kind',
    },
    hint: {
      xml_mismatched_tag: `Each opening tag must be paired with a matching closing tag.
Expected </$openname> but found </$fsrc>.`,
      xml_invalid_tag: `The tag syntax is not valid XML.`,
      xml_unterminated: `The $kind starting at this position is not terminated.`,
    },
  })

  const refs: Record<string, Function> = {
    // Propagate the parsed root element up to the xml rule so it becomes
    // the final parse result. The xml rule uses `r: xml` to skip leading
    // and trailing whitespace text, which creates a chain of rule
    // instances. The root is the first one; walk the rule chain back to
    // it so the final result is stored on the root rule's node.
    '@xml-bc': (r: Rule, ctx: Context) => {
      if (r.child && r.child.node) {
        const root = ctx.root()
        root.node = r.child.node
        if (options.namespaces !== false) {
          resolveNamespaces(root.node, {})
        }
      }
    },

    // Initialise the element node when the opening tag `<name ...>` is
    // matched. The tag token's value carries both the name and the
    // parsed attribute map.
    '@element-open': (r: Rule) => {
      const v = r.o0.val
      r.node = {
        name: v.name,
        localName: v.name,
        attributes: v.attributes,
        children: [],
      }
    },

    // Self-closing tag `<name .../>` - no children.
    '@element-selfclose': (r: Rule) => {
      const v = r.o0.val
      r.node = {
        name: v.name,
        localName: v.name,
        attributes: v.attributes,
        children: [],
      }
    },

    // Verify that `</name>` matches the opening `<name ...>`.
    '@element-close': (r: Rule, ctx: Context) => {
      const openName = r.node && r.node.name
      const closeName = r.c0.val
      if (openName !== closeName) {
        r.c0.use = { openname: openName }
        return ctx.t0.bad('xml_mismatched_tag')
      }
    },

    // Text node - push the text value onto the enclosing element's
    // children array. The content/child rules inherit `r.node` from the
    // parent element, so `r.node.children` is the enclosing element's
    // child list.
    '@child-text': (r: Rule) => {
      r.node.children.push(r.o0.val)
      r.u.done = true
    },

    // After the child rule returns (either from a text match above or
    // from a nested `element` push), copy the nested element node into
    // the parent element's children. Text was already pushed in open.
    '@child-bc': (r: Rule) => {
      if (true !== r.u.done && r.child && r.child.node) {
        r.node.children.push(r.child.node)
      }
    },

    // Condition: close of element is trivially met when it was a
    // self-closing tag (`<name/>`) with no separate close tag to match.
    '@element-is-selfclosed': (r: Rule) => true === !!r.u.selfclose,
  }

  // Parse embedded grammar definition using a separate standard Jsonic
  // instance, then wire refs and apply.
  const grammarDef = Jsonic.make()(grammarText)
  grammarDef.ref = refs
  jsonic.grammar(grammarDef)
}


// The five predefined XML entities.
const predefinedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

// Build an entity-decoding function. Decodes the five predefined
// entities, numeric character references (`&#NN;` decimal and `&#xNN;`
// hex), plus any user-supplied custom entities.
function buildEntityDecoder(options: XmlOptions) {
  const entities = {
    ...predefinedEntities,
    ...(options?.customEntities || {}),
  }
  const entityRE = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][A-Za-z0-9_]*);/g

  return function decodeEntities(src: string): string {
    if (src.indexOf('&') < 0) return src
    return src.replace(entityRE, (match, ref) => {
      if (ref[0] === '#') {
        const code =
          ref[1] === 'x' || ref[1] === 'X'
            ? parseInt(ref.substring(2), 16)
            : parseInt(ref.substring(1), 10)
        if (isNaN(code)) return match
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      return undefined !== entities[ref] ? entities[ref] : match
    })
  }
}


// Build a lexer matcher that recognises all top-level XML constructs
// starting with `<`:
//   <name attr="v" ...>     -> #XOP  val = { name, attributes }
//   <name attr="v" ... />   -> #XSC  val = { name, attributes }
//   </name>                 -> #XCL  val = name
//   <!-- comment -->        -> #XIG  (parser ignores)
//   <?target ...?>          -> #XIG  (parser ignores)
//   <!DOCTYPE ...>          -> #XIG  (parser ignores)
//   <![CDATA[ ... ]]>       -> #TX   (verbatim text, no entity decoding)
function buildXmlTagMatcher(
  decodeEntity: (src: string) => string,
) {
  const isNameStart = (ch: string) =>
    /[A-Za-z_:]/.test(ch)
  const isNameChar = (ch: string) =>
    /[A-Za-z0-9_\-\.:]/.test(ch)
  const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

  return function makeXmlTagMatcher(_cfg: Config, _opts: Options) {
    return function xmlTagMatcher(lex: Lex) {
      const { pnt, src } = lex
      const sI = pnt.sI
      if (src[sI] !== '<') return undefined

      // Comment: <!-- ... -->
      if (src.startsWith('<!--', sI)) {
        const endIdx = src.indexOf('-->', sI + 4)
        if (endIdx === -1) {
          return lex.bad('unterminated_comment', sI, src.length)
        }
        const end = endIdx + 3
        const tkn = lex.token('#XIG', src.substring(sI, end), src.substring(sI, end), pnt)
        pnt.sI = end
        pnt.cI += end - sI
        return tkn
      }

      // CDATA: <![CDATA[ ... ]]>
      if (src.startsWith('<![CDATA[', sI)) {
        const endIdx = src.indexOf(']]>', sI + 9)
        if (endIdx === -1) {
          return lex.bad('unterminated_cdata', sI, src.length)
        }
        const end = endIdx + 3
        const text = src.substring(sI + 9, endIdx)
        const tkn = lex.token('#TX', text, src.substring(sI, end), pnt)
        pnt.sI = end
        pnt.cI += end - sI
        return tkn
      }

      // DOCTYPE: <!DOCTYPE ... [possibly with [...] subset ]>
      if (src.startsWith('<!DOCTYPE', sI)) {
        let i = sI + 9
        let depth = 0
        while (i < src.length) {
          const ch = src[i]
          if (ch === '[') depth++
          else if (ch === ']') depth--
          else if (ch === '>' && depth <= 0) break
          i++
        }
        if (i >= src.length) {
          return lex.bad('unterminated_doctype', sI, src.length)
        }
        const end = i + 1
        const tkn = lex.token('#XIG', src.substring(sI, end), src.substring(sI, end), pnt)
        pnt.sI = end
        pnt.cI += end - sI
        return tkn
      }

      // Processing instruction: <? ... ?>  (including <?xml ...?> decl)
      if (src[sI + 1] === '?') {
        const endIdx = src.indexOf('?>', sI + 2)
        if (endIdx === -1) {
          return lex.bad('unterminated_pi', sI, src.length)
        }
        const end = endIdx + 2
        const tkn = lex.token('#XIG', src.substring(sI, end), src.substring(sI, end), pnt)
        pnt.sI = end
        pnt.cI += end - sI
        return tkn
      }

      // Closing tag: </name>
      if (src[sI + 1] === '/') {
        let i = sI + 2
        const nameStart = i
        if (i >= src.length || !isNameStart(src[i])) return undefined
        i++
        while (i < src.length && isNameChar(src[i])) i++
        const name = src.substring(nameStart, i)
        while (i < src.length && isSpace(src[i])) i++
        if (src[i] !== '>') {
          return lex.bad('xml_invalid_tag', sI, i + 1)
        }
        const end = i + 1
        const tkn = lex.token('#XCL', name, src.substring(sI, end), pnt)
        pnt.sI = end
        pnt.cI += end - sI
        return tkn
      }

      // Opening or self-close tag: <name attr="v" .../>
      let i = sI + 1
      const nameStart = i
      if (i >= src.length || !isNameStart(src[i])) return undefined
      i++
      while (i < src.length && isNameChar(src[i])) i++
      const name = src.substring(nameStart, i)
      const attributes: Record<string, string> = {}

      // Parse zero or more attributes.
      while (true) {
        const wsStart = i
        while (i < src.length && isSpace(src[i])) i++

        if (i >= src.length) {
          return lex.bad('xml_invalid_tag', sI, src.length)
        }

        // End of tag.
        if (src[i] === '>') {
          const end = i + 1
          const tkn = lex.token('#XOP', { name, attributes }, src.substring(sI, end), pnt)
          pnt.sI = end
          pnt.cI += end - sI
          return tkn
        }
        if (src[i] === '/' && src[i + 1] === '>') {
          const end = i + 2
          const tkn = lex.token('#XSC', { name, attributes }, src.substring(sI, end), pnt)
          pnt.sI = end
          pnt.cI += end - sI
          return tkn
        }

        // An attribute must follow, preceded by whitespace.
        if (wsStart === i) {
          return lex.bad('xml_invalid_tag', sI, i + 1)
        }

        // Attribute name.
        const attrStart = i
        if (!isNameStart(src[i])) {
          return lex.bad('xml_invalid_tag', sI, i + 1)
        }
        i++
        while (i < src.length && isNameChar(src[i])) i++
        const attrName = src.substring(attrStart, i)

        while (i < src.length && isSpace(src[i])) i++
        if (src[i] !== '=') {
          return lex.bad('xml_invalid_tag', sI, i + 1)
        }
        i++
        while (i < src.length && isSpace(src[i])) i++

        const quote = src[i]
        if (quote !== '"' && quote !== "'") {
          return lex.bad('xml_invalid_tag', sI, i + 1)
        }
        i++
        const valStart = i
        while (i < src.length && src[i] !== quote) i++
        if (i >= src.length) {
          return lex.bad('xml_invalid_tag', sI, src.length)
        }
        const rawVal = src.substring(valStart, i)
        i++ // consume closing quote

        attributes[attrName] = decodeEntity(rawVal)
      }
    }
  }
}


// Resolve namespaces on an element tree. Walks the tree maintaining a
// scope map of `prefix` -> `namespace URI`. The empty string key is the
// default namespace. Mutates each element to add `prefix`, `localName`
// and `namespace` where applicable.
function resolveNamespaces(
  element: XmlElement,
  scope: Record<string, string>,
) {
  const localScope: Record<string, string> = { ...scope }

  // Apply xmlns bindings from this element's attributes.
  for (const key of Object.keys(element.attributes || {})) {
    const val = element.attributes[key]
    if (key === 'xmlns') {
      localScope[''] = val
    } else if (key.startsWith('xmlns:')) {
      localScope[key.substring(6)] = val
    }
  }

  const colonIdx = element.name.indexOf(':')
  if (colonIdx >= 0) {
    const prefix = element.name.substring(0, colonIdx)
    element.prefix = prefix
    element.localName = element.name.substring(colonIdx + 1)
    if (localScope[prefix]) {
      element.namespace = localScope[prefix]
    }
  } else {
    element.localName = element.name
    if (localScope['']) {
      element.namespace = localScope['']
    }
  }

  for (const child of element.children) {
    if (child && 'object' === typeof child) {
      resolveNamespaces(child, localScope)
    }
  }
}


Xml.defaults = {
  namespaces: true,
  entities: true,
  customEntities: {},
} as XmlOptions

export { Xml }

export type { XmlOptions, XmlElement }
