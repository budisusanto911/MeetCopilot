# MeetCopilot Workspace Rules (Token Efficiency & Security)

1. **Zero Idle / Filler Calls**: Filter silence, partial fragments, and non-actionable fillers (`uh-huh`, `okay`, `hello?`) locally before invoking any LLM.
2. **Compact Output Wire Format**: Use delimited streaming lines (`T|`, `Q|`, `R1|`, `R2|`, `R3|`) with `max_tokens <= 180` instead of verbose JSON or prose explanations.
3. **Prefix-Cache Stability**: Keep the system prompt and pre-packed meeting cheat sheet immutable at the start of every request; place sliding history (`<= 4` turns) and on-demand RAG chunks after the static prefix.
4. **Intent-Gated RAG Only**: Never inject full files into prompts. Run local SQLite FTS5 retrieval only when the utterance requires factual/project/personal context, capped at `<= 420` tokens.
5. **Sensitive File Blocklist**: Never index or expose `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/`, or credential files in local context indexing.
6. **Verify Before Shipping**: Run `npm test` and `npm run audit-tokens` after modifying `packages/core-ai/` or prompt logic.
