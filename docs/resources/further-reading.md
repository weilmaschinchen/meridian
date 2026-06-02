# Further reading

Background material to understand the ideas Meridian builds on. These are external references; Meridian is not affiliated with them. Links are provided for orientation — verify current URLs, as they change over time.

## Change gates and change management

- **ITIL 4 — Change Enablement** (Axelos). The discipline of controlling changes to reduce risk while keeping flow. Meridian's RFC lifecycle (`DRAFT → BLOCKED | APPROVED | OVERRIDDEN → SUPERSEDED`) is a lightweight, automated take on change enablement. <https://www.axelos.com/certifications/itil-service-management>
- **"Accelerate" — Forsgren, Humble, Kim.** The DORA research on what actually makes change safe and fast; argues for automated controls over heavyweight approval boards. <https://itrevolution.com/product/accelerate/>
- **DORA State of DevOps reports.** Annual data on deployment frequency, change-fail rate, and the role of automated checks. <https://dora.dev/>

## DevSecOps and shifting security left

- **OWASP DevSecOps Guideline.** Practical guidance on embedding security into the delivery pipeline. <https://owasp.org/www-project-devsecops-guideline/>
- **OWASP Top 10.** The canonical web application risk list; many of Meridian's `arch-xx` rules map to these categories (injection, broken access control, security misconfiguration). <https://owasp.org/www-project-top-ten/>
- **OWASP ASVS (Application Security Verification Standard).** A checklist of verifiable security requirements — useful when authoring custom rules. <https://owasp.org/www-project-application-security-verification-standard/>
- **SLSA (Supply-chain Levels for Software Artifacts).** Framework for software supply-chain integrity; complements Meridian's change-time gating. <https://slsa.dev/>

## Static analysis and rule authoring

- **Semgrep rule syntax docs.** Meridian's Gate 2 is Semgrep-compatible; this is the reference for writing `arch-xx` rules. <https://semgrep.dev/docs/writing-rules/rule-syntax>
- **GitHub CodeQL documentation.** Background on structural/dataflow analysis for comparison. <https://codeql.github.com/docs/>

## Risks of AI-generated code

- **Stanford / academic studies on AI code-assistant security.** Research has repeatedly found developers using AI assistants can produce *less* secure code while feeling *more* confident — the core motivation for a blocking gate. (Search: "Do Users Write More Insecure Code with AI Assistants?")
- **NIST AI Risk Management Framework (AI RMF 1.0).** Governance framework for AI systems, relevant when AI is in your development toolchain. <https://www.nist.gov/itl/ai-risk-management-framework>
- **OWASP Top 10 for LLM Applications.** Risk categories for systems that use LLMs (including code-generation tooling). <https://owasp.org/www-project-top-10-for-large-language-model-applications/>

## Audit trails and WORM storage

- **Amazon S3 Object Lock.** The mechanism that makes an S3-compatible bucket write-once-read-many; this is what gives Meridian's audit trail its immutability guarantee. <https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html>
- **MinIO Object Locking / retention.** The same capability for self-hosted, air-gapped deployments. <https://min.io/docs/minio/linux/administration/object-management/object-retention.html>

## Meridian itself

- **Source, issues, roadmap:** <https://github.com/weilmaschinchen/meridian>
- **This documentation:** <https://your-meridian-instance.example.com>
- **License:** Apache-2.0.

If a link is stale, search the title — these are all well-known, stable references.


## Vocabulary & Shared Terminology

Writing precise rule messages and prompts matters — especially for Gate 3 (LLM Review),
which uses the rule message as context. Using established terminology activates rich
knowledge in the LLM reviewer without requiring verbose descriptions.

- **[Semantic Anchors](https://llm-coding.github.io/Semantic-Anchors/)** — curated catalog
  of 46+ well-defined terms (Clean Architecture, SOLID, DDD, OWASP, ITIL, etc.) that serve
  as shared vocabulary between developers and LLMs. When writing Meridian rule messages or
  RFC commit messages, drawing from this vocabulary makes Gate 3 reviews sharper and
  self-documenting for any developer reading the finding later.

