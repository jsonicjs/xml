// Copyright (c) 2021-2025 Richard Rodger, MIT License

// Package xml is a Jsonic plugin that parses XML into a tree of
// elements. The parser supports: elements with open/close and
// self-closing tags, attributes (single and double quoted with entity
// decoding), mixed element/text content, predefined and numeric
// character entity references, namespace resolution from xmlns/xmlns:*
// declarations, comments, CDATA sections, processing instructions and
// DOCTYPE declarations.
//
// The returned tree uses `map[string]any` nodes with keys `name`,
// `localName`, optional `prefix`, optional `namespace`, `attributes`
// (map of string -> string) and `children` (array of nested elements
// or text strings).
package xml

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	jsonic "github.com/jsonicjs/jsonic/go"
)

const Version = "0.1.0"

// Defaults are merged with caller-supplied options when the plugin is
// registered via jsonic.UseDefaults.
var Defaults = map[string]any{
	"namespaces":     true,
	"entities":       true,
	"customEntities": map[string]string{},
}

// Xml is the Jsonic plugin entry point. Register via:
//
//	j := jsonic.Make()
//	j.UseDefaults(xml.Xml, xml.Defaults)
//	result, err := j.Parse(src)
func Xml(j *jsonic.Jsonic, options map[string]any) error {
	// Guard against re-invocation: Use() re-runs plugins on SetOptions calls.
	if j.Decoration("xml-init") != nil {
		return nil
	}
	j.Decorate("xml-init", true)

	namespacesOn := toBool(options["namespaces"], true)
	entitiesOn := toBool(options["entities"], true)
	customEntities := toStringMap(options["customEntities"])

	decode := buildEntityDecoder(entitiesOn, customEntities)

	// Reserve #XIG (ignored) and #XOP/#XCL/#XSC (tag tokens) so they have
	// stable tins before the grammar references them. The tins are then
	// passed to the tag matcher by closure.
	xigTin := j.Token("#XIG", "")
	xopTin := j.Token("#XOP", "")
	xclTin := j.Token("#XCL", "")
	xscTin := j.Token("#XSC", "")

	// Register a dummy fixed token bound to a character that cannot
	// legally appear in XML source (ASCII SOH). This keeps the lexer's
	// internal `FixedSorted` list non-empty, which in turn disables an
	// otherwise-hardcoded fallback that still ends text tokens on any
	// of `{ } [ ] : ,` even when those symbols have been removed from
	// the fixed token map. Without this, XML text content containing a
	// comma would be truncated at the comma.
	soh := "\x01"
	_ = j.Token("#XDUM", soh)

	// Custom lexer matcher registered at low priority so it runs before
	// the built-in text/fixed matchers and captures every `<...>`
	// construct as a single token.
	j.SetOptions(jsonic.Options{
		Lex: &jsonic.LexOptions{
			Match: map[string]*jsonic.MatchSpec{
				"xmltag": {Order: 100_000, Make: buildXmlTagMatcher(decode, xigTin, xopTin, xclTin, xscTin)},
			},
		},
		Ender: []string{"<"},
		Rule: &jsonic.RuleOptions{
			Start:   "xml",
			Exclude: "jsonic,imp",
		},
		Fixed: &jsonic.FixedOptions{Token: map[string]*string{
			"#OB": nil, "#CB": nil, "#OS": nil, "#CS": nil,
			"#CL": nil, "#CA": nil,
		}},
		Number:  &jsonic.NumberOptions{Lex: boolPtr(false)},
		Value:   &jsonic.ValueOptions{Lex: boolPtr(false)},
		String:  &jsonic.StringOptions{Lex: boolPtr(false)},
		Comment: &jsonic.CommentOptions{Lex: boolPtr(false)},
		Space:   &jsonic.SpaceOptions{Lex: boolPtr(false)},
		Line:    &jsonic.LineOptions{Lex: boolPtr(false)},
		Text: &jsonic.TextOptions{
			Modify: []jsonic.ValModifier{func(v any) any {
				if s, ok := v.(string); ok && entitiesOn {
					return decode(s)
				}
				return v
			}},
		},
		Error: map[string]string{
			"xml_mismatched_tag": "closing tag </$fsrc> does not match opening tag <$openname>",
			"xml_invalid_tag":    "invalid tag: $fsrc",
			"xml_unterminated":   "unterminated $kind",
		},
		Hint: map[string]string{
			"xml_mismatched_tag": "Each opening tag must be paired with a matching closing tag.\nExpected </$openname> but found </$fsrc>.",
			"xml_invalid_tag":    "The tag syntax is not valid XML.",
			"xml_unterminated":   "The $kind starting at this position is not terminated.",
		},
	})

	// IGNORE set: drop #XIG (comments, PIs, DOCTYPE) along with the
	// default members so any of them is skipped by the parser.
	j.SetTokenSet("IGNORE", []jsonic.Tin{
		j.Token("#SP", ""), j.Token("#LN", ""), j.Token("#CM", ""), xigTin,
	})

	// Grammar declarations. Mirror the TypeScript grammar exactly.
	refs := map[jsonic.FuncRef]any{
		"@xml-bc": jsonic.StateAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if r.Child == nil || r.Child == jsonic.NoRule || r.Child.Node == nil {
				return
			}
			// The Go parser follows the Next chain forward from the root
			// rule to find the final result holder, so the current rule's
			// node is what the caller will see. Set it (and the original
			// root's node via the Prev chain as well for safety).
			r.Node = r.Child.Node
			root := firstRule(r)
			root.Node = r.Child.Node
			if namespacesOn {
				if el, ok := r.Node.(map[string]any); ok {
					resolveNamespaces(el, nil)
				}
			}
		}),

		"@element-open": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			v := r.O0.Val.(map[string]any)
			name := v["name"].(string)
			attrs := v["attributes"].(map[string]any)
			r.Node = map[string]any{
				"name":       name,
				"localName":  name,
				"attributes": attrs,
				"children":   []any{},
			}
		}),

		"@element-selfclose": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			v := r.O0.Val.(map[string]any)
			name := v["name"].(string)
			attrs := v["attributes"].(map[string]any)
			r.Node = map[string]any{
				"name":       name,
				"localName":  name,
				"attributes": attrs,
				"children":   []any{},
			}
		}),

		"@element-close": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			el, _ := r.Node.(map[string]any)
			openName, _ := el["name"].(string)
			closeName, _ := r.C0.Val.(string)
			if openName != closeName {
				// The Go parser's top-level error handling reports parse
				// errors under a single "unexpected" code, so encode our
				// specific error code into the token's `Src`: that string
				// is substituted into the error detail via $fsrc and will
				// appear in err.Error() for consumers (and tests) that
				// want to key on the specific cause.
				r.C0.Src = "xml_mismatched_tag: </" + closeName + "> does not match <" + openName + ">"
				if r.C0.Use == nil {
					r.C0.Use = map[string]any{}
				}
				r.C0.Use["openname"] = openName
				r.C0.Err = "xml_mismatched_tag"
				ctx.ParseErr = r.C0
			}
		}),

		"@child-text": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			el, _ := r.Node.(map[string]any)
			children, _ := el["children"].([]any)
			el["children"] = append(children, r.O0.Val)
			r.U["done"] = true
		}),

		"@child-bc": jsonic.StateAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if done, _ := r.U["done"].(bool); done {
				return
			}
			if r.Child == nil || r.Child == jsonic.NoRule || r.Child.Node == nil {
				return
			}
			el, ok := r.Node.(map[string]any)
			if !ok {
				return
			}
			children, _ := el["children"].([]any)
			el["children"] = append(children, r.Child.Node)
		}),

		"@element-is-selfclosed": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			v, _ := r.U["selfclose"].(int)
			return v == 1
		}),
	}

	gs := &jsonic.GrammarSpec{
		Ref: refs,
		Rule: map[string]*jsonic.GrammarRuleSpec{
			"xml": {
				Open: []*jsonic.GrammarAltSpec{
					{S: "#ZZ"},
					{S: "#TX", R: "xml"},
					{P: "element"},
				},
				Close: []*jsonic.GrammarAltSpec{
					{S: "#ZZ"},
					{S: "#TX", R: "xml"},
				},
			},
			"element": {
				Open: []*jsonic.GrammarAltSpec{
					{S: "#XSC", A: "@element-selfclose", U: map[string]any{"selfclose": 1}},
					{S: "#XOP", P: "content", A: "@element-open"},
				},
				Close: []*jsonic.GrammarAltSpec{
					{C: "@element-is-selfclosed"},
					{S: "#XCL", A: "@element-close"},
				},
			},
			"content": {
				Open: []*jsonic.GrammarAltSpec{
					{S: "#XCL", B: 1},
					{P: "child"},
				},
				Close: []*jsonic.GrammarAltSpec{
					{S: "#XCL", B: 1},
					{R: "content"},
				},
			},
			"child": {
				Open: []*jsonic.GrammarAltSpec{
					{S: "#TX", A: "@child-text"},
					{S: "#XOP", B: 1, P: "element"},
					{S: "#XSC", B: 1, P: "element"},
				},
			},
		},
	}
	if err := j.Grammar(gs); err != nil {
		return fmt.Errorf("xml: apply grammar: %w", err)
	}

	return nil
}

