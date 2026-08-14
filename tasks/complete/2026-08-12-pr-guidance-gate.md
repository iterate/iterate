---
status: done
size: small
---

# PR guidance gate: force agents to read docs/pull-requests.md before touching PRs

## Status summary

Implemented and tested; PR [#2484](https://github.com/iterate/iterate/pull/2484) is CI-green and awaiting review.
Hook + settings wiring + 6 vitest cases + doc note all done. Nothing known missing; possible
follow-up (out of scope): CI/pullfrog body check to catch non-Claude agents.

## Problem

Agents keep opening PRs that ignore [docs/pull-requests.md](../docs/pull-requests.md) — no
screenshots/videos, no risk map, wrong body shape. Global CLAUDE.md is the wrong place to dump
the guidance: agents skim it at session start and forget it by the time they open a PR, and we
don't want to bloat it anyway.

## Approach

Just-in-time context injection via a Claude Code `PreToolUse` hook, checked into
`.claude/settings.json` so every worktree/session gets it:

- The hook watches `Bash` tool calls. When a command mutates a PR (`gh pr create`, `gh pr edit`,
  `gh pr merge`, or `gh api -X PATCH .../pulls/...`), it blocks (exit 2) and prints the **full
  contents** of `docs/pull-requests.md` to stderr — which Claude Code feeds back to the model.
- The deny message ends with a hash of the doc: "re-run with `PR_GUIDANCE_HASH=<hash>` prefixed
  to your command". The hook lets gated commands through when the current hash appears in the
  command string.
- Hashing the doc means the gate self-invalidates whenever the guidance changes: stale hash →
  blocked again → fresh guidance re-injected.
- "Gaming" the hash is fine by design: the deny message *is* the doc, so by the time an agent can
  retry, the guidance is in its context. That's the whole enforcement.

Why a hook and not a `gh` PATH shim:

- Hooks only run under the agent harness — humans in a normal terminal are unaffected, no
  `isAgent()` env sniffing.
- Inspects the command string before execution, so it catches `gh` invoked by absolute path.
- PATH shims are fragile in the sandbox (the pnpm shell wrapper already breaks there).
- Ships with the repo; no per-machine setup.

## Checklist

- [x] `scripts/hooks/pr-guidance-gate.sh` — pure bash (no jq/node so every Bash call stays fast):
      fast-path exit for non-PR commands, `shasum`-based doc hash, exit 2 + guidance on stderr
      for gated commands missing the current hash _implemented as spec'd; matches on the raw
      stdin JSON rather than parsing it, which keeps it dependency-free_
- [x] `.claude/settings.json` — add `hooks.PreToolUse` entry (matcher `Bash`) _added under the
      proper `"hooks"` key; pre-existing top-level `SessionStart` left untouched, see decisions_
- [x] `scripts/hooks/pr-guidance-gate.test.ts` — vitest in the scripts workspace, spawns the real
      script: non-gh and read-only `gh pr view`/`gh api` GET pass; create/edit/merge/PATCH
      blocked without hash; blocked stderr contains the doc + hash; retry with that hash passes;
      stale hash blocked _6 tests, all passing_
- [x] Note in `docs/pull-requests.md` mentioning the gate so humans editing the doc know blocking
      behavior is tied to its hash _blockquote at the top of the doc_

## Decisions & assumptions (made while Misha reviews async)

- Gate **mutations only** (create/edit/merge/PATCH). Reads (`gh pr view`, `gh pr checks`,
  `gh api .../pulls/<n>` GETs) pass freely — gating them would nag constantly during PR
  monitoring, which the doc itself prescribes.
- Stateless hash check (no per-session ack marker). The hash rides along as an inline
  `PR_GUIDANCE_HASH=<hash>` prefix the hook string-matches; it never needs to be a real env var.
- The existing top-level `SessionStart` key in `.claude/settings.json` is left untouched. It's
  not under the `"hooks"` key so Claude Code likely never runs it locally — and that's good:
  `async-coding-agent-setup.sh` does sudo installs and a full test run, clearly meant for cloud
  agent environments. Flagged for Misha rather than "fixed".
- Non-Claude agents (Cursor CLI, Codex) don't run Claude hooks. If those turn out to be the
  offenders too, a follow-up can add a CI/pullfrog check validating PR bodies post-hoc; out of
  scope here.

## Implementation log

- Hook matches against the raw PreToolUse stdin JSON with bash `case` globs instead of parsing
  out `.tool_input.command` — avoids a jq/node dependency and startup cost on every Bash call.
  Accepted tradeoff: a command whose *description* mentions `gh pr create` would also be gated
  (rare, and the fix is just adding the hash prefix).
- `gh api` gating is PATCH+`pulls` only. POST to `pulls/.../comments` (review-comment replies)
  and all GETs stay ungated because PR monitoring — which the guidance itself prescribes — runs
  those constantly.
- Hash is `shasum | cut -c1-8` (SHA-1, present on macOS and Linux); test recomputes it with
  node:crypto and also round-trips the hash extracted from a real deny message.
- Live-verified both paths: deny prints the full doc + hash and exits 2; hash-prefixed rerun
  exits 0 silently.
- `pnpm install && typecheck (scripts) && lint && knip && format && scripts tests` all green
  locally; full suite left to CI.
