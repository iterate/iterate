# Fix log — the campaign (companion to DEFECTS.md + ACTION-PLAN.md)

One line per landed change; newest last. Larger layering/design refactors go to
REFACTORS-LATER.md instead, not here.

- Phase 0 (bc6aee3cf, live-16): 10 no-brainer guards — charset gate (38/U1/39), reserved-prefix
  fence (34), provide round-trip (5/40), **proto** defineProperty (4), payload-less defaults
  (8/44), CapabilityProvision Symbol.dispose (23), config path validation (41).
- Test cook-down: three vitest configs → ONE (vitest.config.ts, `test.projects`: unit/harness/
  workers); `pnpm test` runs all three; `pnpm test:unit` is the fast inner loop. Deleted
  vitest.harness.config.ts + vitest.workers.config.ts + their scripts.
- Phase A (live-17): half-enabled-provide door killed. #facet() configures at materialization
  from the mount alone (identity derived entirely from the mount + DO address), idempotent;
  #facet throws NO_FACET for unknown slugs (no silent resurrection); enableProcessor validates
  the slug + built-in registry and drops its separate configure. Retires 29, 30, 32, 42, 45,
  H6. Both facet kinds' configure is idempotent (JSON-equal short-circuit + memo drop). 6 tests
  flipped to regression guards.
- Phase B (live-18): delivery correctness. ONE consumesEvent(consumes, event) exported from
  processor.ts — the reduce, both delivery lanes, and the inline core all call it; 2 divergent
  filter copies DELETED (the consumes ['*'] black hole, 10+11). read() short-page proof is the
  HEAD, never a beyond-head afterOffset (9); resumeSubscription clamps afterOffset to head (13);
  forwarder CAS treats a deleted progress record as ABANDON, no ghost halt (12). 5 tests flipped.
- Verified (not a fix), live-18: DYNAMIC WORKER CODE AS A CAPABILITY works end to end
  (proofs/proof_worker_cap.mjs, 6/6). provide({target: "itx.workers.get({source, className?})"})
  mounts stateless run() and stateful DO-class capabilities; deep dotted RPC resolves in ONE
  shot INCLUDING pipelined nested RpcTargets — a class method returning `new Row()` (an
  RpcTarget) then `.double()` on it, and that Row's own getter→fn, both work (invokePath walks
  where the stub lives). `itx.workers.get({source}).run(args)` IS the string-eval thin wrapper
  over the loader. No gap found; no thin `itx.run`/`itx.eval` alias exists (buffet option).
- Phase C (live-19): the runner, carefully. #loadProgress no longer caches the version-mismatch
  fallback, so #rereduceIfVersionChanged still fires — a version bump re-reduces reduce-ONLY, no
  side-effect replay regardless of which verb touches first (17, ☠); the refold rebuilds only
  through the OLD cursor's offset so an in-flight push isn't judged stale (18); waitUntilProcessed
  resolves waiters reached by the refold AND rejects promptly on a throwing self-pull (36);
  caughtUp fires only for the batch reaching the shown head (35). Phase B review cook-down:
  inlined #consumes. 4 tests flipped. DEFERRED (need a soak — noted): 6 in-batch dedupe
  double-reduce, 19 nested blockers, 20 at-head 500-multiple, 21 non-contiguous ephemerals, 22
  deep-payload dedupe.
- Phase E (live-20): connections. unsubscribe now closes the anonymous parked ItxConnection whose
  last naming mount was revoked — mirror of onFinalClose (31, the transport leak). Defect 22
  (jsonEqual decoupled from the parser depth budget — apps/os shape, order-insensitive,
  unbudgeted) landed alongside. Defects 14/15/16 (clean-vs-dirty close code, concurrent same-key,
  in-flight offline coding) REVERTED + deferred as a cluster: they all need the capnweb
  onRpcBroken reason arg to tell graceful from ungraceful ends without message-sniffing
  (REFACTORS-LATER). Stale proofs fixed (enableProcessor ref uses `export`, not `className`).