// firstRule walks back through Prev links to find the originating rule
// instance (matches the root rule used by the parser as the result
// holder).
func firstRule(r *jsonic.Rule) *jsonic.Rule {
	cur := r
	for cur.Prev != nil && cur.Prev != jsonic.NoRule {
		cur = cur.Prev
	}
	return cur
}

// predefinedEntities is the five XML-predefined entities.
var predefinedEntities = map[string]string{
	"amp":  "&",
	"lt":   "<",
	"gt":   ">",
	"quot": "\"",
	"apos": "'",
}

// entityRE matches a single entity reference: named, decimal numeric, or
// hexadecimal numeric. (?:...) would be ideal but the Go stdlib regexp
// supports named groups; this uses plain groups for portability.
var entityRE = regexp.MustCompile(`&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][A-Za-z0-9_]*);`)

// buildEntityDecoder returns a function that decodes the five
// predefined entities, numeric character references, and any
// caller-supplied custom entities. When `enabled` is false the
// function is an identity.
func buildEntityDecoder(enabled bool, custom map[string]string) func(string) string {
	if !enabled {
		return func(s string) string { return s }
	}
	merged := make(map[string]string, len(predefinedEntities)+len(custom))
	for k, v := range predefinedEntities {
		merged[k] = v
	}
	for k, v := range custom {
		merged[k] = v
	}
	return func(s string) string {
		if !strings.Contains(s, "&") {
			return s
		}
		return entityRE.ReplaceAllStringFunc(s, func(match string) string {
			ref := match[1 : len(match)-1]
			if ref[0] == '#' {
				var code int64
				var err error
				if len(ref) > 1 && (ref[1] == 'x' || ref[1] == 'X') {
					code, err = strconv.ParseInt(ref[2:], 16, 32)
				} else {
					code, err = strconv.ParseInt(ref[1:], 10, 32)
				}
				if err != nil {
					return match
				}
				return string(rune(code))
			}
			if v, ok := merged[ref]; ok {
				return v
			}
			return match
		})
	}
}

