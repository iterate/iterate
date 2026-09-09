# Proposal: ONE itx surface (the edge is a proxy), `route` vs `provide`, fully qualified stub names

> **SUPERSEDED same day** (banner added 2026-09-03) — the `route`/`provide` SPLIT was rejected:
> one verb shipped, `provide(match, target)`, positional, no options bag. `context/routing.ts`
> is deleted (the rules live in `src/context/itx-expression-rewriting.ts`) and the event that
> landed is `events.iterate.com/itx/rewrite-rule-configured`, not `capability-table/route-added`.
> The fully-qualified-identifier rule in §0 below is the part that stuck. The surface as built
> is `docs/itx-surface-as-built.md`.
>
> 2026-09-02, for Jonas. Terminology + symmetry only. Fetch stays parked (in the back of the mind:
> a fetch rule will one day be a route with a pinned pattern on `itx.fetch(...)` — nothing here
> pre-empts or blocks that).

## 0. The two rules every name below follows

1. **A public verb on itx reads as a sentence with itx as the subject** — `itx.route(path, target)`,
   `itx.provide(path, { stub })`, `itx.subscribe({ … })`. Its object is in the arguments.
2. **Every other identifier carries the noun it holds or acts on** — `#borrowedRpcStubs`, never
   `#borrowed`; `#rpcStubPagerFor(key)`, never `#pagerFor`; `BorrowedRpcStub`, never `BorrowedStub`.
   A class name does not qualify its members: inside `RpcStubDirectory` the noun is still spelled.

## 1. ONE surface: `interface IterateContext`, two implementations

Today the same acts have two names (edge → DO): `provide`→`provideCapability`, `revoke`→
`revokeCapability`, `subscribe`→`configureSubscription`, `unsubscribe`→`removeSubscription`,
`invokeCapability`→`invoke`; `enableProcessor`/`disableProcessor` exist only at the edge;
`append`/`read` exist only on the DO (the edge reaches them through the dotted fallback).

AFTER — `src/iterate-context.ts` holds the interface (this IS the itx surface, documented once):

```ts
export interface IterateContext {
  // ── navigate ──
  cd(path: string): IterateContext; // proxy: a sibling proxy; DO: the sibling's stub
  // ── the stream ──
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
  // ── capabilities ──
  invokeCapability(call: ItxExpression): Promise<unknown>;
  /** A capability ROUTE: a call that starts with `path` runs as the same call with `path` replaced
   *  by `target` (context/routing.ts). Pure data — appends `capability-table/route-added`. */
  route(path: string, target: ItxExpression): Promise<{ routedAtOffset: number }>;
  /** A LIVE capability: lend `stub` to the `itx.rpcStubs` registry under the canonical `path`, then
   *  route `path ⇒ itx.rpcStubs.get('<path>')`. The object form is where an idle policy or a
   *  timeout goes later. */
  provide(path: string, live: { stub: unknown }): Promise<{ routedAtOffset: number }>;
  /** Pop the newest route at `path` (or the one row by identity). A stub this session lent under
   *  `path` is recalled with it. */
  revoke(input: string | { routedAtOffset: number }): Promise<void>;
  // ── subscriptions + processors ──
  subscribe(input: {
    name?: string;
    target: ItxExpression | { stub: unknown };
    consumes?: string[];
  }): Promise<{ name: string }>;
  unsubscribe(name: string): Promise<void>;
  enableProcessor(
    name: string,
    ref: { source: WorkerSource; className: string; consumes?: string[] },
  ): Promise<{ name: string }>;
  disableProcessor(name: string): Promise<void>;
}
```

- **`IterateContextDurableObject implements IterateContext`** — every method native. `enableProcessor`
  / `disableProcessor` move here (they are `subscribe` with a load expression + `facets.delete`).
  `provideCapability`, `revokeCapability`, `configureSubscription`, `removeSubscription`, `invoke`
  are DELETED (renamed per call site, never by regex).
