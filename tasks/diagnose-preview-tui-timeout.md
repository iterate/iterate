---
state: backlog
priority: medium
size: medium
tags: [os, e2e, tui, preview-ci, flake]
---

# Diagnose the stream-tui preview-CI timeout (skipped in CI on PR #2223)

## Summary

The two `stream-tui.spec.ts` tests (`Agent chat TUI connects, renders the
feed, and sends` and `starts the existing computer provider from
/use-my-computer`) began timing out at tui-test's **whole 45s worker budget**
in **preview CI only**, and are now **skipped in CI** (env-gated on `CI`) so
PR #2223 can merge. They still run locally. Un-skip once the root cause is
understood.

The skip lives in `apps/os/e2e/tui-test/stream-tui.spec.ts` (`testUnlessCi`),
with a pointer to this file.

## What was observed

- **Three consecutive preview runs failed identically** on PR #2223:
  - `stream-tui.spec.ts:46` — timeout, `worker was terminated as the timeout
    (45000 ms) was exceeded`, retry #1 dies at **0ms** (`Worker terminated`).
  - `stream-tui.spec.ts:88` — same shape.
  - Depot runs: `6xt5xd8xhk` (attempts `9b88f4ns3c`, `96tx0ll3nv`),
    `lk6w10zt41`, and the run for head `56f22e93d`.
  - Retry telemetry: `2 TUI test(s) needed retries … still failed`.
- **Everything reachable from outside CI passes**, same commit, same dist:
  - `doppler run --config dev -- pnpm --dir apps/os exec tsx e2e/tui-test/run.ts`
    → 2 passed (macOS, local dev server).
  - `doppler run --config preview_18 -- pnpm --dir apps/os exec tsx
    e2e/tui-test/run.ts` → 2 passed, against the **exact deployment**
    (`os.iterate-preview-18.com`) whose CI run failed.
  - The built `dist/stream-tui/agent-chat-terminal.mjs` is **byte-identical**
    between the passing local build and the failing CI build (344.46 kB).

## The regression window (a correlation with no causal path)

- The 45s timeouts first appear after commit **`56f22e93d`** ("Bundle
  iterate/sdk with the processor chunks"), which merged the `src/sdk.ts`
  tsdown entry into the same config object as the `iterate/processors` entries
  so rolldown shares their chunks (the fix for the guestbook
  class-identity bug — see PR #2223's description).
- **But that reshuffle cannot plausibly reach the TUI.** The CLI + TUI bundle
  is a *separate* tsdown config object (`src/index.ts` +
  `src/stream-tui/agent-chat-terminal.tsx`), and `bin/iterate.js` launches it
  by `execve`-ing `bun dist/stream-tui/agent-chat-terminal.mjs`
  (`packages/iterate/src/cli.ts` `buildChatCommand`) — it imports **none** of
  the resharded `sdk`/`processors` chunks. The bundle-size delta between the
  passing (pre-`56f22e93d`) and failing logs traces to main's unrelated
  lowercase-copy merge, not to the chunk change.
- Working hypothesis: this is a **preview-CI-runner-specific** condition
  (bun cold start, PTY allocation, or the CAPTUN/websocket dial from the
  runner into the preview deployment) that the tsdown timing shift merely
  perturbed — NOT a correctness regression in the shipped artifact. Unproven.

## Diagnostics already in place

`apps/os/e2e/tui-test/run.ts` (`dumpChatPtyTranscript`) now re-runs the exact
`iterate chat` command under a real PTY (`script`) for 20s and prints the raw
transcript **whenever the suite fails**. The next real CI failure (or a
deliberate un-skip on a throwaway commit) should reveal whether the CLI:

1. crashes at import (bad chunk / missing export) — a stack in the transcript,
2. hangs before first render (dial/auth) — a partial or empty screen, or
3. renders correctly but slower than 45s (genuine perf) — a good screen, late.

## Next steps

1. Un-skip on a scratch branch, let preview CI fail, read the PTY transcript.
2. If (3): raise `TUI_TEST_TIMEOUT_MS` for the preview lane and un-skip.
3. If (1)/(2): fix the real cause, un-skip, delete this file.

## Relevant links

- PR: https://github.com/iterate/iterate/pull/2223
- Retry/timeout policy: `docs/testing.md#retries-and-timeouts`
- TUI launcher: `packages/iterate/src/cli.ts` (`buildChatCommand`,
  `replaceWithInheritedProcess`)
- Runner: `apps/os/e2e/tui-test/run.ts`
- Spec: `apps/os/e2e/tui-test/stream-tui.spec.ts`
