---
status: in-progress
size: small
---

# Fix main CI: default agent prompt 13 chars over budget

**Status summary:** spec committed; fix is a small prompt trim + revision bump. Main red since fe7167f6b.

Main has been red since fe7167f6b (#2399). `agent-prompt-budgets.test.ts > the default prompt stays under 4200 tokens` fails: 16813 chars vs the 16800 ceiling (4200 tokens × 4 chars/token).

Cause: semantic conflict between two PRs that both grew `DEFAULT_AGENT_SYSTEM_PROMPT`:

- #2400 (merged 12:59) grew the "Return only what you need" bullet by ~46 chars (inferred type + structural preview wording).
- #2399 (merged 13:25, branched before #2400 landed) added the "YOU are the LLM" bullet and raised the ceiling 4150 → 4200, leaving ~30 chars of headroom against the main it could see.

Each PR was green alone; the merge is 13 chars over.

## Plan

- [ ] Trim the #2400 bullet wording in `apps/os/src/domains/agents/agent-defaults.ts` to get comfortably under 16800 without losing meaning (no ceiling raise — the test says raises must be argued in a PR, and this overshoot is accidental, not an ask)
- [ ] Bump `DEFAULT_AGENT_SYSTEM_PROMPT_REVISION` 7 → 8 (content changed → shipped payload changes; MCP/onboarding revisions derive from it)
- [ ] `pnpm vitest run agent-prompt-budgets` green in apps/os
- [ ] typecheck/lint/knip clean

## Implementation notes

(log below as work happens)
