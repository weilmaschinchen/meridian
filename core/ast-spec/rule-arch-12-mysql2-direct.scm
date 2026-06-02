; SPDX-License-Identifier: Apache-2.0
; rule-arch-12-mysql2-direct.scm
; Tree-sitter-Query: import von 'mysql2' oder 'mysql2/promise' in JS/TS.
; Pfad-Ausschluss (infrastructure/) muss durch aufrufendes Tool erfolgen.
; Siehe .semgrep.yaml für vollständige Regel.

(
  (import_statement
    source: (string) @mysql2_import
  )
  (#match? @mysql2_import "^(?:'|\")mysql2(/promise)?(?:'|\")$")
