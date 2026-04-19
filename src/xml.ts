/* Copyright (c) 2021-2025 Richard Rodger, MIT License */

// Import Jsonic types used by plugins.
import {
  Jsonic,
  Rule,
  RuleSpec,
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
  // Embed mode. When `false` (default), the plugin configures the parser
  // for pure-XML input: the start rule becomes `xml`, JSON structural
  // tokens are disabled, and all non-XML lexing is turned off.
  //
  // When `true`, the plugin leaves Jsonic's JSON/JSONIC rules in place
  // and adds an alternate to the `val` rule so that a literal XML
  // element (`<tag>…</tag>` or `<tag/>`) appears wherever Jsonic
  // expects a value. The XML literal is parsed with the same element
  // grammar used in pure mode.
  embed: boolean
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
  const embed = options.embed === true
  const decodeEntity = buildEntityDecoder(options)

  // Register custom lexer matcher. The same matcher is used in both
  // modes; in embed mode it additionally consumes text between tags so
  // Jsonic's own text/fixed lexers don't split it on `,` `:` etc.
  jsonic.options({
    lex: {
      match: {
        xmltag: {
          order: 1e5,
          make: buildXmlTagMatcher(decodeEntity, embed, options),
        },
      },
      emptyResult: undefined,
    },
    // Terminate Jsonic text at `<` so XML tag starts are not absorbed
    // into Jsonic text runs.
    ender: ['<'],
  })

  if (!embed) {
    // Pure XML mode: reconfigure the parser so Jsonic's own value
    // grammar is unreachable and all lexers other than our tag matcher
    // are quiescent.
    //
    // Note: we deliberately do NOT install a `text.modify` hook here.
    // While the root element is open the custom matcher itself emits
    // the text tokens (with entity decoding and well-formedness
    // checks); Jsonic's text matcher only sees whitespace before the
    // root and after it, where no decoding is needed.
    jsonic.options({
      rule: {
        start: 'xml',
        exclude: 'jsonic,imp',
      },
      fixed: {
        token: {
          '#OB': null, '#CB': null, '#OS': null, '#CS': null,
          '#CL': null, '#CA': null,
        },
      },
      tokenSet: {
        IGNORE: ['#SP', '#LN', '#CM', '#XIG'],
      },
      number:  { lex: false },
      value:   { lex: false },
      string:  { lex: false },
      comment: { lex: false },
      space:   { lex: false },
      line:    { lex: false },
    })
  } else {
    // Embed mode: keep all of Jsonic's standard grammar. Still register
    // #XIG for comments/PIs/DOCTYPE and add it to IGNORE.
    jsonic.options({
      tokenSet: {
        IGNORE: ['#SP', '#LN', '#CM', '#XIG'],
      },
    })
  }

  // Error templates and hints are installed in both modes.
  jsonic.options({
    error: {
      xml_mismatched_tag:
        'closing tag </$fsrc> does not match opening tag <$openname>',
      xml_invalid_tag: 'invalid tag: $fsrc',
      xml_unterminated: 'unterminated $kind',
      comment_double_dash: 'comment body cannot contain "--"',
      cdata_terminator_in_text: 'character data cannot contain "]]>"',
      pi_target_invalid: 'processing instruction target is missing or invalid',
      lt_in_attr_value: '"<" is not allowed in an attribute value',
      bad_entity_ref: 'malformed entity reference (need &name; or &#NNN; or &#xHHH;)',
      duplicate_attribute: 'duplicate attribute name in tag',
    },
    hint: {
      xml_mismatched_tag: `Each opening tag must be paired with a matching closing tag.
Expected </$openname> but found </$fsrc>.`,
      xml_invalid_tag: `The tag syntax is not valid XML.`,
      xml_unterminated: `The $kind starting at this position is not terminated.`,
      comment_double_dash: `XML 1.0 disallows "--" inside a comment body.`,
      cdata_terminator_in_text: `The literal "]]>" must only appear as the end of a CDATA section.`,
      pi_target_invalid: `A processing instruction must start with a Name; the XML declaration <?xml...?> is the special case.`,
      lt_in_attr_value: `Use the entity reference &lt; to include "<" in an attribute value.`,
      bad_entity_ref: `Replace literal "&" with &amp;, or terminate the entity reference with ";".`,
      duplicate_attribute: `Each attribute name in an open tag must be unique.`,
    },
  })

  const refs: Record<string, Function> = {
    '@xml-bc': (r: Rule, ctx: Context) => {
      if (r.child && r.child.node) {
        const root = ctx.root()
        root.node = r.child.node
        if (options.namespaces !== false) {
          resolveNamespaces(root.node, {})
        }
      }
    },

    '@element-open': (r: Rule) => {
      const v = r.o0.val
      r.node = {
        name: v.name,
        localName: v.name,
        attributes: v.attributes,
        children: [],
      }
    },

    '@element-selfclose': (r: Rule) => {
      const v = r.o0.val
      r.node = {
        name: v.name,
        localName: v.name,
        attributes: v.attributes,
        children: [],
      }
    },

    '@element-close': (r: Rule, ctx: Context) => {
      const openName = r.node && r.node.name
      const closeName = r.c0.val
      if (openName !== closeName) {
        r.c0.use = { openname: openName }
        return ctx.t0.bad('xml_mismatched_tag')
      }
    },

    '@child-text': (r: Rule) => {
      r.node.children.push(r.o0.val)
      r.u.done = true
    },

    '@child-bc': (r: Rule) => {
      if (true !== r.u.done && r.child && r.child.node) {
        r.node.children.push(r.child.node)
      }
    },

    '@element-is-selfclosed': (r: Rule) => true === !!r.u.selfclose,
  }

  // Parse embedded grammar definition and wire refs.
  const grammarDef = Jsonic.make()(grammarText)
  grammarDef.ref = refs
  jsonic.grammar(grammarDef)

  if (embed) {
    // Splice XML literals into the Jsonic `val` rule. When the parser
    // is looking for a value and sees an `#XOP` or `#XSC` token, it
    // pushes the `element` rule which builds the XML subtree. Backtrack
    // by 1 so `element.open` can read the same token and dispatch to
    // the correct branch.
    const XOP = jsonic.token('#XOP')
    const XSC = jsonic.token('#XSC')
    jsonic.rule('val', (rs: RuleSpec) => {
      return rs.open(
        [
          { s: [XOP], b: 1, p: 'element', g: 'xml' },
          { s: [XSC], b: 1, p: 'element', g: 'xml' },
        ],
      )
    })

    // In embed mode the top-level wrapper is Jsonic's `val` rule, so
    // the `@xml-bc` hook that copies the root element to `ctx.root().node`
    // is not invoked. Resolve namespaces after the full tree lands on
    // the element rule by hooking its close-state action.
    if (options.namespaces !== false) {
      jsonic.rule('element', (rs: RuleSpec) => {
        rs.bc((r: Rule) => {
          if (r.node && 'object' === typeof r.node && r.parent &&
              r.parent.name === 'val') {
            resolveNamespaces(r.node, {})
          }
        })
      })
    }
  }
}


