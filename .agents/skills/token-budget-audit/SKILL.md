---
name: token-budget-audit
description: >-
  Use this skill to benchmark and verify prompt token efficiency, prefix-cache
  stability, Tier-0 local skipping, and intent-gated RAG limits across a
  simulated multi-turn meeting before shipping prompt or router changes.
---

# Token Budget Audit Skill

Verify that MeetCopilot obeys all workspace token-frugal rules (`AGENTS.md`) using a deterministic 60-minute simulated meeting benchmark.

## Steps

1. Run the executable audit script from the repository root:
   `node .agents/skills/token-budget-audit/scripts/audit.mjs`
2. Inspect the JSON report:
   - `prefixStable` must be `true` (static system + cheat sheet prompt stays byte-identical across turns).
   - `maxInputTokens` must stay under `1100` tokens even after 40+ turns (proving `RollingMemory` prevents context bloat).
   - `avgOutputTokens` must stay under `180` tokens.
   - `tier0Handled` and `ragSkipped` must be `> 0`.
3. If `passed` is `false`, inspect the failing assertion and tighten `packages/core-ai/src/prompt-builder.js` or `packages/core-ai/src/constants.js`.
