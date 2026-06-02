; SPDX-License-Identifier: Apache-2.0
; rule-arch-04: JWT-Bearbeitung (verify/decode) ausserhalb auth/JwtVerifier.ts
; Charter P4, ADR-0010: JWT-Operationen dürfen nur in der zentralen
; JwtVerifier-Komponente ausgeführt werden. Andernorts sind sie verboten.
;
; Dieses Tree-Sitter-Query erkennt alle Aufrufe der Form jwt.verify(...)
; und jwt.decode(...). Der Pfad-Ausschluss erfolgt durch den Aufrufer
; (Semgrep bzw. CRA-Analyzer), nicht durch das Query selbst.
(
  call_expression
    function: (member_expression
      object: (identifier) @obj
      property: (property_identifier) @prop
    )
  (#eq? @obj "jwt")
  (#match? @prop "^(verify|decode)$")
