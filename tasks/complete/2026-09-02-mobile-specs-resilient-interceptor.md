---
status: done
size: medium
---

# Migrate mobile specs to the resilient AI interceptor (and modernise the folder)

## Status summary

Done. Scope grew from the original two-spec migration into a full
modernisation of specs/mobile/ (one commit per file): fixture signup
everywhere, scripted turns instead of silent default-model LLM calls,
inlined helpers, terse comments, plus the `requests` notification-payload
product change so rows are findable by their held operations. Every spec in
the folder passes locally, including notes/note-composer once main's #2567
fixed the fleet-wide Artifacts 403s. PR #2563 marked ready.

## Motivation

`specs/mobile/approvals.spec.ts` and `specs/mobile/notifications.spec.ts` predate
`createAgentHelper` (they landed 2026-07-29/31; the helper landed 2026-08-28 in
PR #2543). Each hand-rolls the ritual the helper now owns:

- `agent.create()` + the `agent/configured` append pointing the thread's agent
  at `intercepted/driver` with a dropped debounce
- a raw `itx.ai.intercept(handler)` on the spec's main admin session

Two problems with the raw `intercept`:

1. **Not churn-proof.** A Durable Object restart mid-spec (routine on cold
   preview deployments — an environment both specs' comments already fight
   with) closes the session with 4901 and nothing reinstalls; the next scripted
   turn dies with `No AI interceptor installed`.
2. **Shared fate.** The interception rides the spec's main admin session, so
   either one dying takes the other down. `createAgentHelper` installs via
   `installResilientAiInterceptor` on a dedicated connection that owns the
   reconnect-and-reinstall loop.

`specs/mobile/live-status.spec.ts` already uses the helper (via
`createMobileFixture`) and proves the shape works for mobile specs.

## Checklist

- [x] approvals.spec.ts: replace agent birth + config append + raw
      `itx.ai.intercept` with `createAgentHelper` +
      `createAgent({ path: agentPath })` + `responses.set(handler)`
      _commit f6c91baf6; the warm-up runScript now runs after createAgent
      instead of concurrent with the config append_
- [x] approvals.spec.ts: update the journal assertion + comments from
      `intercepted/driver` to the helper's `intercepted/typed` _same commit_
- [x] notifications.spec.ts: same swap for the watched-thread lane (the orphan
      and elsewhere agents run scripts directly, no turns — untouched)
      _same commit_
- [x] both: keep the content-routing handlers (route by last user message)
      inside `responses.set(fn)` — the queue's fingerprint replay also gives
      retried attempts the same script for free _handlers moved verbatim into
      `responses.set`_
- [x] run both specs locally; typecheck/lint/format/knip _all green; see log_

## Decisions (made while fleshing out)

- **Minimal scope**: both specs keep their own signup flow and their own
  `connectItxReady` admin session. `createMobileFixture` isn't adopted here —
  it doesn't expose `itx`, and both specs lean on it heavily (egress rules,
  device enrollment, stream waits). Adopting it would mean extending its API
  and rewriting the popup flow in the suite's two most timing-sensitive specs;
  not worth coupling to this fix.
- **Warm-up run ordering** (approvals): the throwaway `runScript` that pays the
  cold isolate start currently races the config append; after the swap it
  starts just after `createAgent` resolves (create + append now live inside the
  helper). The ~100ms shift is immaterial to what the warm-up is for.
- **Model name**: the helper configures `intercepted/typed`; the specs' journal
  assertions and prose move off `intercepted/driver`. The guarantee asserted is
  unchanged — a model only this process's handler can serve.

## Follow-up: approvals simplification pass (requested after the migration)

- [x] drop `test.setTimeout(120_000)` — it LOWERED the 240s default
      (`SPEC_TEST_TIMEOUT_MS`); the "two REAL agent turns" comment existed only
      to justify it _both deleted; the turns are still real agent turns on a
      scripted model, nothing changed there_
- [x] sign up via `helpers.createMobileFixture` — deletes the hand-rolled
      popup flow, `connectItxReady`, `resolveOsBaseUrl`, and the try/finally
      (the echo tunnel is `await using` now) _fixture gained an `itx` handle;
      its signup email prefix now derives from slugPrefix (was hardcoded
      mobile-live-status) and its popup waits carry approvals' explicit
      timeouts_
- [x] remove the journal waits and timing hacks: the 6s rules-cache outwait
      (post-append chain is always > the 5s staleness bound in
      project-durable-object.ts `#egressRules`), the cold-isolate warm-up run,
      `awaitAgentScriptStart`, the settle `expect.poll` (replaced by waiting
      for each script's narrated outcome in the feed), the outcome-count
      `expect.poll` (single journal READ after the UI shows both), and the
      pre-Notifications root/device `waitForEvent` sync _spinner-waiter +
      turnPending cover the whole turn; verified twice locally at ~19s_

## Observed, out of scope

- `createMobileFixture.signUpToProject` hardcodes
  `uniqueSignupEmail("mobile-live-status")` for every caller — should be
  derived from `slugPrefix`. Trivial, but touching the fixture used by other
  green specs doesn't belong in this diff.

## Implementation log

- typecheck / lint / knip / format all green in the worktree (lint re-run
  after oxfmt reflow).
- Local spec runs needed three attempts, none related to this diff:
  1. `pnpm spec --project mobile <files>` — playwright's `--project` is
     variadic and swallowed the file args; use `--project=mobile`.
  2. "Process from config.webServer exited early", twice: the `dev.ts start
     --detach` webServer entry exits immediately when the dev server is
     already booting/restarting but not yet health-checkable (second
     occurrence was the dev server's own post-spec-run auto-restart, pid
     changed under the run). Retry once the server answers /api/health.
- Green runs: approvals passed in the paired run (`1 passed`, notifications
  in that run failed at the sign-in popup before any migrated code — cold
  auth-worker latency); notifications alone passed 35.6s.
