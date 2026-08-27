---
status: implemented
size: medium
---

# AI interceptor survives project DO churn: extend the mount invariant

## Status summary

Implemented and verified: the liveness lane (both interceptor slots), 4901 on
far-side loss, silent deliberate teardown, the shared resilient spec helper,
and a deterministic e2e (kill the project DO → observe 4901 → re-install →
serving again) — all passing locally against a real dev server, plus the
pre-existing ai-intercept and itx-egress e2e suites and the fake-model spec.
PR: https://github.com/iterate/iterate/pull/2527.

## Problem

`itx.ai.intercept(handler)` (PR #2523) stores the retained handler stub in a
memory-only slot on the Project Durable Object (`#aiInterceptor`,
`project-durable-object.ts`). On a cold preview deployment the DO incarnation
can die mid-session (deploy propagation, eviction, revival — observed as
`processor-revived` + storage reset warnings on PR #2525's preview runs:
project `agent-script-reuse-mtaqpxai-0f77c305` on preview-1, agent
`/agents/factorizer-223591ab`, offsets 306–323). The slot resets, and every
subsequent intercepted attempt fails all 3 retries with
`No AI interceptor installed for "intercepted/<x>"`.

The nasty part: the loss is **silent**. Live capability mounts have the mount
invariant (session-transport.ts): *an open session socket means a live mount;
mount loss always arrives as a close event (4901).* The interceptor slot has
no such carrier — the client's socket stays open while the interception is
gone, so clients can only discover the loss by timing out and diagnosing
journal events. `specs/agent-script-reuse.spec.ts` (PR #2525) does exactly
that, client-side, ~40 lines of bespoke recovery; `specs/agent-fake-model-chat.spec.ts`
has no guard and is equally exposed.

## Decision

Considered:

1. **Client-side auto-re-registration on 4901** — insufficient alone: today
   the client never *gets* a 4901 for interceptor loss (that close only exists
   for capability provider pagers), so the silent case stays silent.
2. **Server-side grace/queue while a pager reconnects** — solves nothing
   alone (nobody re-installs), and the agent turn's retry policy (3 attempts,
   10s/20s backoff) already bridges any reconnect window.
3. **Silent session-side re-install (session isolate retains the handler and
   re-registers when the DO comes back)** — works, but forks the recovery
   story into a rarely-exercised special path, which
   capability-provider-pager-relay.ts explicitly rejects ("MAXIMUM TEARDOWN,
   DELIBERATELY … One recovery path, exercised constantly, beats a rarely-run
   special case").

Chosen: **extend the mount invariant to the interceptor slot** (the missing
half of option 1), plus the shared client loop that option 1 presumes:

- [x] Project DO: accept a plain (non-hibernatable) "interceptor liveness"
      WebSocket via `fetch()`, dialed by the session isolate at install time
      and associated with the registration by a random `interceptId`. A plain
      accept means the socket's lifetime IS the incarnation's lifetime: DO
      death closes it, and while it is open the DO cannot hibernate away the
      memory slot. Install order: dial first, then `interceptAi(handler,
      {interceptId})`; an install that finds no matching socket rejects, so an
      installed interceptor provably has a live socket in the same
      incarnation. _`#acceptInterceptorLivenessUpgrade` /
      `#claimInterceptorLiveness` in project-durable-object.ts; lane constants
      and helpers in `apps/os/src/domains/projects/interceptor-liveness.ts`._
- [x] Session side (`AiRpcTarget.intercept` in rpc-targets.ts): on far-side
      socket close, close the itx session transport with the documented 4901
      (`closeItxSessionTransport`), same as the capability pager's
      `onPagerLost`. Deliberate teardown must stay silent: releasing the
      handle, and supersession by a later `intercept()` (last writer wins),
      close the socket with a recognizable reason and do NOT fire 4901 —
      otherwise a superseded session's reconnect loop would fight the new
      interceptor forever. _`watchInterceptorLiveness` +
      `dialInterceptorLiveness`; the session wraps the DO handle in its own
      release-forwarding handle._
- [x] DO side: when the liveness socket closes far-side (session isolate
      died), release the associated registration if still current — the slot
      must not keep a broken stub. _The `lost` listener in
      `#acceptInterceptorLivenessUpgrade` clears both slots by socket
      identity._
- [x] Same treatment for the egress interceptor slot (`interceptEgress`) if it
      shares the machinery cheaply; otherwise leave a breadcrumb and keep this
      PR AI-only. _Shared cheaply — same lane, slot label "egress";
      `ProjectEgressRpcTarget.intercept` mirrors the AI wiring._
- [x] Contract docs: update `noAiInterceptorError` and the `intercept()`
      docstrings — "interception lives exactly as long as your session: if the
      platform's half dies while your socket is open, your socket closes
      (4901); reconnect and intercept() again." _Docstrings + error message
      updated; itx api regenerated._
- [x] Shared spec helper (`specs/test-support/…`): install an interceptor on a
      DEDICATED admin itx connection that owns the reconnect-and-re-install
      loop (the node client is deliberately vanilla — `onWebSocketClose` is
      the documented hook). Specs stop writing bespoke recovery.
      _`specs/test-support/resilient-ai-interceptor.ts`
      (`installResilientAiInterceptor`); `connectAdminItx` gained an
      `onWebSocketClose` option._
- [x] `specs/agent-fake-model-chat.spec.ts`: adopt the helper. _Done; spec
      passes locally against dev._
- [x] Deterministic e2e regression (`apps/os/e2e/vitest/ai-intercept.itx.e2e.test.ts`):
      install → serve → kill the project DO (expose `kill()` on the project
      itx surface, mirroring `stream.kill()`) → assert the session closes with
      4901 → reconnect + re-install → serve again. Also: released-then-killed
      stays released. _`project.kill()` was already on the itx surface — no
      new API. Two new tests: DO-restart recovery, and
      supersession-stays-silent; both green, plus the pre-existing release
      test and all 9 itx-egress e2e tests._

Explicitly NOT doing (assumptions, delineated):

- No change to the agent turn retry policy; 3 attempts over ~30s comfortably
  cover a reconnect+re-install (~1–2s).
- No hibernatable pull-based interceptor (registration-as-socket, pages
  lending RPC legs à la capability providers). It would survive DO churn with
  zero re-install, but is a much bigger build for a testing-only feature; the
  mount invariant + client loop already exists as the platform's answer.
- Not touching PR #2525's spec (its branch); once this merges, its bespoke
  `sendExpecting` recovery and warm-up re-install can collapse onto the shared
  helper. Noted in the PR body instead.

## Implementation notes

- Why a plain (non-hibernatable) accept and not `HibernatablePagers`: the
  slots are memory, so the socket must die exactly when the incarnation's
  memory does. A hibernatable accept would SURVIVE restarts (wrong signal) and
  would also let the DO hibernate the slot away while the socket looked
  healthy. The plain socket doubles as a residency pin — an installed
  interceptor keeps the project DO resident, which is correct for a
  short-lived testing feature.
- Why not implement the interceptor as a live capability mount (full piggyback
  on the Capability Provider Pager machinery): the slot lives on the Project
  DO (shared by agent turns, `ai.run`, and the egress fetch hot path), mounts
  live on stream-DO capability hosts and are project-visible/discoverable, and
  every intercepted call would take a page-and-lend-a-leg hop. Hiding a
  platform-only slot in that machinery costs more than the ~90-line lane.
- Supersession closes the loser's socket with reason
  `superseded by a newer interceptor` (1000); the session watcher recognizes
  the deliberate reasons and stays silent — proven by the supersession e2e
  (the superseded session answers a real round-trip afterwards).
- `AiRpcTarget`, `CloudflareIntegrationsRpcTarget`, and
  `ProjectEgressRpcTarget` now take `ctx` (threading the session's
  ExecutionContext to `closeItxSessionTransport`); DO-side itx has no
  transport registration, so the 4901 is a no-op there, same as capability
  pagers.
- Local verification quirk (not shipped): `pnpm dev start --detach` must run
  with apps/os-scoped Doppler (cwd apps/os, or `doppler run --project os`) —
  a root-cwd start boots a server with missing secrets whose `/api/health`
  500s.
- Once merged, PR #2525's spec can drop its bespoke warm-up re-install and
  `sendExpecting` journal-diagnosis recovery in favor of
  `installResilientAiInterceptor`.
