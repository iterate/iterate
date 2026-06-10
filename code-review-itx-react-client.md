# Code review: itx React client + stream subscriptions (cotton-strawflower vs main)

Adversarial review of the 6-commit branch (683+/1036−). Rules applied: `docs/coding-style.md`,
`docs/typescript-conventions.md`, `docs/design-system.md`, plus the stated criteria
(simplicity, cleanliness, will-it-work, testability). All findings below were either verified
directly by the reviewer or attributed to the verifying search.

## Verdict

The architecture is right and the deletions are clean — every removed surface (ping, `test.*`,
`streams.getState`, `/debug`, `/log-stream`, os-contract exports) was swept repo-wide with zero
dangling references, and the `event-stream-terminal` `/state` migration to `POST /api/itx/run`
genuinely works headless (admin bearer auth path verified end to end). The happy path will work.

But: **none of the ~400 lines of new client/kernel code runs under any automated test.**
`pnpm test` excludes `src/itx/e2e/**`; the new e2e needs a live deployment, has never been
executed, and no CI workflow invokes `pnpm e2e:itx`. The degraded paths — DO eviction, transient
start failure, rapid remount — all have real bugs (B2–B4 below) that only show up there. The
author's "tests green" claim is true and vacuous at the same time.

## Author-claims scorecard

| Claim                                         | Verdict                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Deletions are dead surface, nothing dangles   | **True** — verified repo-wide                                                                                        |
| Zero codemode files touched                   | **True** — branch diff confirms                                                                                      |
| typecheck/lint/format/tests green             | True, but no test exercises the new code                                                                             |
| Runtime smoke retargeted to /sign-in + health | **True** — including `waitForReady` (initially flagged as a miss by a sub-reviewer; refuted on direct read)          |
| "One WebSocket per tab"                       | **False** on the project REPL page — `createBrowserReplSession` opens a second socket next to the shared client (B7) |
| "Cached per connection epoch"                 | **False** — `epoch` is write-only dead state; the real mechanism is clear-on-close (C1)                              |
| "StrictMode-proof" lifecycle                  | **Overstated** — StrictMode isn't enabled anywhere in apps/os, and if it were, the re-arm has an ordering hole (B5)  |
| "Type probe confirming end-to-end typing"     | **Not in the branch** — no probe file exists in the diff; unverifiable as shipped                                    |
| e2e proving replay/live-tail/unsubscribe      | Written and plausible-pass, never run, not in CI, leaks a project per run (T2)                                       |
| Capped-backoff reconnect                      | **True** — correct exponential backoff + jitter, reset on open                                                       |

## Bugs (will-it-work findings)

### B1 (critical, cleanliness) — Raw NUL byte makes `stream-tail.ts` a binary file

`apps/os/src/itx/react/stream-tail.ts:58` — the cache-key separator in
`` const key = `${project}<0x00>${streamPath}` `` is a literal NUL byte (confirmed at byte
offset 0x850). Git shows the file as `Bin 0 -> 6686 bytes`: undiffable in PRs, invisible to
text tooling, unreviewable forever.

- **a (recommended):** use the escape `` `${project}\0${streamPath}` `` — the exact idiom in
  `packages/streams/src/browser/stream-browser-store.ts:101`.
- b: visible separator (space) — safe since `streamPath` starts with `/`.

### B2 (high) — Silent stall after Stream DO eviction; status lies "live"

Inbound DO subscriptions are runtime-only and not restored on wake
(`packages/streams/.../stream.ts:42-43`). When Cloudflare evicts the Stream DO (routine), events
stop, but the browser↔worker socket stays open, so `watchReconnect` never fires and the snapshot
stays `status: "live"` forever. `handle.ts`'s own doc says "re-subscribe from the last offset you
saw" — but the React layer only re-subscribes on _socket_ status transitions. Nothing detects
the dead DO leg.

- **a (recommended for this PR):** document as a known gap, add the P2 e2e that demonstrates it
  (kill the DO, append, assert), design heartbeat/resume as follow-up.
- b: build heartbeat now (periodic `getState` poll comparing maxOffset, or server-side ping).

### B3 (high) — Error state never retries while connected