// buildXmlTagMatcher returns a MakeLexMatcher that recognises every
// top-level XML `<...>` construct at the current lex position. On a
// successful match it consumes the full construct and emits exactly
// one of:
//
//	#XOP  <name attr="v" ...>      val = {"name":..., "attributes":...}
//	#XSC  <name attr="v" ... />    val = {"name":..., "attributes":...}
//	#XCL  </name>                  val = name (string)
//	#XIG  <!-- ... -->  |  <?...?>  |  <!DOCTYPE ...>  (ignored)
//	#TX   <![CDATA[ ... ]]>        val = cdata body (verbatim, no entity decoding)
func buildXmlTagMatcher(
	decode func(string) string,
	xigTin, xopTin, xclTin, xscTin jsonic.Tin,
) jsonic.MakeLexMatcher {
	return func(_ *jsonic.LexConfig, _ *jsonic.Options) jsonic.LexMatcher {
		return func(lex *jsonic.Lex, _ *jsonic.Rule) *jsonic.Token {
			pnt := lex.Cursor()
			src := lex.Src
			srclen := len(src)
			sI := pnt.SI
			if sI >= srclen || src[sI] != '<' {
				return nil
			}

			// Comment: <!-- ... -->
			if strings.HasPrefix(src[sI:], "<!--") {
				end := strings.Index(src[sI+4:], "-->")
				if end < 0 {
					return lex.Bad("unterminated_comment")
				}
				finish := sI + 4 + end + 3
				tsrc := src[sI:finish]
				tkn := lex.Token("#XIG", xigTin, tsrc, tsrc)
				advance(pnt, sI, finish)
				return tkn
			}

			// CDATA: <![CDATA[ ... ]]>
			if strings.HasPrefix(src[sI:], "<![CDATA[") {
				body := sI + 9
				end := strings.Index(src[body:], "]]>")
				if end < 0 {
					return lex.Bad("unterminated_cdata")
				}
				finish := body + end + 3
				text := src[body : body+end]
				tsrc := src[sI:finish]
				tkn := lex.Token("#TX", jsonic.TinTX, text, tsrc)
				advance(pnt, sI, finish)
				return tkn
			}

			// DOCTYPE: <!DOCTYPE ... [...] > (allows a single level of [] subset)
			if strings.HasPrefix(src[sI:], "<!DOCTYPE") {
				i := sI + 9
				depth := 0
				for i < srclen {
					ch := src[i]
					if ch == '[' {
						depth++
					} else if ch == ']' {
						depth--
					} else if ch == '>' && depth <= 0 {
						break
					}
					i++
				}
				if i >= srclen {
					return lex.Bad("unterminated_doctype")
				}
				finish := i + 1
				tsrc := src[sI:finish]
				tkn := lex.Token("#XIG", xigTin, tsrc, tsrc)
				advance(pnt, sI, finish)
				return tkn
			}

			// Processing instruction: <? ... ?>
			if sI+1 < srclen && src[sI+1] == '?' {
				end := strings.Index(src[sI+2:], "?>")
				if end < 0 {
					return lex.Bad("unterminated_pi")
				}
				finish := sI + 2 + end + 2
				tsrc := src[sI:finish]
				tkn := lex.Token("#XIG", xigTin, tsrc, tsrc)
				advance(pnt, sI, finish)
				return tkn
			}

			// Closing tag: </name>
			if sI+1 < srclen && src[sI+1] == '/' {
				i := sI + 2
				if i >= srclen || !isNameStart(src[i]) {
					return nil
				}
				nameStart := i
				i++
				for i < srclen && isNameChar(src[i]) {
					i++
				}
				name := src[nameStart:i]
				for i < srclen && isSpace(src[i]) {
					i++
				}
				if i >= srclen || src[i] != '>' {
					return lex.Bad("xml_invalid_tag")
				}
				finish := i + 1
				tsrc := src[sI:finish]
				tkn := lex.Token("#XCL", xclTin, name, tsrc)
				advance(pnt, sI, finish)
				return tkn
			}

			// Opening or self-close tag: <name attr="v" ... />
			i := sI + 1
			if i >= srclen || !isNameStart(src[i]) {
				return nil
			}
			nameStart := i
			i++
			for i < srclen && isNameChar(src[i]) {
				i++
			}
			name := src[nameStart:i]
			attrs := map[string]any{}

			for {
				wsStart := i
				for i < srclen && isSpace(src[i]) {
					i++
				}
				if i >= srclen {
					return lex.Bad("xml_invalid_tag")
				}

				// End of tag.
				if src[i] == '>' {
					finish := i + 1
					tsrc := src[sI:finish]
					val := map[string]any{"name": name, "attributes": attrs}
					tkn := lex.Token("#XOP", xopTin, val, tsrc)
					advance(pnt, sI, finish)
					return tkn
				}
				if src[i] == '/' && i+1 < srclen && src[i+1] == '>' {
					finish := i + 2
					tsrc := src[sI:finish]
					val := map[string]any{"name": name, "attributes": attrs}
					tkn := lex.Token("#XSC", xscTin, val, tsrc)
					advance(pnt, sI, finish)
					return tkn
				}

				// Attributes must be separated by whitespace.
				if wsStart == i {
					return lex.Bad("xml_invalid_tag")
				}

				// Attribute name.
				if !isNameStart(src[i]) {
					return lex.Bad("xml_invalid_tag")
				}
				attrStart := i
				i++
				for i < srclen && isNameChar(src[i]) {
					i++
				}
				attrName := src[attrStart:i]

				for i < srclen && isSpace(src[i]) {
					i++
				}
				if i >= srclen || src[i] != '=' {
					return lex.Bad("xml_invalid_tag")
				}
				i++
				for i < srclen && isSpace(src[i]) {
					i++
				}

				if i >= srclen {
					return lex.Bad("xml_invalid_tag")
				}
				quote := src[i]
				if quote != '"' && quote != '\'' {
					return lex.Bad("xml_invalid_tag")
				}
				i++
				valStart := i
				for i < srclen && src[i] != quote {
					i++
				}
				if i >= srclen {
					return lex.Bad("xml_invalid_tag")
				}
				raw := src[valStart:i]
				i++ // consume closing quote
				attrs[attrName] = decode(raw)
			}
		}
	}
}

