; SPDX-License-Identifier: Apache-2.0
; Tree-sitter query: comment node immediately before function_declaration
; Return comment node and function name for heuristic stem-compare in test.js
; Applicable to JavaScript/TypeScript

(
  (comment) @comment .
  (function_declaration
    name: (identifier) @name
  ) @func
)

; Optional capture for arrow functions (if needed in the future):
; (comment) @comment .
; (variable_declarator name: (identifier) @name value: (arrow_function)) @func
