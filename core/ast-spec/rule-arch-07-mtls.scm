; rule-arch-07-mtls
; Tree-sitter query to find HTTP (not HTTPS) requests to non‑localhost services.
; Matches calls like fetch("http://...") or axios.get("http://...") etc.

; direct call: fetch, axios, got, undici as functions
(call_expression
  function: (identifier) @func_name
  arguments: (arguments (string (string_fragment) @url))
  (#match? @func_name "^(fetch|axios|got|undici)$")
  (#match? @url "^http://(?!localhost|127\\.0\\.0\\.1)")
)

; method call: axios.get(…), got.post(…), undici.request(…) etc.
(call_expression
  function: (member_expression
    object: (identifier) @obj_name
    property: (property_identifier) @method_name
  )
  arguments: (arguments (string (string_fragment) @url))
  (#match? @obj_name "^(axios|got|undici)$")
  (#match? @method_name
    "^(get|post|put|delete|patch|head|request|options|stream)$")
  (#match? @url "^http://(?!localhost|127\\.0\\.0\\.1)")
)
; Note: template‑literal strings are not covered by this query (see semgrep rule for them).