`stream-tail.ts:140-148` — the only retry trigger is a client status-change event. If `start()`
fails transiently (one rejected `projects.get`) while the socket stays "connected", no status
event ever fires; the tail is stuck in `error` until reload. A second component retaining won't
restart it either (`refCount === 1` guard at line 167).

- **a (recommended):** schedule a bounded retry from the catch block in `start()` (reuse the
  generation guard); keep the status watcher for socket drops.
- b: also restart in `retain()` when `needsRestart` is set.

### B4 (medium) — Status-watcher leak on rapid release→retain

`stream-tail.ts:167-169` — retain → release (linger timer) → retain again _before `start()`
resolved_ (so `unsubscribeRemote` is still null) re-enters the start branch; `watchReconnect`
(line 140) **overwrites** `stopStatusWatch` without unsubscribing the previous listener. Each
leaked listener duplicates stop/start churn on every reconnect. Triggered by remount-within-5s
during connection setup (navigation between stream pages).

- **a (recommended):** install the status watcher exactly once per entry lifetime
  (`if (current.stopStatusWatch === null)`) and gate restart on a "never started" flag instead
  of `unsubscribeRemote === null` (which is also null mid-flight).
- b: fold the watcher into `start()`/`stop()` so they're symmetric.

### B5 (medium) — `afterOffset: "end"` produces a permanently dead subscription

`apps/os/src/itx/handle.ts:484` reuses `toNewAfterOffset`
(`new-stream-runtime.ts:141-145`), which maps `"end"` → `Number.MAX_SAFE_INTEGER` — the DO pump
then waits for offsets past MAX*SAFE_INTEGER forever. `"end"` is the obvious spelling of "tail
from now" and silently delivers nothing. Conversely, \_omitting* `afterOffset` replays the entire
history (`undefined` → 0), while the DO's own default for subscribe is live-tail. The reused
helper has read semantics, wrong for subscribe. Latent today (both callers pass explicit
values) but it's a kernel API trap.

- **a (recommended):** dedicated `toSubscribeAfterOffset`: `undefined`/`"end"` → live-tail
  (omit, let the DO default to maxOffset), `"start"` → 0, number passes through. Plus make
  `afterOffset` required (S1) so the choice is always explicit.
- b: validate-and-throw on `"end"`.

### B6 (low-medium) — Pre-resolve callback failure leaks the DO subscription

`handle.ts:474-487` — the DO pumps the first replay batch _during_ `subscribe()`
(`connection.wake()` before return). If `onEventBatch` rejects on that delivery before
`await stub.subscribe(...)` resolves, `handle` is still undefined, so `handle?.unsubscribe()`
no-ops and the subscription leaks until the socket breaks. Related design note: _any_ single
callback rejection silently unsubscribes (per the "offline means offline" comment) — but the
React layer never observes it; combined with B2-style invisibility the UI keeps saying "live".

- **a (recommended):** track a `pendingUnsubscribe` flag in the catch; after `subscribe` resolves,
  unsubscribe if set. Surface teardown to the caller (e.g. an `onClosed` callback) so the React
  layer can show it.
- b: queue deliveries until subscribe resolves.

### B7 (medium, honesty) — Two itx sockets on the project REPL page

`routes/_app/projects/$projectSlug/repl.tsx:24,38` — the page uses
`createBrowserReplSession(project.id)` (own socket) _and_ `ItxActivityTail` (shared client).
`connection.ts:1`'s "ONE WebSocket per tab" is false exactly on the page this PR builds as its
demo. The REPL's isolation may be intentional (it disposes/recreates sessions).

- **a (recommended for this PR):** keep the REPL's isolated session deliberately, say so in both
  files' comments, weaken the connection.ts claim; file a follow-up to converge.
- b: convert the REPL to the shared client now and delete `createBrowserReplSession`
  (third copy of the socket-setup dance — see S5).

### B8 (low) — Stale-cache delete race in `connection.ts:101`

`handle.catch(() => projectHandles.delete(key))` — a pre-reconnect handle's late rejection can
evict a fresh post-reconnect cache entry. Cache-miss only, not correctness.

- a: guard the delete with `projectHandles.get(key) === handle`. Trivial; do it.

## Simplicity / cleanliness findings

### C1 — Dead `epoch` state + comment describing a mechanism that doesn't exist

