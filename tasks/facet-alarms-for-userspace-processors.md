---
status: done
size: medium
branch: stateful-worker-alarms
---

> **Shipped** as option 1 (parent-owned alarm): `setAlarm`/`getAlarm` reserved
> verbs on the worker capability, `StatefulWorkerDurableObject` persists
> `{ atMs, ref }` + mirrors its real alarm and replays fires into the facet
> class's `alarm()` (rethrow = native retry), `statefulWorkerAlarms` in
> `iterate/sdk` presents the standard `ctx.storage` alarm API, and the
> template guestbook registers with `{ recovery: true }`.

# Facet alarms: parent-owned alarm proxy so userspace processors get keepalive recovery

Userspace stream processors (PR #2073's guestbook shape: a `StreamProcessor`
hosted in a project worker's `IterateDurableObject` behind a native wake
subscription) cannot opt into `{ recovery: true }` today: the keepalive arms
durable alarms, stateful dynamic workers are hosted as workerd FACETS inside
`StatefulWorkerDurableObject`, and facet storage has no alarms. Every
delivery then fails with "alarms are not yet implemented for SQLite-backed
Durable Objects" — proven live on PR #2073 (the recovery wiring was written,
failed on first delivery, and reverted with the finding documented at the
registration site in `config-repo-template/worker.ts`). Until fixed,
userspace processors are limited to idempotent at-head appends; consequential
background obligations need a platform-hosted DO.

## Ground truth (workerd source + Cloudflare, researched 2026-07-17)

- The throw is workerd's DEFAULT `ActorSqlite::Hooks::scheduleRun()`
  (`src/workerd/io/actor-sqlite.c++` ~1214). In `server.c++` (~1199), actors
  WITH a parent — every facet — always get the throwing default hooks:
  `// TODO(someday): Support alarms in facets, somehow.` Still on workerd
  main as of 2026-07-17. Root actors get real `ActorSqliteHooks` wired to the
  `AlarmScheduler`.
- Structural, not a flag: `AlarmScheduler` keys alarms by
  `{uniqueKey, actorId}` — no facet dimension exists, and `FacetManager`
  exposes nothing alarm-adjacent. Not implemented in production either:
  tracking issue [workerd#6810](https://github.com/cloudflare/workerd/issues/6810)
  (open, unlabeled) has one Cloudflare reply — "Facets currently don't
  support alarms. In agents, we made it so calling `.schedule` inside a
  subagent proxies up to the parent." Their agents SDK does exactly that
  (root DO owns the one real alarm + schedule table; facets RPC up; root
  `alarm()` dials back into facets).
- Nasty failure mode: the facet's `setAlarm()` APPEARS to succeed (it only
  writes SQLite metadata); the hooks throw later on the commit path through
  the output gate, breaking unrelated in-flight RPCs on the actor.
- Waiting for upstream is not a plan: 13 months of facets shipping without
  alarms, GA'd 2026-04 without them, no roadmap commitment anywhere.

## What the keepalive actually requires of an alarm transport

From `stream-processor-keepalive.ts` / `durable-object-processor-durability.ts`
(the machinery is transport-free by design — `armAlarm` is an injected seam;
the registry touches alarms only via `ctx.storage.{get,set,delete}Alarm`):

- Millisecond-precision arming. The backoff ladder's first rung is 10s
  (`KEEPALIVE_ALARM_LEAD_MS`); minute-granular transports are unacceptable.
- At-least-once fire delivery to `handleAlarm`. A LOST fire is unrecoverable
  (the KV record proves the desire; nothing re-checks it). Late (minutes),
  early, and duplicate fires are all tolerated — the keepalive self-gates on
  its persisted `armedAtMs` and every path is idempotent.
- `AlarmInvocationInfo` is informational only (spans); the durable
  revivals-counter mark is the enforcement.

## Evaluated options

1. **Parent-owned alarm via a reserved platform verb — RECOMMENDED.**
   `StatefulWorkerDurableObject` is a root actor; its alarms work everywhere.
   Add `setAlarm(atMs | null)` to the reserved dynamic-worker platform
   surface (precedent: `kill` on `DynamicWorkerRpcTarget`; declared methods
   win over the dynamic-dispatch fallback). The facet dials it on ITS OWN ref
   — `itx.workers.get(SELF_REF).setAlarm(...)` through the ordinary ITX
   loopback; the template already exports its ref (`GUESTBOOK_APP_REF`). The
   parent stays dumb: persist one `{atMs, ref}` cell (the ref rides the call,
   solving fire-time "which recipe do I boot"), mirror it into the real
   alarm, and on fire replay `invokeCapability({ path: ["alarm"], args:
   [alarmInfo] })` into the facet — the registry's existing `handleAlarm`
   does all slice routing and re-arms through the same verb. Failures
   rethrow, so workerd's root-actor alarm retry covers delivery. Survives
   facet rebuilds and parent evictions (state in parent storage). Meets every
   requirement above. This is the Cloudflare-endorsed shape (agents SDK).
2. **Registry alarm transport backed by the platform Scheduler — rejected.**
   The keepalive arms/disarms on every delivery batch; journaling schedule
   events at that cadence is spam, script-execution routing is heavyweight
   for a 10s-lead watchdog, and the Scheduler can't address stateful refs
   today. Scheduler stays the tool for domain schedules, not incarnation
   keepalives.
3. **Wait for / patch upstream workerd — rejected.** No roadmap; a real fix
   needs new addressing machinery (facet-dimension alarm keys + delivery
   path), not a carryable patch.
4. Variants considered and folded in: a dedicated alarm-relay DO namespace is
   option 1 with an extra DO the parent already is; a parent-side heartbeat
   poll fails the 10s-precision requirement; injecting a parent binding into
   the facet is blocked (`ctx.facets.get` accepts only `{ class, id }` — no
   props, and worker env is per-isolate, not per-DO).

## Implementation sketch

1. Platform (~60 lines): `setAlarm` on `DynamicWorkerRpcTarget` (stateful
   refs only) → `StatefulWorkerDurableObject` persists `{atMs, ref}` +
   mirrors the real alarm; `alarm()` on the wrapper boots the facet from the
   stored ref and replays `["alarm"]` into it, rethrowing on failure.
2. SDK (~30 lines): `facetAlarmState(ctx, env, selfRef)` in `iterate/sdk` —
   a `DurableObjectState`-shaped shim whose `storage.kv` stays the facet's
   own but whose alarm calls route to the parent. Zero registry changes: the
   template passes the shim to `createStreamProcessorRegistry` instead of
   `this.ctx`.
3. Template: resurrect PR #2073's reverted recovery wiring (in git history —
   commit c066130fa's parent has it): `{ recovery: true }`, `alarm()` →
   `registry.handleAlarm`, contract consuming the revival fact via
   `PLATFORM_STREAM_EVENTS` (already published in `iterate/processors` for
   exactly this).
4. Proof: the guestbook wake e2e already detects broken arming (it failed
   instantly when facet arming broke); add one targeted e2e for the fire
   path — arm a near-term alarm through the shim, assert the fire reaches
   `handleAlarm` (observable as the revival fact when work was owed), plus
   the preview lane.

Related: `tasks/agent-llm-deadline-alarm.md` (platform-side alarm-slice
consumer), `tasks/stream-processors-as-facets.md` (asked "can a facet own a
stream subscription and alarms?" — answers now: subscription YES, proven on
PR #2073; alarms NO, this task).
