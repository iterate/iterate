# Paused first-pass design: exports, not expressions

> **Status: superseded as the active recommendation.** This document records
> the initial typed-export proposal and its review constraints. The current
> recommendation in [findings.md](findings.md) is a smaller model: an event
> log, an ordinary RPC namespace, explicit inheritance/jail boundaries, and
> ordinary code mounted by private factories. Do not implement this as a new
> public descriptor or target-kind framework without a fresh decision.

This is a source-verified replacement plan for the rewrite language. It is a
design and handoff artifact only: it does not change the concurrent capability
manifest, delivery, facet, or root documentation work.

## Boundary

Keep `ItxExpression` as Cap'n Web's invocation wire representation: an
`InvokeHandle` still sends a dotted/call path and the current dispatch walker
still invokes it. Remove its use as an executable _routing policy_. No rewrite
chains, pinned call-prefix matches, `@`/`...@` filling, user-provided target
expressions, or general `cd` rewrites remain in durable configuration.

The existing product requirements found by the independent review are:

- exact dotted capability names, including `itx.clients.<device>` and
  `itx.tunnels.<number>`;
- an explicit parent context link and a default-deny jail;
- roots local to every context, roots inherited from an owner, and portable
  roots whose dispatch is intentionally stateless;
- a configuration worker pointer that tracks the newest publication without
  rewriting every descendant row;
- a live provider key supplied only by the pager attach path;
- static app adapters which receive `env.ITX`, not arbitrary environment
  bindings.

The current rule language implements all of those plus matching call arguments,
partial application and hole substitution. The independent review found no
product writer that uses the latter features. Keep a compatibility-free
conversion map for the former and delete the language.

## One durable authority

Replace `itx/rewrite-rule-configured` with two declarative event families.

```ts
type CapabilityTarget =
  | { kind: "context"; path: string; name: DottedName; steps?: ItxExpressionStep[] }
  | { kind: "facet"; name: string; spec?: FacetSpec; steps?: ItxExpressionStep[] }
  | { kind: "worker"; spec: WorkerSpec; steps?: ItxExpressionStep[] }
  | { kind: "provider"; key: string }
  | { kind: "deny" };

type CapabilityExportConfigured = {
  name: DottedName;
  target: CapabilityTarget | null;
  description?: string;
  types?: string;
};

type CapabilityScopeConfigured = {
  parent: string | null;
  jailed: boolean;
};
```

`name` is property-only dotted input below `itx`; it is parsed into a tuple of
segments before reduction. For example, an attached camera is stored as
`clients.camera`, not a free-form expression. Longest-prefix lookup selects the
head, then dispatch receives the remaining steps. `steps` are fixed trailing
steps controlled by the trusted/platform writer; they contain no holes and do
not reinterpret caller arguments.

The capability table is a `Map`/null-prototype record keyed by canonical segment
tuple. Never write it with a normal JavaScript object keyed by unchecked names.
The current expression reserved-name validation remains the admission validator
for each segment.

The one source of truth has three projections:

1. reduced `CoreState.scope` for resolver and snapshot;
2. `exports.list()` for human/model inspection, carrying effective context,
   target kind, `writtenBy`, optional capped description and optional capped
   TypeScript declaration text (`unknown` when absent);
3. the dead-provider census, which filters `{kind:"provider",key}` directly
   rather than resolving target expressions.

The manifest currently being introduced in
`context/capability-manifest.ts` remains the one table for _trusted built-in_
name, description, availability, placement and dispatch. It must expose
`exports` in place of `rewriteRules`; it must not become a second table for
dynamic scope entries.

## Lookup and confinement

Use an explicit resolver, never an object prototype:

```text
resolve(context, name):
  own = longest property-prefix export at context
  if own: return own (deny is a refusal)
  if context.scope.jailed: refuse
  if name starts with an implicit built-in at this location: return built-in
  if context.scope.parent: read that owner's scope snapshot and continue
  refuse
```

The order preserves two non-negotiable current properties: a bare parent does
not capture `append`/`readEvents`, and a local user export can shadow a normal
built-in. Platform calls retain `itx.builtins.*` as a private fixed spelling,
so the platform cannot be shadowed.

`parent` is not expressed as an export target and a child cannot write it when
jailed. A person/principal-only operation may widen/lift jail status. A scope
write records its fence atomically with its snapshot version. A change that
narrows, repoints or removes a reachable export waits the same bounded
cross-isolate lease as `rule-snapshots.ts`; addition may stay eventually
visible. The existing routing snapshot travels with the scope snapshot. This
is necessary for fetch routes and ingress and must not be split into another
cache.

`context` targets perform the destination lookup late. The root `config`
capability is a typed, platform-written Worker identity, not a self-context
pointer. A publication changes that one worker identity, while all descendant
birth subscriptions, ingress, loaded sources, and target configuration names
resolve the current head. The resulting unavailable configuration is a typed
outcome, replacing the current rewrite-specific unpublished-config refusal.

## Authority axes

There are four execution cells, but they do not require four capability
systems:

| Code                         | Context passed in                      | Other authority                                          |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------- |
| Trusted Durable Object       | selected capability facade             | bindings only when its platform class declares them      |
| Trusted stateless Worker     | selected capability facade             | bindings only when its platform entrypoint declares them |
| App Durable Object/facet     | attenuated `itx` facade                | no general env/binding escape                            |
| App stateless Worker adapter | attenuated `itx` facade in fixed props | no general env/binding escape                            |

An app adapter is the replacement for a rewrite template: a worker export with
ordinary code and fixed props. It may compose only what its passed facade can
call. Do not label an arbitrary published app module trusted or give it a
`KernelContext`; that would turn project config into a secret/binding escape.
Platform-deployed trusted entrypoints are a distinct target class with explicit
registration, not a general adapter escape hatch.