`connection.ts:28-29,56-58` — `epoch` is incremented and stored, never read. Invalidation is
actually `projectHandles.clear()` on close/deactivate. The header comment's "cached per
connection epoch" describes fiction.

- **a (recommended):** delete `epoch`; fix the comment to "cleared on close" — the real, simpler story.

### C2 — Speculative optionality (direct coding-style.md violation)

Rule: _"If a function is only called once, do not add optional properties — make the used
parameters required and drop the rest."_

- `hooks.ts:46` `itxKey.global` — zero consumers.
- `hooks.ts` `project?: string` on both hooks — every call site passes it; the
  `client.itx()` global branch is never exercised.
- `hooks.ts` `invalidates?` — one caller; two lines of `onSuccess` + `useQueryClient` inline.
- `handle.ts:466` `opts: { afterOffset? } = {}` — both callers always pass it (and see B5).
- **a (recommended):** make `project` and `afterOffset` required; delete `itxKey.global`, the
  global branch, and `invalidates`. Re-add when a real consumer exists.
- b: keep `project?` (plausible near-term global consumer), delete the rest.

### C3 — Dead exports

`itx/react/index.ts` re-exports `createItxBrowserClient`, `useItxClient`, `useItxStatus`
(fully dead function, `context.ts:22-25`), and 7 types — none imported outside `src/itx/react/`.
`handle.ts:510-512` `ItxStreamSubscription.streamMaxOffset` getter — read by nothing.

- **a (recommended):** trim the barrel to the five used exports (`ItxProvider`, `useItxQuery`,
  `useItxMutation`, `itxKey`, `useStreamEvents`); delete `useItxStatus` and the getter.
- b: keep `useItxStatus` only if a connection badge ships in this PR.

### C4 — StrictMode machinery for a mode that's off, with a hole if it were on

