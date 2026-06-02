; SPDX-License-Identifier: Apache-2.0
; rule-arch-09-adr-link.scm
; Cross-Cutting Rule: ADR-Bezug bei Architektur-Änderungen
; Diese Regel wird nicht als Tree-sitter-Query implementiert, sondern als Heuristik im CRA-Detector.
; Der CRA-Detector prüft PR-Metadaten (Titel + Commit-msgs + geänderte Dateien) auf ADR-Verweise,
; wenn architektur-relevante Patterns (class XxxRepository, XxxService, implements XxxService) geändert werden.
; Siehe admin/cra/rules/arch-09-adr-link.js für die Implementierung.
;
; Dieser File dient als Platzhalter für die AST-Spec-Dokumentation – die Regel ist cross-cutting.
; Severity: INFO
; Charter-Regel: arch-09 (PR-Body sollte ADR-Bezug enthalten, Charta P10, ADR-0016)
