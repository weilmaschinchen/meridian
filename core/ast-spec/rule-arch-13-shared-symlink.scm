; SPDX-License-Identifier: Apache-2.0
;; rule-arch-13-shared-symlink.scm
;; Tree-sitter Query: erkennt Importe und require-Aufrufe auf einen shared/-Symlink.
;; ADR-0026 §4 — Shared Modules müssen versioniert sein.

; ESM import ... from '../shared/...'
(
  (import_statement
    source: (string
      (string_fragment) @import-path
    )
  )
  (#match? @import-path "^\\.{1,2}(?:/\\.{1,2})*/shared/")
)

; CommonJS require('../shared/...')
(
  (call_expression
    function: (identifier) @func
    arguments: (arguments (string (string_fragment) @require-path))
  )
  (#eq? @func "require")
  (#match? @require-path "^\\.{1,2}(?:/\\.{1,2})*/shared/")
