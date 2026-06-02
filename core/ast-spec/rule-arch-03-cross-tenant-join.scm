; SPDX-License-Identifier: Apache-2.0
; Rule: arch-03-cross-tenant-join
; Type: regex pattern (not tree-sitter)
; Description: Detects SQL strings containing two distinct tenant_<schema> references,
;              indicating cross-tenant/schema JOIN — violates ADR-0009.
; The detection is performed via Semgrep regex on string literals (see .semgrep.yaml),
; not via tree-sitter query. This file documents the rule for the AST spec catalogue.
;
; Pattern (high-level):
;   String literal with more than one distinct match of /tenant_[a-z0-9_-]+/g
;
; Charter reference: ADR-0009 (Tenant-Isolation)
