; SPDX-License-Identifier: Apache-2.0
; rule-arch-05-console-pii.scm
; Detects console.log, console.info, console.debug, console.warn
; calls whose arguments contain any PII global / variable reference
; (email, phone, iban, password, token, user, customer).
;
; Tree-sitter query using #match? on the full text of the call_expression.

(
  (call_expression) @call
  (#match? @call "console\\.(log|info|debug|warn)\\s*\\([^)]*\\b(email|phone|iban|password|token|user|customer)\\b[^)]*\\)")
)