// resolveNamespaces annotates `element` (and its descendants) with
// `prefix`, `localName` and `namespace` fields resolved from xmlns /
// xmlns:* attributes in scope.
func resolveNamespaces(element map[string]any, scope map[string]string) {
	local := make(map[string]string, len(scope)+4)
	for k, v := range scope {
		local[k] = v
	}
	if attrs, ok := element["attributes"].(map[string]any); ok {
		for k, v := range attrs {
			s, _ := v.(string)
			if k == "xmlns" {
				local[""] = s
			} else if strings.HasPrefix(k, "xmlns:") {
				local[k[6:]] = s
			}
		}
	}

	name, _ := element["name"].(string)
	if idx := strings.Index(name, ":"); idx >= 0 {
		prefix := name[:idx]
		element["prefix"] = prefix
		element["localName"] = name[idx+1:]
		if uri, ok := local[prefix]; ok {
			element["namespace"] = uri
		}
	} else {
		element["localName"] = name
		if uri, ok := local[""]; ok {
			element["namespace"] = uri
		}
	}

	children, _ := element["children"].([]any)
	for _, c := range children {
		if ce, ok := c.(map[string]any); ok {
			resolveNamespaces(ce, local)
		}
	}
}

// --- helpers ---

func advance(pnt *jsonic.Point, from, to int) {
	pnt.SI = to
	pnt.CI += to - from
}

func isNameStart(ch byte) bool {
	return (ch >= 'A' && ch <= 'Z') ||
		(ch >= 'a' && ch <= 'z') ||
		ch == '_' || ch == ':'
}

func isNameChar(ch byte) bool {
	return isNameStart(ch) ||
		(ch >= '0' && ch <= '9') ||
		ch == '-' || ch == '.'
}

func isSpace(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'
}

func boolPtr(b bool) *bool { return &b }

func toBool(v any, def bool) bool {
	if v == nil {
		return def
	}
	b, ok := v.(bool)
	if !ok {
		return def
	}
	return b
}

func toStringMap(v any) map[string]string {
	out := map[string]string{}
	switch m := v.(type) {
	case map[string]string:
		for k, vv := range m {
			out[k] = vv
		}
	case map[string]any:
		for k, vv := range m {
			if s, ok := vv.(string); ok {
				out[k] = s
			}
		}
	}
	return out
}