StrictMode is not enabled anywhere in apps/os (the only `StrictMode` matches in `src/` are this
branch's three comments). The `activate()`/`deactivate()` re-arm cycle and part of the 5s linger
rationale serve it. And if it _were_ on: effects re-run bottom-up, so a child's
`retain() → start() → client.itx()` runs while `active === false` (parent provider hasn't
re-activated) → rejects "disposed" → tail stuck in `error` (B3 makes it permanent).

- **a (recommended):** drop `activate()`; `deactivate()` is final per client instance (a genuinely
  remounted provider gets a fresh client from its state initializer anyway). Delete the
  StrictMode claims. Keep the linger for navigation churn, which is real.
- b: keep re-arm and fix the hole (queue `itx()` waiters while inactive instead of rejecting).

### C5 — `stream.read({})` is redundant full-history transfer on every (re)start

`stream-tail.ts:102-112` — reads the _entire_ stream (no limit option exists on read), slices to
500, then subscribes from `lastOffset ?? "start"` — but subscribing from `"start"` already
replays everything and `appendEvents` dedupes by offset. The read is pure duplicate transfer,
re-paid on every reconnect.

- **a (recommended):** delete the read; subscribe from `lastOffset ?? "start"` and let replay
  populate. Also removes the `as StreamLegacyEvent[]` cast.
- b: keep only if/when the read API grows a `last N` option (then subscribe from the read's max).

### C6 — `ItxStream.subscribe` bypasses the capability layer it sits in

`handle.ts:469-487` reaches into `this.runtime.env.STREAM` directly, duplicating the stub
derivation + `toLegacyEvent` mapping that `liveNamespaceStreamEvents`
(`streams-capability.ts:423-452`) already does — while the class's own doc-comment says every
method "resolves the streams domain entrypoint and forwards". The ambient STREAM authority the
capability layer exists to contain gets re-acquired here.

- **a (recommended):** add a callback-push `subscribe` to `StreamsCapability` beside the existing
  iterator-pull `stream`, and forward through `this.client()` like every other method —
  append-policy/props enforcement then covers subscriptions too.
- b: extract a shared `getProjectStreamRpcStub(env, namespace, path)` helper used by both sites.

### C7 — Split-brain query cache: breadcrumbs go stale after stream create

`streams/index.tsx:47-55` reads the list under `itxKey.project(...)`;
`components/path-breadcrumbs.tsx:153` fetches the same data via oRPC
`projectStreamsListQueryOptions` (different key, different transport). Double-fetch per page
view, and the create mutation's invalidation misses the breadcrumbs' cache entirely.

- **a (recommended):** convert `path-breadcrumbs.tsx` to the same `useItxQuery`/`itxKey` in this
  branch — one cache entry, and it's literally the migration's point.
- b: stopgap — also invalidate the oRPC key in `onSuccess`.

### C8 — Second refcounted live-tail store in the same app

`stream-tail.ts` reimplements `packages/streams/src/browser/stream-browser-store.ts`'s
`acquireStreamRuntime` pattern (per-key registry, refcount, useSyncExternalStore shape), still
used by `project-stream-view.tsx`. Two live-tail stacks, two transports, two status vocabularies.

- **a (recommended):** accept short-term, but record convergence intent + winner in
  `apps/os/docs/itx-orpc-replacement-plan.md` and file the ProjectStreamView port.
- b: port `ProjectStreamView` onto `useStreamEvents` now (bigger; it has its own SQLite mirror).

### C9 — Cast smell concentrated but uncentralized

`connection.ts:98` `as unknown as Promise<RpcStub<Itx>>`; similar chains in `handle.ts:469-472`
and `stream-tail.ts:104` (the handle.ts ones mirror pre-existing streams-capability code).

- **a (recommended):** one typed helper with the cast and a comment naming the capnweb typing
  gap, so the smell exists exactly once. (C5 deletes the stream-tail one for free.)

### C10 — UI nits (design-system.md)

- `itx-activity-tail.tsx:44,65-88` — `text-red-700`, `text-slate-*` vs the rule "theme colors
  only": use `text-destructive` / `text-muted-foreground` / `text-foreground`.
- `streams/index.tsx:150-155` — text-only loading state vs "use `Spinner`". Note the loading
  flash is new: the loader's `ensureQueryData` prefetch necessarily went away (itx is
  browser-socket-only), so first paint always shows it now — worth a deliberate skeleton.
- `itx-activity-tail.tsx:71` — `{render ? render(...) : event.type}` fallback is unreachable
  (events pre-filtered by `type in FRIENDLY_RENDERERS`); look the renderer up once at the filter.

## Test posture (the user's core question)

**What runs today: nothing.** `pnpm test` excludes `src/itx/e2e/**`; there are zero unit tests
for `itx/react/` or `ItxStream.subscribe`; `pnpm e2e:itx` exists but needs a deployment and no
GitHub workflow calls it; `runtime-smoke.test.ts` is `describe.skip` under CI. The Stream DO's
own `subscribe` is covered in `packages/streams`, but the bridge and the whole React layer are
covered only by the never-executed e2e.

**Coverage regression:** with `ping` and `test.*` gone, the runtime smoke now asserts only
unauthenticated surface (`/sign-in` SSR, `__internal.health` over HTTP+WS, publicConfig). The
only authenticated oRPC roundtrip assertion is gone.

**e2e hygiene (T2):** `itx-subscribe.e2e.test.ts` leaks one uniquely-named project per run
(`projects.create`, never removed), has a fixed 750ms sleep, and its `adminApiSecret()`/
`baseUrl()` helpers are the 4th byte-identical copy across the itx e2e files. It would
_probably_ pass against a healthy deployment (replay-from-0 includes system events whose
payloads exist, so the marker cast is safe; unsubscribe is synchronous so the no-events-after
assertion isn't flaky).

### Prioritized test plan (risk × cheapness)

P0 — regression tests for the bugs above, all unit, all fakeable:

1. **Cursor mapping** (`toSubscribeAfterOffset` unit): `"end"`/`undefined` → live-tail,
   `"start"` → 0, number passthrough. Catches B5. ~30 min.
2. **stream-tail refcount + linger** (fake client, `vi.useFakeTimers`): retain×2/release×2 →
   remote unsubscribe only after 5s; re-retain inside linger cancels teardown; entry deleted
   after expiry.
3. **stream-tail retry + single watcher** (fake client): `start()` fails once while
   "connected" → retries (drives B3 fix); retain/release/retain → exactly one status listener
   (catches B4).
4. **Bridge unsubscribes once on pre-resolve callback rejection** (fake `StreamRpc` invoking
   `processEventBatch` synchronously): catches B6.

P1 — the prod-likely behaviors: 5. **Reconnect resumes from lastOffset**: status connected→reconnecting→connected → old
generation unsubscribed, new subscribe called with `afterOffset === lastOffset`, stale
batches dropped. 6. **Dedupe + 500-cap**: history [1..5] + replay [4..7] → 1..7 once; 600 events → 500. 7. **getSnapshot reference stability**: two calls with no emit are `toBe`-equal (the
useSyncExternalStore infinite-render guard). 8. **connection.ts backoff + waiter lifecycle** (fake `WebSocket` + fake timers): retry
~500ms doubling to 10s cap, reset on open; `itx()` waiters resolve on open;
`deactivate()` rejects waiters; handles cleared on close; B8 race guarded. 9. **`ItxStream.subscribe` against a real Stream DO** (vitest-pool-workers, the
packages/streams harness style): the CI-runnable replay/live/unsubscribe — removes the
"needs a deployment" excuse.

P2 — e2e/CI hardening: 10. **DO-restart e2e** (extend itx-subscribe): subscribe, `kill()` the DO, append → assert
resume-or-surfaced-error. Today this documents B2; later it proves the heartbeat design. 11. **e2e hygiene**: `afterAll` project cleanup; extract shared `e2e-env.ts` helpers
(4 copies → 1); wire `pnpm e2e:itx` into a preview-slot or nightly workflow. 12. **Restore an authenticated smoke assertion**: one admin-secret-authed oRPC call
(e.g. `projects.list`). 13. _(Nice)_ browser test mounting `useStreamEvents`, append server-side, assert render and
single connection in `runtimeState()`.

Skip: SSR snapshot tests (constants), hooks.ts key-convention tests (thin wrapper).

# Plan

Approved: all recommended (a) options, with 11c for tests (full build-out).

**Status: remediated.** B4/B5/B6 + the smoke `waitForReady` had already been fixed on the
branch (bugbot on #1423 found the overlap); everything else below landed with this pass.
Full repo typecheck/lint/format/test green; new suites: 15/15 react unit tests, 6/6
worker-harness integration tests against a real Stream DO. Notable extra: the integration
test exposed that the capability must `dup()` the callback stub (Workers RPC implicitly
disposes parameter stubs when the call completes) — fixed and proven by the longevity test.

1. **React client rewrite** (`apps/os/src/itx/react/`): B1 NUL→`\0`; B3 bounded retry in
   `start()` catch; B4 single status watcher per entry + never-started flag; C5 drop `read()`,
   subscribe from `lastOffset ?? "start"`; C1 delete `epoch` + fix comment; C4 drop
   `activate()`, disposal final, delete StrictMode claims; B8 guard stale cache delete;
   C2 required `project`, delete `itxKey.global` + `invalidates`; C3 trim barrel, delete
   `useItxStatus`; B7 fix "one socket per tab" overclaim in comments.
2. **Kernel/capability** (`handle.ts`, `streams-capability.ts`): C6 add callback `subscribe`
   to StreamsCapability, forward `ItxStream.subscribe` through `this.client()`; B5 dedicated
   `toSubscribeAfterOffset` + required `afterOffset`; B6 pendingUnsubscribe leak fix; delete
   `streamMaxOffset` getter (C3).
3. **Routes/UI**: C7 convert `path-breadcrumbs.tsx` to itx; streams/index.tsx inline
   invalidation + Spinner (C10); itx-activity-tail.tsx theme colors + renderer lookup (C10);
   repl.tsx isolation comment (B7).
4. **Tests (11c)**: P0+P1 unit suite (cursor mapping, stream-tail refcount/linger/retry/
   watcher/reconnect/dedupe/snapshot-stability, connection backoff/waiters, bridge
   unsubscribe-once); integration test against a real Stream DO; e2e DO-kill test (B2 doc);
   e2e project cleanup + shared env helpers (14a); authed smoke assertion (12a); wire
   `e2e:itx` into CI.
5. **Docs**: B2 known gap + C8 convergence intent in `apps/os/docs/itx-orpc-replacement-plan.md`.
6. Full `pnpm typecheck && pnpm lint && pnpm format && pnpm test` at the end.