## Live capabilities and delivery

Keep `provide(name, liveStub, options)` on the wire. Its pager accept path is
the only writer that can create `{kind:"provider"}` and it owns removal after
the last socket closes. It accepts dotted property names and no expression or
null target.

Keep callback `subscribe` on the wire. The delivery work now in flight should
make its row's guarantee explicit: current internal spelling is
`live | processor | durable`; durable policy further distinguishes ordered and
fanout. This is separate from exports. It avoids the previous inconsistency
where `core-processor.ts` classified a target syntactically and
`subscription-delivery.ts` discovered its runtime brand later. Pager, relay,
borrow/release and hibernation remain untouched.

Do not delete generic durable delivery in this phase. Each cursor/fanout client
needs a demonstrated processor implementation with equivalent retry, dead
letter, concurrency, idempotency and webhook behavior before such a deletion.

## Concrete module handoff

1. Add `context/exports.ts`: input normalization, canonical dotted name parser,
   target schema, reducer, longest-prefix lookup, effective-list projection,
   provider census and scope-change fence predicate. It imports the manifest,
   but the manifest does not import it.
2. In `packages/iterate/src/api.ts`, replace rewrite event/list types and
   `rewriteRules` with export/scope types and `exports`. Retain `provide` and
   callback `subscribe` wire method signatures except that expression/null
   provision is refused.
3. In `stream/core-processor.ts`, replace
   `itxExpressionRewriteRules` with scope/export state. Reduce no executable
   target. Convert hosted-facet and source markers to typed `facet`/`worker`
   heads; retain delivery state.
4. Convert `rule-snapshots.ts` to scope snapshots with the same TTL, single
   flight, conditional version read and fence behavior. Snapshot routing remains
   co-located.
5. Replace `ItxExpressionResolver`'s rewrite loop with the lookup above,
   preserving its route/dispatch/walk behavior. Then delete
   `itx-expression-rewriting.ts` and expression hole support.
6. Convert product writers one group at a time: project publication/config,
   agent and voice installers, GitHub sync, AI linter and project collection.
   Their static target templates become explicit worker/facet/context targets
   or ordinary adapter workers. Do not migrate a writer until its target has a
   typed form.

## Required proof matrix

- root, child and global scope; own shadow; context root; owner root; portable
  root; parent; deny; jail; explicit grant; global-navigation refusal;
- publication switches root config and all child consumers follow it; an
  unpublished target returns the typed outcome;
- dotted client/tunnel providers attach, page, hibernate, redial and detach;
- old snapshots cannot answer with a removed/repointed grant after its writer
  completes; ingress/routing have the same fence;
- app adapters only receive their facade; trusted platform entries alone see
  declared bindings;
- callback delivery does not accept durable-only options; durable cursor and
  fanout continue their existing retry/alarm tests;
- processor SDK, React hooks and firmware/browser/tunnel Cap'n Web clients
  retain their existing wire operations.

No implementation agent should start the deletion pass until this matrix has a
named replacement test for every ported rule/jail/routing property and the
concurrent capability-manifest work has settled.

## Amendments from independent review round 2

The initial design was not sufficient for handoff. The following additions are
part of the proposal, not optional follow-up work.

1. Add a platform/principal-only head:

   ```ts
   | { kind: "builtin"; name: TrustedBuiltInCapabilityName; steps?: ItxExpressionStep[] }
   ```

   It is the only way to grant a local built-in through a jail. A `context`
   target never means a destination's `builtins`, because that would allow a
   destination export to shadow a platform operation.

2. Make export admission a first-class pure function keyed by the stamped
   writer class: platform, principal, loaded code, or schedule. In a jail,
   non-principal writers may only write an allowed provider for their own key,
   a structurally valid facet, or a deny. A loaded-code context target is valid
   only if its own facade can already resolve `cd`; it cannot write `builtin`.
   Worker/facet source and fixed steps retain the existing loaded-code source,
   `builtins`, `cd`, signing-secret and scheduled-batch admission checks. The
   platform alone writes `config*`; a principal alone lifts a jail.
3. Model root `config` as a platform-written **worker head**, with a typed
   platform source `(repository path, commit OID, manifest/cache identity)`.
   It replaces the self-referential `config.modules` producer. `namedWorker`
   must recognize that stamped head as vouched. Its unavailable result carries
   `validUntil`, so delivery can distinguish unpublished configuration from a
   stale snapshot.
4. Specify matched-call behavior: an invocation at the final matched segment
   applies its arguments after the target's fixed steps. Fixed steps never pin
   or transform caller arguments. This preserves a provider function call
   without restoring prefix-argument matching.
5. Add compare-and-set cleanup:

   ```ts
   ifTarget?: CapabilityTarget
   ```

   or the narrower `ifProviderKey` for provider removal. The last pager close
   removes only still-matching provider exports and associated routes/
   subscriptions, so a re-lend wins over a delayed close.

6. Scope fencing matches the existing contract: platform writes always fence;
   an addition fences when it shadows anything currently resolving; parent or
   jail changes fence; removals and repoints fence. Do not reduce this to
   reachability of an own row.
7. Scope all claims precisely: durable _exports_ are typed. Subscription,
   ingress and fetch-route invocation targets remain expressions during this
   phase, but resolve through typed exports and are never rewritten. Port their
   hosted-facet, push and webhook classification structurally before deleting
   the old resolver helpers.

Implementation details also fixed by the review: key the table by canonical
dotted string, not segment-array identity; paths in `context` targets are
absolute; provider names retain the `itx.` wire prefix; types use the existing
`declaration` field consistently and are excluded/capped from resolver
snapshots; `writtenBy` derives from the stamped caller source; and parent-chain
reads consume the normal context-hop budget.
