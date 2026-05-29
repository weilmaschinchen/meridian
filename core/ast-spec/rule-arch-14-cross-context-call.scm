;; rule-arch-14-cross-context-call
;; ARCH Rule: Cross-Context-Direkt-Funktionsaufruf
;; ADR-0026 §2 — Ports-and-Adapters: Domain-Code darf keine direkten Funktionsaufrufe
;; in andere Module/Contexts tätigen, sondern nur Port-Interfaces oder Event-Bus nutzen.
;;
;; Detection: Cross-file analysis via ts-morph (see LO-P3-tsmorph)
;; This file is a placeholder. The actual analysis uses ts-morph to:
;;  - detect imports from other app modules (../../<other-context>/...)
;;  - trace function calls from those imports
;;  - report violations as arch-14
;;
;; Semgrep partner rule: rule-arch-14-cross-context-call.semgrep.yaml
;;
;; Author: CRA Pipeline
;; Version: 1.0.0
;; Enabled: true
