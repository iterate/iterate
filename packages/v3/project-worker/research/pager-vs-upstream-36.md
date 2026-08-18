# The Pager vs upstream capnweb #36 — will Kenton's abstraction slot in?

Research date: 2026-08-18. Question: how similar is our Hibernatable Pager API to what Kenton
would build for capnweb #36, and does our code delete cleanly the day upstream ships?

**Headline finding: upstream already shipped its abstraction — and it is not a pager.** Kenton
merged persistent stubs (`ctx.restore()` + the `[restore]()` symbol method + storable stub
tokens) into workerd in June–July 2026, flag-gated behind `allow_irrevocable_stub_storage`.
It covers stubs to _re-derivable, self-addressable_ targets. It deliberately does **not** cover
our case — outbound stubs to **live, unaddressable peers** (a browser's capnweb capability
retained in a stateless relay). Plain RpcStubs are rejected from storage by design. So the
Pager is not a polyfill that upstream deletes; it is the userland answer to the half of the
problem upstream has not solved (and per capnweb #58's closure, does not currently plan to
solve at the library level). Where upstream _does_ apply, it plugs in behind our existing
5-method stub facade at rename/adapter level.

---

## 1. What upstream actually built (piece by piece)

Kenton's #36 plan, stated 2025-09-25 and restated 2026-03-11
(https://github.com/cloudflare/capnweb/issues/36):

> - You would terminate the Cap'n Web session from the browser in a Worker, not a DO. […] the
>   DO perceives everything as regular Workers RPC […]
> - A DO would be able to create and return RPC stubs that are marked in such a way that the
>   system knows how to recreate them after hibernation […]
> - A DO would also be able to store _outbound_ RPC stubs into a space that survives
>   hibernation, e.g. to maintain a list of current subscriber callbacks.

All three pieces live in the Workers runtime, "none in Cap'n Web" — confirmed: the capnweb
library has zero hibernation/restore code today (grep of
`~/src/github.com/cloudflare/capnweb-authoritative/src`, clean).

The shipped mechanism (workerd, branch `kenton/persistent-stub`, merged 2026-06-16 via
`cdecb3771`; commits `f1aad10e5`, `7d7bfa8da`, `e160290d7`, `b720d551a`, `c2f682dfc`,
`e0e8703e8`; hardening `d9094ff3e` + de-experimentalization `a27c16011` 2026-06-25; multi-hop
RPC fix `f58c99c05` 2026-07-20):

- **`ctx.restore(params)`** (on both `ExecutionContext` and `DurableObjectState`,
  `src/workerd/api/global-scope.h:339-350`, `src/workerd/api/restore.{h,c++}`): invokes the
  current entrypoint's **`[restore](params)`** method (`import { restore } from
"cloudflare:workers"` — `src/cloudflare/internal/workers.d.ts:67`), which must return a
  ServiceStub/RpcStub (or an RpcTarget/function, implicitly stubified). The returned stub is
  backed by a **channel token carrying a restore chain** (base = the worker's own self-token
  - the storable `params`).
- **Replay on use**: "Persistence works by replaying the restore call whenever the value is
  loaded from storage again" (global-scope.h doc comment). On use, the runtime dispatches a
  restore custom event chain-hop by chain-hop (`RestoreServiceCustomEvent` /
  `restoreRpcStub()`, commits `e160290d7`, `f58c99c05`); `[restore](params)` re-materializes
  the capability on a **fresh instance**; the live channel is held while in use.
- **The outbound space is DO storage itself**: `await ctx.storage.put('stub', stub)` /
  `storage.get('stub')` round-trips a live stub
  (`src/workerd/api/tests/persistent-stubs-test.js`, `Store` DO at line 466).
- **Gating** (`compatibility-date.capnp:1286-1305`, commit `d9094ff3e`): only stubs minted via
  `ctx.exports` or `ctx.restore()` are persistent; **both** the storer and the stub's target
  (and every chain member) must set `allow_irrevocable_stub_storage`, checked at mint AND at
  use; a plain `new RpcStub(target)` or an env service binding **cannot be stored** (test
  `plainRpcStorageError`, `storePlainServiceBindingDefault`, `storeActorStubFromEnvBinding`).
- **Officially temporary**: the flag doc, verbatim — "IRREVOCABLE STUB STORAGE IS INHERENTLY
  INSECURE. […] THIS FEATURE IS EXPERIMENTAL AND TEMPORARY. Cloudflare WILL retract this
  feature and WILL break all stored stubs at some point in the future, as soon as an auditable
  and revocable alternative is available."

Piece 2 (inbound recreatable stubs) is the same mechanism from the other side: a DO returns
`await ctx.restore(params)` instead of a raw RpcTarget, so the client-held stub is a token
that replays instead of a reference that pins. (Known wrinkle: `e0e8703e8`'s TODO admits a
restore-event lifetime currently "unnecessarily block[s] hibernation of a parent actor that is
part of the restore chain into a persistent stub in a facet" — active WIP.)

Reconnection at the capnweb layer (#58) was closed 2025-10-30 as "completed" with
`onRpcBroken` (+ AbortSignal support, capnweb `f956cb4`) — i.e. detection is provided,
**rebuilding is DIY**. Kenton's own reconnect taxonomy (issue #58 comment) lists "recreate
stubs by replaying the same calls" as option 3; nothing more shipped.

## 2. Mapping upstream onto our modules

Our side (all under `packages/v3/project-worker/src/`):

| Our piece                                                                                                                                                                                  | Upstream piece                                                                                                                                                           | Shape verdict                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| capnweb terminates at `/api` only; DO speaks pure Workers RPC (`core/itx-surface.ts:1-2`, `stream-durable-object.ts:19-23`)                                                                | #36 piece 1, verbatim                                                                                                                                                    | **Identical.** This is what makes everything else swappable.                                                                                                                                                                                                                                    |
| `core/hibernatable-pager.ts` — WS to the DO, accepted via hibernation API, `PagerRecord` in the attachment                                                                                 | No equivalent. Upstream replaces the _channel_ with a restore-chain token; there is no socket and no "wake"                                                              | **Different transport, same moral role** (a durable name for a dormant capability). Upstream's version only works when the target is self-addressable; ours exists precisely because a browser client is not.                                                                                   |
| `HibernatableStubs.park(socketId, meta)` + roster derived from attachments (`core/hibernatable-stub.ts:75-86`)                                                                             | `ctx.storage.put(key, stub)` — storing IS parking; roster = your own storage rows                                                                                        | **Conceptually same** ("stamp storable data; derive the roster from it — nothing to reconcile after a wake"). Our `meta` is exactly his `params`: storable data sufficient to re-identify the capability. Mechanically different home (socket attachment vs storage row).                       |
| `invoke(socketId, path, args)`: wake Page → relay lends an `Invoker` leg → burst → drop at quiescence (`core/hibernatable-stub.ts:88-116,146-170`; relay side `core/itx-surface.ts:64-92`) | Replay-on-use: runtime dispatches a restore event to the target, `[restore](params)` re-materializes, channel held while in use                                          | **Same shape rotated 90°.** Both are materialize-on-use / hold-per-use / drop-after. His runtime _dials the target_ (addressable); ours _pages the holder_ over the socket (unaddressable). Our wake→attach handshake (`activateStub`) is the userland stand-in for his restore-event dispatch. |
| The DO-side calling shape: `stubInvoke(key, segments, args)` / `stubFanOut` / `stubList` / `stubConnections` / `stubClose` — the 5-method facade (`stream-durable-object.ts:751-813`)      | A restored stub is a **native** stub — you'd write `loaded.a.b(args)`, no invoke door                                                                                    | **Adapter-level.** Every internal caller already passes `(key, segments, args)`; swapping the backing from "borrow leg → `invoker.invoke(path,args)`" to "`storage.get(key)` → walk segments → call" is a ~5-line change inside the facade, invisible to all callers.                           |
| `drop`/`closed`/close-to-revoke: socket dies ⇒ authority dies; roster reads dead as dead (`core/hibernatable-stub.ts:118-134`, `stream-durable-object.ts:703-708`)                         | **Nothing.** Persistent stubs are irrevocable by name; no liveness signal; failure surfaces only at call time; the promised endgame is a separate auditable grants store | **Ours is stronger and is the endgame shape.** Our mount-table + naturally-expiring socket is what the flag doc says will _replace_ stub storage. Adopting upstream storage here would be a regression for presence (`itx.clients.list`) and revocation.                                        |
| Reconnect heal: `parkClient` replaces the predecessor by `connectionKey` (`stream-durable-object.ts:719-741`, relay `core/itx-surface.ts:125-139`)                                         | #58 closed as "detect via `onRpcBroken`, rebuild yourself"                                                                                                               | **We already implement his option 3.** No upstream piece to slot in.                                                                                                                                                                                                                            |
| Piece 2 (inbound): we sidestep — no inbound stub into the DO ever exists; relay-side `RpcTarget`s re-address the DO by name per call (`core/itx-surface.ts:145-161`)                       | `ctx.restore()`-minted inbound stubs                                                                                                                                     | **Sidestep remains valid** ("holding a DO stub does not prevent hibernation" — Kenton, #36, 2025-11-24). Optional future elegance, zero pressure.                                                                                                                                               |

### Why upstream cannot replace the Pager for live clients

`[restore](params)` runs on a **fresh instance of the target worker**. A stateless relay's
fresh isolate has no browser socket; `params` cannot summon a browser. And the stub we would
need to store — the retained capnweb provider — is a plain RpcStub, which the runtime rejects
from storage outright (`plainRpcStorageError`). Kenton's own motivating example for piece 3
("a list of current subscriber callbacks") is, for browser-origin callbacks over capnweb,
exactly the case his shipped mechanism cannot express. The only physics-compatible answers are
(a) a socket the DO can page — ours — or (b) capnweb-level session resumption where "restore"
means "wait for the client to reconnect and re-offer" — which is our
reconnect-and-replace-by-`connectionKey`, and which upstream has not built (#58 closed at
detection-only).

## 3. Verdict

**Confidence that upstream "just slots in" where it applies: HIGH. Confidence that upstream
makes our pager deletable: LOW — deliberately, and that is fine.** The premise inverts: the
day upstream ships already mostly happened (June–July 2026), and what shipped is
complementary, not a replacement. No redesign is indicated.

- Our architecture is piece 1 of his plan verbatim; that seam is what lets any upstream
  mechanism plug in behind the DO.
- For **re-derivable providers** (remote apps with stable addresses, facets, dynamic workers,
  worker entrypoints): `ctx.restore()` can replace pager+relay per provider class, behind
  `stubInvoke` — rename/adapter level.
- For **live browser clients** (the pager's actual job): upstream has nothing and signals
  nothing imminent; the pager stays.

The 2–3 places most likely to need real work if/when we adopt upstream for some provider
class:

1. **Roster split** — today `stubList`/`stubConnections`/`stubFanOut` iterate socket
   attachments (`#stubs.all()`); a storage-backed provider class would need the facade to read
   a second source (storage rows) and merge. Confined to `stream-durable-object.ts`; nothing
   outside the facade notices. (Presence semantics must STAY socket-derived — a stored stub
   looks healthy while dead.)
2. **`Invoker.invoke(path, args)` → native calls** — the segment-walk moves from the relay's
   `Invoker` (`core/itx-surface.ts:50-54`) into the facade. Small, one call-site.
3. **Revocation model** — never adopt `allow_irrevocable_stub_storage` semantics for anything
   currently revocable-by-socket-close; the flag is documented as temporary and
   will-be-broken. Our mount-table (grant rows, revoke = pop) + socket liveness is the shape
   the flag doc promises to replace stub storage _with_.

**Cheap seam adjustments now: none required.** The two properties that make future adoption
cheap are already true: (a) meta stamped at park is pure storable data — identical in kind to
`[restore]` `params`; (b) every consumer goes through the 5-method facade / `HibernatableStubs`
and never touches sockets or attachments directly. The only discipline worth stating: keep it
that way — no new caller may reach around the facade to `pagerAttachment`/`pagerSocketFor`,
and presence must never be inferred from anything but the socket roster.

## 4. Timeline reality

Actively built, by Kenton personally, and recent:

- workerd #6087 ("Support for Hibernatable RPC Targets … Enable capnweb hibernation within
  Durable Objects", filed 2026-02-16): Kenton, 2026-02-25 — "Yes, this is something I plan to
  work on, perhaps next quarter. It's a big project, though." He then did:
- `kenton/persistent-stub` merged 2026-06-16 (`cdecb3771`; API authored 2026-05-02,
  `7d7bfa8da`); target-side flag enforcement + opened to external users 2026-06-25
  (`d9094ff3e`, `a27c16011` — "we want to let people outside Cloudflare play with this",
  "we still don't think this is the long-term solution"); multi-hop-over-RPC restore fix
  2026-07-20 (`f58c99c05`, notes the production edge runtime path). Latest related activity
  <1 month before this research.
- capnweb #36 remains open (retitled "WebSocket Hibernation" 2026-05-22 by a Cloudflare
  triager); last substantive comments 2026-03-11/18. capnweb the library: no hibernation
  code, matching the stated division of labor.
