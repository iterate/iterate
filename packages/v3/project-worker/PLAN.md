# Plan of record — the consolidation waves (2026-08-19)

The owner-agreed implementation spec for increments 55-57 plus the two review passes. This file
is the survives-compaction source of truth; BUILD-LOG.md records what actually landed. Successor
to the discussion that produced LAYERS.md (which gets rewritten to five layers at the end).

## Vocabulary (final, enforced in code identifiers — CamelCased and fully qualified)

The owner's naming doctrine: verbose identifiers that leave breadcrumbs about where a concept
belongs and what it relates to. Banned words: "fold" (use reduce/reduced), "frames" for our
payloads (we send EVENT BATCHES and STATE CHANGE EVENTS; frame = WebSocket transport only),
"roster" (say THE CURRENTLY CONNECTED CLIENTS), "window" (say ScannedOffsetRange), bare
"socket" (qualify which one), "hole" (placeholders — and they die in increment 57 anyway).

| Concept                                                                             | Identifier(s)                                                                                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The routing table (an inline processor's reduced state)                             | `CapabilityTableProcessor`, state `CapabilityTable`, file `capability-table-processor.ts`, slug `"capability-table"`             |
| One row: binds a capability reference to an expression                              | `CapabilityMount` (field `mounts`); events `events.iterate.com/capability-table/capability-provided` / `capability-revoked`      |
| The prefix-matching part of a call (may take arguments)                             | capability reference (prose; `Match.matchedSegments`)                                                                            |
| A call written down as data — STORED AS ITS STRING FORM                             | expression; `parse` at rehydration, `print` canonicalizes programmatic mounts                                                    |
| The scanned contiguous offset range proof                                           | `ScannedOffsetRange` (fields scannedAfterOffset/scannedThroughOffset unchanged)                                                  |
| A reducer's persisted progress                                                      | `ReduceProgress` { reducerVersion, reducedThroughOffset } + state blob                                                           |
| The stream's operational truth (pause + breaker)                                    | `CoreStreamProcessor` (apps/os mirror name), slug `"core"`                                                                       |
| The expression roots record                                                         | the BUILT-INS: `built-ins.ts`, `buildBuiltIns`, `BuiltInsEnv` (roots/host-scope words die)                                       |
| Config-provenance mounts                                                            | config mounts (`configMounts`)                                                                                                   |
| A client's logical attachment into one itx                                          | `ItxConnection` (`connectionKey` client-chosen, scoped per context)                                                              |
| One connected episode (the history level, durable facts)                            | `ItxConnectionSession`; events `connection-session-started` / `connection-session-ended`                                         |
| One transport incarnation (client ↔ stateless worker)                               | the capnweb WebSocket (ephemeral facts `connection-opened` / `connection-closed`)                                                |
| Its identity                                                                        | `connectedAtOffset` (offset of the ephemeral connection-opened fact; socketId DIES; the relay stops minting UUIDs)               |
| Retained stub + stub pager WebSocket + page-answered invoker, per stream attached   | `CapnwebCallbackRelay` (file keeps its own name)                                                                                 |
| The DO-callable client reference that survives hibernation (owner correction 08-19) | the HIBERNATABLE RPC STUB — `HibernatableRpcStubManager` in `core/hibernatable-rpc-stub.ts`; keyed by connectionId               |
| The DO-held WebSocket that PAGES the stateless edge worker                          | the STUB PAGER WEBSOCKET (`x-itx-stub-pager`); carries EXACTLY one message, `{type: "page"}` — everything else rides Workers RPC |
| The Workers-RPC stub the paged edge hands back (wraps the retained capnweb stub)    | `RetainedCallbackInvoker` — kept WARM while traffic flows, disposed at the 60s quiesce alarm (a page gets it back)               |
| Per-absent-target delivery progress (forwarder-internal)                            | `SubscriptionDeliveryProgress` { confirmedOffset, attempt, nextAttemptAtMs, halted }                                             |

## End-state architecture (what increments 55-57 build toward)

1. STREAM (stream-durable-object.ts): append/read; pause/breaker enforcement; inline reducers
   (core + capability table) run synchronously inside the append transaction; expressions
   string-at-rest in event payloads, parsed once at rehydration.
2. ATTACHMENT = MOUNTS ONLY: capabilities (no policy), subscriptions (delivery policy),
   PROCESSORS (processor policy { source?, export?, props? } at pattern itx.processors.<slug>) —
   the facet-processors kv registry dies; props are per-instance, event-sourced, handed to the
   processor constructor.
3. DELIVERY, connected clients (corrected 08-19, owner): one-directional fire-and-forget
   `invoke(path, [events, scannedOffsetRange])` on the PAGED-IN RetainedCallbackInvoker stub —
   Workers RPC, the SAME lane as request/response calls; the WebSocket protocol is ONLY
   `{type: "page"}` ("I ought to have your stub — send it"). Consumes filter applied statelessly
   outbound, NO acks awaited, NO server cursor, NO retry ladder. The stub stays WARM while
   traffic flows (steady state = one page, then pure RPC) and is disposed by the 60s quiesce
   alarm. Client holds its own offset, checks the delivered ranges chain, heals gaps with
   read(afterOffset). Live state: the same fire-and-forget invoke per change payload.
4. DELIVERY, absent targets (webhooks, itx expressions with no live socket): ONE built-in facet
   processor `subscription-forwarder` — reduces the capability-table events into its own view of
   absent-target subscription mounts, keeps SubscriptionDeliveryProgress per target in its own
   reduced state, delivers batches by invoking the target, ONE failure policy: bounded retries
   (1s·2^n cap 30min ±20% jitter, 15 attempts) then HALT with an audit event;
   resume({ afterOffset? }) is the one recovery verb. skip/pinning die. Facets have no alarms:
   the parent arms retries from the forwarder's reported nextAttemptAtMs.
5. ITX CONNECTIONS: connect({ context, connectionKey, capabilities }) attaches to THAT
   context's stream DO — parks the CapnwebCallbackRelay's delivery WebSocket there, appends the
   ephemeral connection-opened fact (its offset = connectedAtOffset), applies the SESSION RULE
   (below), and mounts offered capabilities in that context's table (auto-revoked on close).
   `itx.clients` DIES: replaced by `itx.contexts` + a `connections` view every context has
   (get(connectionKey|connectedAtOffset) / each() fan-out / list / close). Clients are ordinary
   contexts (/clients/browser, /devices/x); granularity per LOGICAL client, tabs = connections.
   Discovery = a catalog projection at the root (DOs are not enumerable).
6. SESSION RULE (crisp, timerless, storm-proof): two capnweb WebSockets belong to the same
   ItxConnectionSession unless separated by a clean end or ≥ T of absence (T = 15 min,
   explicit). Decided at attach time from facts in hand; a crash-loop reconnect storm is ONE
   session and ONE durable fact; dirty deaths end nothing until superseded ("ended no later
   than…"). Durable session facts answer who-was-connected-Tuesday; ephemeral socket facts are
   real-time notifications; the currently connected clients list is the runtime authority.
7. PROCESSORS: unchanged model — cursor + reduce + effects; blockProcessorWhile STAYS (owner
   decision; obligation pattern remains for effects that outlive an event); userspace loader
   lane STAYS; SDK injected only where a processor can exist (kind procfacet/stateful).
8. GRAMMAR (post-57): patterns are literal path prefixes (longest wins, ties → newest, final
   segment may consume boundary args, remainder replayed); placeholders/substitute/must-use/
   $-escape DELETED (zero users); parse keeps the value grammar for call arguments; print stays
   (canonicalizes programmatic mounts into the stored string form).
9. TOPOLOGY (post-57): StatefulWorkerDurableObject DIES — stateful loaded classes are facets of
   the stream (same confinedWorker + versionedFacet; the `::` name codec and x-itx-source
   header protocol die; accepted trade: busy WS workers pin the stream). repo/files roots and
   hello-files DIE — source is plain kv; proofs seed their own sources; a future real repo
   mounts at itx.files as an ordinary capability.

## Increments

- 55: vocabulary + strings-at-rest + enablement-as-mount + props + edge sugar + dead exports +
  SDK scoping. Board green on live-12.
- 56: delivery + connections redesign (§3-§6). Proof suite rewritten (client pull loops,
  connections API, forwarder). Board green on live-13.
- 57: grammar diet + stateful retirement + files→kv (§8-§9). Board green on live-14.
- Review pass 1: completeness vs the chat decisions. Review pass 2: tightness/no-junk/"would
  Kenton have endorsed this" + LAYERS.md rewritten to five layers + BUILD-LOG + memory + report.

## Invariants (owner-ratified)

THE CLIENT IS JUST CAPNWEB: the `itx` stub a client holds is a plain capnweb proxy of a
server-side RpcTarget — there is NO client SDK, no wrapper library, and none may ever be
introduced. A client's entire dependency list is `capnweb` itself: `newWebSocketRpcSession(url)`
→ `session.authenticate().get()/.connect(...)`, and everything after that is capnweb's own
proxy semantics (dotted calls, promise pipelining, RpcTarget callbacks). Anything that would
need client-side smarts must instead live server-side behind an RpcTarget method.

## Deliberately NOT doing (owner-ratified)

Outbound coalescing (decision closed: raw sends); presence-is-subscription (dissolved into
connect-vs-watch); blockProcessorWhile deletion (kept); deleting the userspace lane (kept);
JSON-only DO doors (rejected); merging the relay and the interposition entrypoint (physics).
