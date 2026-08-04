---
status: done
size: small
---

# Fix main CI: default agent prompt 13 chars over budget

**Status summary:** done — PR #2406 fully green (all Depot checks pass, mergeable CLEAN).

Main has been red since fe7167f6b (#2399). `agent-prompt-budgets.test.ts > the default prompt stays under 4200 tokens` fails: 16813 chars vs the 16800 ceiling (4200 tokens × 4 chars/token).

Cause: semantic conflict between two PRs that both grew `DEFAULT_AGENT_SYSTEM_PROMPT`:

- #2400 (merged 12:59) grew the "Return only what you need" bullet by ~46 chars (inferred type + structural preview wording).
- #2399 (merged 13:25, branched before #2400 landed) added the "YOU are the LLM" bullet and raised the ceiling 4150 → 4200, leaving ~30 chars of headroom against the main it could see.

Each PR was green alone; the merge is 13 chars over.

## Plan

- [x] Trim the #2400 bullet wording in `apps/os/src/domains/agents/agent-defaults.ts` to get comfortably under 16800 without losing meaning _("a small structural preview" → "a preview", "in plain TypeScript" → "in TypeScript"; prompt now 16786 chars, 14 headroom. Bullet 207 already teaches that the script body is real TypeScript.)_
- [x] Bump `DEFAULT_AGENT_SYSTEM_PROMPT_REVISION` 7 → 8 _(MCP/onboarding revisions derive from it automatically)_
- [x] `pnpm vitest run agent-prompt-budgets` green in apps/os _(7/7; full apps/os suite also green: 2547 passed)_
- [x] typecheck/lint/knip clean _(all green locally)_

## Implementation notes

- Kept the ceiling at 4200 — the overshoot is accidental accretion from a concurrent merge, not a product ask, so trimming beats raising.
- Trim taken from the newer #2400 wording rather than #2399's bullet since it had the most compressible adjectives.