- **`IterateContextProxy implements IterateContext`** (the edge class, today `IterateContext` in
  `src/iterate-context.ts`; moves to `src/iterate-context-proxy.ts`). Every method forwards to the
  DO stub under the SAME name — `route`, `revoke`, `subscribe`, `unsubscribe`, `enableProcessor`,
  `disableProcessor`, `invokeCapability`, `append`, `read`, `waitForEvent` are one line each. It does
  physical work in exactly three places, because the client's capnweb stub lives in the edge session:
  `provide` and `subscribe({ stub })` open the rpc-stub pager and wrap the stub before forwarding;
  `revoke` / `unsubscribe` recall the lent stub after forwarding. `cd` builds a sibling proxy locally.
- `Session.authenticate().projects.get(id)` returns an `IterateContext` (the proxy). `ItxEntrypoint`
  (`env.ITX.get()` for loaded code) is unchanged.

## 2. DO-only verbs — transport plumbing, OFF the interface, one section in the DO

Workers-RPC doors the proxy's pager uses; not itx (they only make sense for a caller holding a
hibernatable socket to this DO):

| today                                   | after                                          |
| --------------------------------------- | ---------------------------------------------- |
| `rpcStubAttach({ key })`                | `attachRpcStubPager({ key }): { transportId }` |
| `rpcStubLend({ transportId, invoker })` | `lendRpcStub({ key, stub })` — the page answer |
| `transportState()`                      | `rpcStubTransportState()`                      |
| `fetch`, `alarm`, `webSocket*`          | unchanged (platform hooks)                     |

## 3. The stub machinery: two layers, fully qualified

`context/rpc-stub-directory.ts` — layer 1 is the borrowed table, layer 2 is the pager, and the
pager is literally the second `if`:

```ts
export class RpcStubDirectory {
  // LAYER 1 — the borrowed rpc stubs, keyed by registry key, returned at the idle quiesce
  readonly #borrowedRpcStubs = new Map<string, { stub: BorrowedRpcStub; inFlight: number }>();
  lendRpcStub(input: { key: string; stub: BorrowedRpcStub }): void   // provide's first lend AND every page answer
  hasBorrowedRpcStubs(): boolean
  returnBorrowedRpcStubs(): void

  // LAYER 2 — the rpc-stub pagers: hibernatable sockets that can lend a key back on demand
  readonly #pendingRpcStubPagerAttachments = new Map<string, { key: string; atMs: number }>();
  readonly #rpcStubPagesInFlight = new Map<string, { … }>();
  attachRpcStubPager(input: { key: string }): { transportId: string }
  acceptRpcStubPagerWebSocket(request: Request): Response | null
  rpcStubPagerClosed(ws: WebSocket): void
  dropRpcStubPager(transportId: string, reason: string): void
  #rpcStubPagerFor(key: string): RpcStubPagerRecord | undefined
  #pageRpcStub(key: string): Promise<{ stub: BorrowedRpcStub; inFlight: number }>

  // THE ONE CALL DOOR behind `itx.rpcStubs.get(key)`
  async invokeRpcStub(key: string, path: string[], args: unknown[]): Promise<unknown> {
    let borrowed = this.#borrowedRpcStubs.get(key);                                  // 1. have we got it? call it
    if (!borrowed && this.#rpcStubPagerFor(key)) borrowed = await this.#pageRpcStub(key); // 2. can a pager lend it back?
    if (!borrowed) throw codedError("CONNECTION_OFFLINE", `rpc stub "${key}" is offline`);
    …
  }

  listRpcStubKeys(): string[]          // presence = borrowed ∪ pager-backed (`itx.rpcStubs.list()`)
  rpcStubTransportState(): { stubs, borrowed, pagesInFlight, dormant }
}
```

Consequences: `provide` lends immediately (no first-call page); a `provide` from a caller with NO
pager is one-shot — offline after the first idle return — and the door says so in its docstring
(layer-1-only callers: tests, DO-to-DO hand-offs where the lender wakes anyway). The tutorial adds
layer 2 as one chapter: one field, one `if`, one socket.

