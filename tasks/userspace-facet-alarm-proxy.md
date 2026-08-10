---
state: done
priority: high
size: medium
tags: [os, streams, processors, facets, userspace, alarms]
---

# Userspace facet keepalive: how a loaded facet reaches the parent's alarm proxy

## Shipped (Option A1, in the StreamProcessorDurableObject-base PR)

Chosen: **Option A, sub-variant A1** — the three `ProcessorFacetAlarmProxy`
verbs (`proxySetAlarm`/`proxyDeleteAlarm`/`proxyGetAlarm`) live directly on the
itx `Stream` capability (`StreamRpcTarget`), forwarding to the Stream DO's
existing proxy methods. No auth gate beyond project access (a fire only replays
`handleAlarm` into the stream's own facets — a harmless self-wake). This mirrors
the stateful-worker path exactly (`workers.get(ref).setAlarm`), which the
boot-reconcile timing argument showed is the only channel a loaded worker
(`env.ITX`-only) can use.

What landed:
- `StreamRpcTarget.proxy{Set,Delete,Get}Alarm` + `pnpm generate:itx-api`.
- `StreamProcessorFacet` base in `iterate/sdk`: `parentAlarms` dials
  `streams.get(path).proxySetAlarm` per call (the `itxProjectStream` session
  pattern); `createProcessor` + `recovery` are the only authoring seam.
- `StreamDurableObject.#dialProcessorFacet` userspace branch:
  `loadStatefulClass(ref)` → `ctx.facets.get(name, …)` → the same
  configure/wake/handleAlarm protocol as built-in facets, with a source-cacheKey
  abort on config-repo changes.
- E2e proof: `userspace-facet-processor-revival.e2e.test.ts` — a slow
  recovery-backed userspace facet, killed mid-work, revived by the parent alarm
  to completion.

Open questions below are resolved: A1 (not A2); ungated (project access); phased
into one PR (loader + alarm proxy together); `proxyDeleteAlarm` stays a no-op.

The design rationale is preserved below for the record.

Follow-up to [dual-mode-stream-processors](./dual-mode-stream-processors.md),
bullet 2 (the `facet-processor{userspace}` loader). The loader itself is easy
(`worker-runner.loadStatefulClass(ref)` → `ctx.facets.get(name, () => ({class}))`,
exactly as `StatefulWorkerDurableObject` already does). This doc is about the
**one genuinely hard sub-problem**: keepalive alarms for a *loaded* facet.

## The mechanism today (built-in facets)

A facet may not own a native alarm (`ProcessorFacet` throws if you define
`alarm()` — workerd#6810: a failed `setAlarm` poisons the facet's output gate).
So the runner's keepalive/obligation adapter goes through a **proxy to the
parent Stream DO**, which owns the one real platform alarm and replays each fire
into the facet's `handleAlarm`.

- The registry runs against a `DurableObjectState` facade
  (`facetProcessorDurableObjectState`, `processor-facet.ts:126`) whose
  `storage.setAlarm/deleteAlarm/getAlarm` are overridden to dial
  `parentAlarms().proxy{Set,Delete,Get}Alarm(...)`.
- `ProcessorFacetAlarmProxy` (`processor-facet.ts:66`):
  ```ts
  export type ProcessorFacetAlarmProxy = {
    proxySetAlarm(scheduledTimeMs: number): MaybePromise<unknown>;
    proxyDeleteAlarm(): MaybePromise<unknown>;
    proxyGetAlarm(): MaybePromise<number | null>;
  };
  ```
- `parentAlarms(identity)` is **abstract** and resolved **per call** (a stub must
  not outlive its RPC turn). The built-in returns the parent stub:
  ```ts
  // processor-facet-durable-object.ts
  protected parentAlarms(identity): ProcessorFacetAlarmProxy {
    return this.env.STREAM.getByName(identity.parentName) as unknown as ParentStreamStub;
  }
  ```
- The parent implements the three verbs over its shared facet-alarm slot
  (`stream-durable-object.ts`): `proxySetAlarm` (1298, merges into the
  earliest-time slot), `proxyDeleteAlarm` (1309, no-op today), `proxyGetAlarm`
  (1312). They **must tolerate reentrancy** — the keepalive re-arms from inside
  the parent's own `handleAlarm` replay.

## The constraint that makes userspace hard

The built-in facet is the OS worker's own class, so it has `env.STREAM`. A
**loaded userspace class** runs in the config-repo isolate via
`DynamicWorkerRunner`, whose env is `{ ITX: <scoped> }` (+ a project-egress
fetcher). It has **no `env.STREAM`** — so `parentAlarms` has nothing to dial.

What it *does* have: `env.ITX`. The facet's stream handle already dials back to
the parent through itx (`ProcessorFacetHost.stream` is a colocated itx stream).
So the alarm proxy wants to ride the same channel.

Everything below only matters for userspace processors that **owe background
work** (the `blockProcessorWhile`/`runInBackground`/keepalive obligation
pattern). A **pure reducer** (the guestbook shape) never arms an alarm, so it
works today with a `parentAlarms` that throws. **We can ship pure-first and pick
an option below for the alarm-owing case** — that phasing is orthogonal to which
option we choose.

---

## Option A — expose the alarm proxy on the stream's itx surface (Jonas's preference)

Put `proxySetAlarm`/`proxyDeleteAlarm`/`proxyGetAlarm` on the itx `Stream`
capability, and have the userspace facet's `parentAlarms()` dial itx:

```ts
// The userspace facet base (published from iterate/processors/cloudflare):
protected parentAlarms(identity: ProcessorFacetIdentity): ProcessorFacetAlarmProxy {
  const at = identity.path;
  const env = this.env;
  // Resolved per call (matches the built-in): each verb opens, uses, disposes
  // its own itx session, like withProject / itxProjectStream.
  return {
    async proxySetAlarm(ms) { using p = await env.ITX.get(); return p.streams.get(at).proxySetAlarm(ms); },
    async proxyDeleteAlarm() { using p = await env.ITX.get(); return p.streams.get(at).proxyDeleteAlarm(); },
    async proxyGetAlarm() { using p = await env.ITX.get(); return p.streams.get(at).proxyGetAlarm(); },
  };
}
```

On the OS side, the itx `Stream` RPC target (`StreamRpcTarget` in
`rpc-targets.ts`) forwards to the Stream DO's existing `proxySetAlarm` et al.

**Two sub-variants** for where the verbs live:

- **A1 — directly on `Stream`:** `streams.get(path).proxySetAlarm(ms)`. Simplest;
  smallest diff. But it grows the public `Stream` surface with an
  internal-looking verb, and it's discoverable/callable by any project code.
- **A2 — a dedicated gated sub-node:** `streams.get(path).facetAlarms.setAlarm(ms)`
  (or fold onto the existing `.processor` node). Keeps the top-level `Stream`
  surface clean and gives one obvious place to put the authority guard. **Lean.**

**Pros**
- Uses the channel the loaded worker already has; no new binding, no loader
  plumbing. Symmetric with the facet's stream handle, which already rides itx.
- Capability-native: the proxy is "just another itx verb," typed in the public
  contract and available to *any* future off-DO processor host, not only facets.

**Cons / must-resolve**
- **Authority.** A public `proxySetAlarm` lets any itx caller arm the stream
  DO's facet-alarm. Blast radius is bounded (a stream is per-`(projectId, path)`,
  and the caller already owns the project), and the fire only replays
  `handleAlarm` into facets (idempotent-ish) — so worst case is a self-inflicted
  wakeup, not data loss. Still, decide: (a) accept it as low-risk and leave it
  ungated; (b) gate to loopback / the hosting facet identity; (c) put it behind
  an admin/internal authority tier. A2 makes (b)/(c) localizable.
- **Reentrancy / no deadlock.** The keepalive re-arms *from inside* the parent's
  `handleAlarm` replay. With the built-in that's a direct in-isolate call; over
  itx it's `facet → ITX → project routing → parent.proxySetAlarm` while the
  parent is still awaiting `handleAlarm` on that facet. The parent's
  `proxySetAlarm` is a synchronous kv write that returns without awaiting the
  in-flight `handleAlarm`, so it should not deadlock — but this needs an explicit
  test (a userspace facet that re-arms during handleAlarm) before we trust it.
- **Per-call session cost.** Every `setAlarm` opens+disposes an itx session.
  Fine for keepalive cadence (seconds+), not for hot paths.

---

## Option B — parent hands a scoped alarm-proxy capability at `configure()`

`#dialProcessorFacet` already calls `facet.configure({parentName, projectId,
path})`. Add an `alarmProxy` capability (an RpcTarget the parent mints that
forwards to its own `proxySetAlarm`), and store it for `parentAlarms()`.

- **Pro:** tightest scoping — only the hosted facet ever gets the capability; no
  public itx surface.
- **Con:** fights the lifecycle model. `parentAlarms` is contractually resolved
  **per call** precisely because "a stub captured once would outlive its RPC
  session" (`processor-facet.ts:122`). A configure-time stub retained for the
  facet's lifetime pins it and risks the disposed-stub failure mode. Would need
  re-delivery every incarnation (like `__stashSelfRef`) and careful retention —
  more moving parts than A for the same result.

---

## Option C — give the loaded worker a scoped parent-alarm binding

Have `DynamicWorkerRunner` inject a per-facet binding (e.g. `env.PARENT_ALARMS`)
that resolves to the parent Stream DO's proxy verbs, so `parentAlarms()` mirrors
the built-in (`env.PARENT_ALARMS.proxySetAlarm(...)`).

- **Pro:** mirrors the built-in exactly; no public itx surface; scoped to the
  parent only.
- **Con:** new loader machinery — the binding must be minted per-facet with the
  parent identity baked in and threaded through `loadStatefulClass`/the runner's
  env construction. More surface than A, and it special-cases the facet loader
  vs the ordinary stateful-worker loader.

---

## Option D — sidestep the proxy: parent-driven revival from committed state

Record the keepalive obligation as a **committed stream event** instead of the
runner's private progress store, so the parent can arm its own alarm from
committed state and revive the facet on fire — no facet→parent alarm call at all.

- **Pro:** no alarm channel for userspace at all; the parent already fires every
  facet's `handleAlarm`.
- **Con:** changes the obligation model itself (private runner keepalive →
  public committed obligation). Largest semantic change; affects built-ins too;
  probably out of scope for "make userspace facets work."

---

## Recommendation

**Go with A (Jonas's preference), sub-variant A2**, and phase it:

1. **Now:** land the loader for **pure userspace facets** — `parentAlarms()`
   throws a clear "keepalive alarms not available for userspace facets yet."
   The guestbook-shape processor works end to end.
2. **Then:** add `streams.get(path).facetAlarms.{setAlarm,deleteAlarm,getAlarm}`
   to the itx contract, forward to the Stream DO's existing proxy verbs, and
   point the userspace facet base's `parentAlarms()` at it. Add the reentrancy
   test (re-arm during `handleAlarm`) and decide the authority gate.

Why A over B/C: it reuses the channel the loaded worker already has, adds no
binding/loader machinery, and generalizes to *any* off-DO processor host — the
same reason facet stream handles already ride itx. B and C both buy tighter
scoping at the cost of lifecycle/loader complexity, and the scoping win is small
because the blast radius is one already-owned project stream.

## Open questions (Jonas)

1. **A1 vs A2** — verbs directly on `Stream`, or a dedicated `facetAlarms`
   sub-node? (I lean A2.)
2. **Authority on `proxySetAlarm`** — leave ungated (accept the self-wakeup
   blast radius), gate to loopback/facet identity, or an internal tier?
3. **Phasing** — OK to land pure-userspace-facets first (alarm-owing throws),
   with the itx alarm proxy as the immediate follow-up? Or do you want the alarm
   proxy in the same PR as the loader?
4. **`proxyDeleteAlarm` is a no-op today** — leave it a no-op over itx too, or
   make delete real as part of this?
