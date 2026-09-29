# Independent Opus core-model review — round 1

**Reviewer:** Claude Opus 5.5, xhigh, read-only. The raw prompt and JSON are
private at `/tmp/core-simplification-opus/round-1-prompt.md` and
`/tmp/core-simplification-opus/round-1.json`.

## Decision

Approve a narrow vertical slice: replace executable rewrite rules with a typed
dotted-name export table. Retain the resolver, snapshot/fence mechanics,
`itx.builtins` as the platform spelling, pager/relay, and durable
cursor/fan-out delivery. Reject a JavaScript prototype facade, trusted
`PublishedModule` adapters, a new provider event protocol, and a broad
descriptor/type registry in this slice.

Product code needs only dotted names selecting a facet, worker, live stub or
context hop, fixed trailing invocation steps, a parent link, and a late-bound
`config` pointer. That is a name table, not a new expression language.

## High-confidence constraints

1. **A prototype facade cannot cross this RPC boundary.** Cap'n Web and workerd
   reject non-`Object.prototype` values, `dispatch.ts:75` uses `Reflect.get`
   and would follow a parent beyond a jail, and `structuredClone` at
   `dispatch.ts:224` drops inherited entries. Lookup must be explicit: own
   longest-prefix export; deny if jailed; implicit root; parent snapshot.
2. **Snapshots and revocation fences survive.** Stateless entrypoints and edge
   ingress require cached policy; Cloudflare cannot invalidate all isolates.
   A narrowing keeps the bounded fence in `rule-snapshots.ts:16-40`. Rename it
   to a scope snapshot; do not claim its behavior was removed.
3. **`config` is late-bound.** Every context's birth row follows root config
   across publications. Delivery, ingress and fetch routes need a typed
   `{context: "/", name: "config"}` lookup and typed unpublished outcome.
4. **Dotted provider names are wire compatibility.** Firmware uses
   `itx.clients.<device>` and tunnel uses `itx.tunnels.<n>`. Preserve
   `provide("itx.clients.<device>", stub)` and longest property-prefix match.
   Firmware, extension and CLI also use callback `subscribe` over Cap'n Web.
5. **Precedence is security policy.** own export, jail deny, implicit context
   root, parent. A parent cannot take `append`/`readEvents`; own names still
   shadow normal built-ins. Platform code spells `itx.builtins.*`.
6. **Trusted means platform-deployed.** Project config and installers are app
   code with `env.ITX` only. A user adapter remains a normal worker export with
   fixed props; only a platform-export kind may receive broader bindings.

## Delivery finding

`subscribe(callback)` already uses `lendRpcStubOverPager` under
`subscription:<name>` (`iterate-context.ts:450-472`). The live-only delivery
branch is roughly 33 lines (`subscription-delivery.ts:727-759`), so a new
pager push protocol breaks firmware without real reduction.

The actual defect is policy inference: `targetOwnsProgress` derives a mode
from rules (`core-processor.ts:189`), while delivery later evaluates a runtime
target (`subscription-delivery.ts:932`). Persist `Delivery = push | ordered |
fanout` at configuration. Callbacks set `push`; expression targets select a
durable policy. Refuse `afterOffset`/`ordered` for callbacks instead of
silently ignoring them. Keep cursor/fan-out: they implement at-least-once
delivery and cannot be removed until every use has a concrete durable
processor replacement.

## Recommended source shape

```ts
type ExportTarget =
  | { kind: "context"; path: string; name: string; steps?: ItxExpressionStep[] }
  | { kind: "facet"; name: string; spec?: FacetSpec; steps?: ItxExpressionStep[] }
  | { kind: "worker"; spec: WorkerSpec; steps?: ItxExpressionStep[] }
  | { kind: "provider"; key: string }
  | { kind: "deny" };
type ExportConfigured = {
  name: DottedName;
  target: ExportTarget | null;
  description?: string;
  types?: string; // absent means unknown
};
type ScopeConfigured = { parent: string | null; jailed: boolean };
type Delivery = "push" | "ordered" | "fanout";
```

Create `context/exports.ts` for normalization, reduction, lookup, list,
census filtering and fence predicate. Rename `rule-snapshots.ts` to scope
snapshots but keep cache/fence. Keep resolver routing, dispatch and fixed-step
walking. Merge the root descriptions/placement records into one small record;
do not add generic runtime public/physical type parameters. Return capped
description/types data from `exports.list`, with `writtenBy`; render untrusted
descriptions as data in prompts.

## Boundaries and validation

Delete rewrite language, hole/merge syntax, rule reduction, expression/null
provide branch, rule-specific classification, and no-op `platformHook` birth
row. Port tests for jail/default deny, child roots, routing, loop refusal,
app/global wall, snapshot fencing, providers and explicit delivery. Keep
pager/relay, fetch upgrade/splice, durable delivery, facet host, worker loader
and `buildBuiltIns` bodies.

Independent fixes: share `isLoadedWorkerPlatformFailure` with facet host;
validate bounded `consumes`; heal `connectEventLog` range gaps; bound only live
subscription push; and move five platform table calls to `itx.builtins`.

Required evidence: full suites plus worker/e2e/spec, perf budgets (push p50
≤500ms, p95 ≤1.5s, ≥1,000 events/s, 200 subscribers <2s, 50 processors <5s),
slow residency, recreated-seed preview, deploy-reset/hibernation soak, fence
and push-drop telemetry, and a Cloudflare log query with no unexplained error.

The reviewer estimates this slice removes roughly 900–1,600 production lines
and ~3,100 obsolete tests. It is a material simplification, not by itself a
50k→20k reduction.