// The five predefined XML entities.
const predefinedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

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
// starting with `<`. In embed mode the matcher also claims any text
// between an open tag and its matching close tag so that Jsonic's own
// text/fixed matchers don't split XML character data on JSON-syntax
// characters (`,`, `:`, etc.).
//
// Emits one of:
//   <name attr="v" ...>     -> #XOP  val = { name, attributes }
//   <name attr="v" ... />   -> #XSC  val = { name, attributes }
//   </name>                 -> #XCL  val = name
//   <!-- comment -->        -> #XIG  (parser ignores)
//   <?target ...?>          -> #XIG  (parser ignores)
//   <!DOCTYPE ...>          -> #XIG  (parser ignores)
//   <![CDATA[ ... ]]>       -> #TX   (verbatim text, no entity decoding)
function buildXmlTagMatcher(
  decodeEntity: (src: string) => string,
  embed: boolean,
  options: XmlOptions,
) {
  const isNameStart = (ch: string) =>
    /[A-Za-z_:]/.test(ch)
  const isNameChar = (ch: string) =>
    /[A-Za-z0-9_\-\.:]/.test(ch)
  const isSpace = (ch: string) =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

  // Validate and decode a run of character data (non-CDATA). Enforces
  // the XML 1.0 well-formedness constraints applicable to text:
  //   - the literal sequence "]]>" must not appear in character data;
  //   - every "&" must start a well-formed entity reference.
  // Returns either { val: string } on success or { err: string } if a
  // WF constraint is violated. Pure decoding (without validation) is
  // also available for CDATA bodies via decodeEntity().
  function processText(raw: string): { val?: string; err?: string } {
    if (raw.indexOf(']]>') >= 0) {
      return { err: 'cdata_terminator_in_text' }
    }
    const ampErr = checkEntityRefs(raw)
    if (ampErr) return { err: ampErr }
    return {
      val: options.entities !== false ? decodeEntity(raw) : raw,
    }
  }

  return function makeXmlTagMatcher(_cfg: Config, _opts: Options) {
    return function xmlTagMatcher(lex: Lex) {
      const { pnt, src } = lex
      const sI = pnt.sI

      // Inside an open XML element (depth > 0), consume characters up
      // to the next `<` as a single #TX text token so that Jsonic's
      // own matchers don't reinterpret commas/colons/etc. as JSON
      // separators in embed mode, and so we can apply XML text
      // validation in pure mode too.
      if (sI < src.length && src[sI] !== '<') {
        const depth = (lex.ctx?.u?.xmlDepth | 0) || 0
        if (depth > 0) {
          let i = sI
          while (i < src.length && src[i] !== '<') i++
          if (i === sI) return undefined
          const raw = src.substring(sI, i)
          const result = processText(raw)
          if (result.err) {
            return lex.bad(result.err, sI, i)
          }
          const tkn = lex.token('#TX', result.val, raw, pnt)
          pnt.sI = i
          pnt.cI += i - sI
          return tkn
        }
      }

      if (sI >= src.length || src[sI] !== '<') return undefined

      // Comment: <!-- ... -->
      if (src.startsWith('<!--', sI)) {
        const endIdx = src.indexOf('-->', sI + 4)
        if (endIdx === -1) {
          return lex.bad('unterminated_comment', sI, src.length)
        }
        // WF constraint: "--" must not occur in a comment body.
        const body = src.substring(sI + 4, endIdx)
        if (body.indexOf('--') >= 0) {
          return lex.bad('comment_double_dash', sI, endIdx + 3)
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

      // DOCTYPE: <!DOCTYPE ... [...] >
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

      // Processing instruction: <? ... ?>
      if (src[sI + 1] === '?') {
        const endIdx = src.indexOf('?>', sI + 2)
        if (endIdx === -1) {
          return lex.bad('unterminated_pi', sI, src.length)
        }
        // WF constraint: PI target must be a Name (and not empty).
        let i = sI + 2
        if (i >= src.length || !isNameStart(src[i])) {
          return lex.bad('pi_target_invalid', sI, endIdx + 2)
        }
        i++
        while (i < endIdx && isNameChar(src[i])) i++
        // After the target, only whitespace then content is allowed.
        if (i < endIdx && !isSpace(src[i])) {
          return lex.bad('pi_target_invalid', sI, endIdx + 2)
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
        // WF: empty close tag `</>` is invalid.
        if (i >= src.length || !isNameStart(src[i])) {
          return lex.bad('xml_invalid_tag', sI, Math.min(src.length, i + 1))
        }
        const nameStart = i
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
        if (lex.ctx) {
          const u: any = lex.ctx.u || (lex.ctx.u = {})
          u.xmlDepth = Math.max(0, (u.xmlDepth | 0) - 1)
        }
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

      while (true) {
        const wsStart = i
        while (i < src.length && isSpace(src[i])) i++
        if (i >= src.length) {
          return lex.bad('xml_invalid_tag', sI, src.length)
        }

        if (src[i] === '>') {
          const end = i + 1
          const tkn = lex.token('#XOP', { name, attributes }, src.substring(sI, end), pnt)
          pnt.sI = end
          pnt.cI += end - sI
          if (lex.ctx) {
            const u: any = lex.ctx.u || (lex.ctx.u = {})
            u.xmlDepth = (u.xmlDepth | 0) + 1
          }
          return tkn
        }
        if (src[i] === '/' && src[i + 1] === '>') {
          const end = i + 2
          const tkn = lex.token('#XSC', { name, attributes }, src.substring(sI, end), pnt)
          pnt.sI = end
          pnt.cI += end - sI
          // #XSC is an instantly-closed element, so depth is unchanged.
          return tkn
        }

        if (wsStart === i) {
          return lex.bad('xml_invalid_tag', sI, i + 1)
        }

        if (!isNameStart(src[i])) {
          return lex.bad('xml_invalid_tag', sI, i + 1)
        }
        const attrStart = i
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
        // Per the XML 1.0 spec, attribute values cannot contain a
        // literal `<`. Tracking the position lets us also validate
        // entity references in the value.
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '<') {
            return lex.bad('lt_in_attr_value', sI, i + 1)
          }
          i++
        }
        if (i >= src.length) {
          return lex.bad('xml_invalid_tag', sI, src.length)
        }
        const rawVal = src.substring(valStart, i)
        i++

        const ampErr = checkEntityRefs(rawVal)
        if (ampErr) {
          return lex.bad(ampErr, valStart, i)
        }
        if (Object.prototype.hasOwnProperty.call(attributes, attrName)) {
          return lex.bad('duplicate_attribute', sI, i)
        }
        attributes[attrName] = decodeEntity(rawVal)
      }
    }
  }
}


// Validate entity references in a run of character data. Returns an
// error code on the first malformed reference, or '' if every `&`
// in the input is part of a well-formed reference.
//
// Well-formed forms:
//   &name;       — name must start with a NameStartChar
//   &#nnnn;      — decimal numeric character reference
//   &#xhhhh;     — hexadecimal numeric character reference
function checkEntityRefs(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '&') continue
    const semi = s.indexOf(';', i + 1)
    if (semi < 0) return 'bad_entity_ref'
    const ref = s.substring(i + 1, semi)
    if (ref.length === 0) return 'bad_entity_ref'
    if (ref[0] === '#') {
      if (ref.length < 2) return 'bad_entity_ref'
      const digits = ref[1] === 'x' || ref[1] === 'X'
        ? ref.substring(2)
        : ref.substring(1)
      if (digits.length === 0) return 'bad_entity_ref'
      const valid = ref[1] === 'x' || ref[1] === 'X'
        ? /^[0-9a-fA-F]+$/.test(digits)
        : /^[0-9]+$/.test(digits)
      if (!valid) return 'bad_entity_ref'
    } else {
      if (!/^[A-Za-z_:][A-Za-z0-9_\-\.:]*$/.test(ref)) return 'bad_entity_ref'
    }
    i = semi
  }
  return ''
}


// Resolve namespaces on an element tree. Walks the tree maintaining a
// scope map of `prefix` -> `namespace URI`. The empty-string key holds
// the default namespace.
function resolveNamespaces(
  element: XmlElement,
  scope: Record<string, string>,
) {
  const localScope: Record<string, string> = { ...scope }

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
  embed: false,
} as XmlOptions

export { Xml }

export type { XmlOptions, XmlElement }
