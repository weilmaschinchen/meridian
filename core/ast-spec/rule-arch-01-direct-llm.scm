; rule-arch-01-direct-llm: Direct-LLM-Provider-Call (import)
; Detects import statements referencing known LLM SDK packages.
; This is a path-sensitive rule: findings outside infrastructure/llm/ are violations.
; The tree-sitter query alone does not filter by path – the surrounding tooling must do that.

; Match any import whose source string indicates an LLM SDK.
; Covered modules: @anthropic-ai/sdk, openai, google-genai (also @google/generative-ai).
(
  import_statement
  source: (string) @import_source
  (#match? @import_source "(anthropic-ai/sdk|openai|google-genai|google/generative-ai)")
)

; Dynamic imports (import()) are not covered by this static query and must be checked separately.

