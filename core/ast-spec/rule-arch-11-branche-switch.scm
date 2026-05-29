;; rule-arch-11: Detects branching on tenant.branche outside of policies/
;; This tree-sitter query captures if/switch statements whose condition
;; contains a member access to tenant.branche. The actual path exclusion
;; (policies/) is applied in the Semgrep rule, not here.

[
  (if_statement
    condition: (_) @cond
    (#match? @cond "tenant\\.branche"))
  (switch_statement
    discriminant: (_) @discr
    (#match? @discr "tenant\\.branche"))
