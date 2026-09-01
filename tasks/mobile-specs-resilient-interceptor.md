---
status: implemented
size: small
---

# Migrate mobile approvals + notifications specs to the resilient AI interceptor

## Status summary

Implemented and verified: both specs migrated to `createAgentHelper`, both pass
locally (approvals 51s paired run, notifications 35.6s). PR #2563 awaiting
review. Remaining: CI green + review threads.

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