- capnweb #58 closed 2025-10-30 "completed" at detection-only (`onRpcBroken`).

## Sources

- Ours: `src/core/hibernatable-pager.ts`, `src/core/hibernatable-stub.ts`,
  `src/core/itx-surface.ts`, `src/stream-durable-object.ts` (line refs inline above);
  prior analysis `research/kentonv/lessons-for-clean-room.md` §6,
  `research/kentonv/b-capnweb.md`.
- Upstream issues: cloudflare/capnweb #36 (comments 2025-09-23 → 2026-03-18), #58 (closed
  2025-10-30), #84 (dupe, closed); cloudflare/workerd #6087 (Kenton comment 2026-02-25; user
  cost report 2026-08-11).
- Upstream code (local checkout `~/src/github.com/cloudflare/workerd`, HEAD 2026-08-17):
  commits `f1aad10e5`, `7d7bfa8da`, `e160290d7`, `b720d551a`, `c2f682dfc`, `e0e8703e8`,
  `cdecb3771`, `d9094ff3e`, `a27c16011`, `f58c99c05`; files
  `src/workerd/api/restore.{h,c++}`, `src/workerd/api/global-scope.h:339-350`,
  `src/workerd/io/compatibility-date.capnp:1286-1305`,
  `src/cloudflare/internal/workers.d.ts:67`,
  `src/workerd/api/tests/persistent-stubs-test.js`.
- capnweb library checkouts `~/src/github.com/cloudflare/capnweb{,-authoritative}` (no
  hibernation/restore code; `f956cb4` onRpcBroken AbortSignal).
