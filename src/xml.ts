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

// A parsed XML element: a tag name and an array of children.
// Children are either strings (text nodes) or nested Element objects.
type XmlElement = {
  name: string
  children: Array<XmlElement | string>
}

type XmlOptions = {
  // Reserved for future options.
}

// --- BEGIN EMBEDDED xml-grammar.jsonic ---
const grammarText = `
# XML Grammar Definition (simple element-only version)
# Parsed by a standard Jsonic instance and passed to jsonic.grammar()
# Function references (@ prefixed) are resolved against the refs map
#
# Token naming:
#   #XOP - XML open tag, e.g. <tagname>
#   #XCL - XML close tag, e.g. </tagname>
#   #XSC - XML self-close tag, e.g. <tagname/>
#   #TX  - text content between tags
#   #ZZ  - end of input

{
  rule: xml: open: [
    { s: '#ZZ' }
    { p: element }
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


const Xml: Plugin = (jsonic: Jsonic, _options: XmlOptions) => {
  // Register custom lexer matcher for XML tags so that `<tag>`, `</tag>`,
  // and `<tag/>` are each recognised as a single token with the tag name
  // as the token value.
  jsonic.options({
    lex: {
      match: {
        xmltag: { order: 1e5, make: buildXmlTagMatcher() },
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
    error: {
      xml_mismatched_tag:
        'closing tag </$fsrc> does not match opening tag <$openname>',
    },
    hint: {
      xml_mismatched_tag: `Each opening tag must be paired with a matching closing tag.
Expected </$openname> but found </$fsrc>.`,
    },
  })

  const refs: Record<string, Function> = {
    // Propagate the parsed root element up to the xml rule so it becomes
    // the final parse result.
    '@xml-bc': (r: Rule) => {
      if (r.child && r.child.node) {
        r.node = r.child.node
      }
    },

    // Initialise the element node when the opening tag `<name>` is matched.
    '@element-open': (r: Rule) => {
      r.node = { name: r.o0.val, children: [] }
    },

    // Self-closing tag `<name/>` - no children.
    '@element-selfclose': (r: Rule) => {
      r.node = { name: r.o0.val, children: [] }
    },

    // Verify that `</name>` matches the opening `<name>`.
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


// Build a lexer matcher that recognises XML tags as single tokens.
// Emits one of:
//   #XOP  for `<name>`     (val = name)
//   #XCL  for `</name>`    (val = name)
//   #XSC  for `<name/>`    (val = name)
function buildXmlTagMatcher() {
  const nameRE = `[A-Za-z_][A-Za-z0-9_\\-\\.:]*`
  const openRE = new RegExp('^<(' + nameRE + ')\\s*(\\/?)>')
  const closeRE = new RegExp('^<\\/(' + nameRE + ')\\s*>')

  return function makeXmlTagMatcher(_cfg: Config, _opts: Options) {
    return function xmlTagMatcher(lex: Lex) {
      const { pnt, src } = lex
      const sI = pnt.sI
      if (src[sI] !== '<') return undefined

      const rest = src.substring(sI)

      // Closing tag: </name>
      if (src[sI + 1] === '/') {
        const m = rest.match(closeRE)
        if (!m) return undefined
        const len = m[0].length
        const tkn = lex.token('#XCL', m[1], m[0], pnt)
        pnt.sI += len
        pnt.cI += len
        return tkn
      }

      // Opening or self-close tag: <name> or <name/>
      const m = rest.match(openRE)
      if (!m) return undefined
      const len = m[0].length
      const selfClose = m[2] === '/'
      const tkn = lex.token(selfClose ? '#XSC' : '#XOP', m[1], m[0], pnt)
      pnt.sI += len
      pnt.cI += len
      return tkn
    }
  }
}


Xml.defaults = {} as XmlOptions

export { Xml }

export type { XmlOptions, XmlElement }