`context/rpc-stub-relay.ts` (edge): `lendStubOverRelay` → `openRpcStubPager(durableObject,
clientRpcStub, key)`; the edge class `BorrowedStub` → `LentRpcStub` (the edge LENDS it), the DO type
`BorrowedStub` → `BorrowedRpcStub` (the DO BORROWS it — same object, each side's name);
`LentProviderStub` → `ClientRpcStub` (the client's capnweb stub, dup'd for the session);
`ProviderStub` (= `unknown`) inlined. `src/session.ts` / the proxy: `#lendStub` →
`#lendRpcStubOverPager`, `#recallStub` → `#recallRpcStub`, `#teardownKey` → `#sessionTeardownKey`.
`invoke-handle.ts`: `RpcStubHandle` stays (qualified). The `itx.rpcStubs` built-in keeps its name.

## 4. The route rename (capability table)

| today                                                      | after                                                                                                                | where                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Mount { path, target, providedAtOffset }`                 | `CapabilityRoute { path, target, routedAtOffset }`                                                                   | core-processor.ts                                                          |
| core state `mounts`                                        | `routes`                                                                                                             | core-processor.ts, snapshots, e2e helpers                                  |
| `capability-table/capability-provided { path, target }`    | `capability-table/route-added { path, target }`                                                                      | event type                                                                 |
| `capability-table/capability-revoked { providedAtOffset }` | `capability-table/route-removed { routedAtOffset }`                                                                  | event type                                                                 |
| `capabilityProvidedEvent` / `capabilityRevokedEvent`       | `routeAddedEvent` / `routeRemovedEvent`                                                                              | capability-table.ts                                                        |
| `#newestMountAt`, `#mounts()`                              | `#newestCapabilityRouteAt`, `#capabilityRoutes()`                                                                    | DO, resolver                                                               |
| `matchMount`, `pickMount`, `rewriteCall`, `MountMatch`     | `matchCapabilityRoute`, `pickCapabilityRoute`, `rewriteCallThroughRoute`, `CapabilityRouteMatch` (`routeCall` stays) | routing.ts + the table test (`mounts:` → `routes:`)                        |
| e2e `rpcStubMountPaths`                                    | `rpcStubRoutePaths`                                                                                                  | e2e/support/client.ts                                                      |
| prose "mount", "alias"                                     | "route"                                                                                                              | clean-room docs, headers, BUILD-LOG going forward (history docs untouched) |

`NO_CAPABILITY_MATCH` and `CONNECTION_OFFLINE` keep their codes. "Route" over "alias": an alias is a
synonym; ours consume pinned args and rewrite — that is routing, and it is the word fetch will use.

## 5. Commits (each green on tsc · oxlint · knip · unit+workers · e2e · tutorial-proof)

1. **Stub names + the two layers.** The directory as §3 (borrowed table keyed by key; `lendRpcStub`
   unconditional; pager = the second `if`; presence = union); relay, session, DO verbs (§2), tests,
   e2e helpers, walkthrough. One new workers-test: a stub lent with NO pager answers, then is offline
   after the quiesce alarm (the honest one-shot pin).
2. **Route rename.** §4, per call site; the table test rows read `routes:`.
3. **The mirror.** `interface IterateContext` + `IterateContextProxy` + the DO `implements`; the five
   DO verbs deleted; `enableProcessor`/`disableProcessor` native on the DO; `provide` is live-only with
   the object form; `subscribe({ stub })`. e2e re-pointed (`provide(path, expr)` → `route`).
4. **Docs.** Walkthrough + tutorial file map + BUILD-LOG; `docs/design-onion-subscriptions-processors.md`
   method names.

## 6. Judgment calls made here (say if any is wrong)

- `provide(path, { stub })`, not `provideRpcStub(...)`: rule 1 — the itx verb is the sentence, the
  object form names the noun.
- Verb `revoke` for both a route and a lent stub; the fact is `route-removed`.
- `cd` on the DO returns the sibling's Durable Object stub, typed as `IterateContext`.
- `itx.rpcStubs` (the built-in) keeps its name; only its internals and doors are renamed.
- `read` becomes `Promise`-returning on both (the RPC hop already makes it so at the edge).
