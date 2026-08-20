# Layering ideation — the clean target (greenfield, then reconciled)

Jonas called the incremental "name the seam with `unknown` casts" approach _gross_. This is the
elegant target we refactor **toward** — designed from first principles, then mapped to a real diff.
Rule throughout: **prefer deleting/unifying; every abstraction states what it REMOVES.** Honors the
settled calls (dumb longest-prefix matcher, one `itx` object, string-half primary, routed-door
revocation, the pager is permanent, no native irrevocable stubs).

---

## 1. The layer stack — five layers, each ONE responsibility

```
  EventLog  ──▶  Stream  ──▶  Context
                   │            │  (+ Processors: reduces over a Stream source)
                   └────────────┴──── live capabilities ride ──▶  SturdyRefTransport (pager/relay)
```

| Layer                  | One responsibility                                                            | Interface (append/read/…)          | On the Pi?                  |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------- | --------------------------- |
| **EventLog**           | durably store + serve events; assign offsets; dedup by idempotency key        | `append`, `read`                   | ✅ (a plain array/SQLite)   |
| **Stream**             | EventLog **+ fan-out**: notify subscribers on commit                          | `+ subscribe`                      | ✅                          |
| **Processor**          | fold a Stream **source** into derived state, with a cursor + gap-repair       | `reduce`, `snapshot`               | ❌ (needs code)             |
| **Context**            | a Stream **+ a capability router** (itself a Processor); dispatch calls       | `+ invoke`                         | ❌ (needs invoke-atomicity) |
| **SturdyRefTransport** | turn a durable **name** into a live stub on demand (restore); dispose at idle | `park`, `restore(page)`, `dispose` | ❌ (reuses the edge's)      |

The load-bearing boundary: **a Pi implements `Stream` (= `EventLog` + `subscribe`) and NOTHING else.**
Processors, the router, and the transport all live wherever code + atomicity live (a CF DO), and
consume the Pi as a _source_. "No other context has to know" falls out because callers only ever
hold a `Stream` or `Context` handle — never the implementation.

The single reason a Processor is _co-located_ with its Stream today is **invoke-atomicity** (the
routing table must be transactionally exact). A bare Stream has no `invoke`, so nothing is forced
onto it. That is the whole justification for the split — write it down and it stops being muddy.

---

## 2. The polymorphic seam — uniform-async, REAL types, zero casts

**The gross thing:** `deps.context` is typed `{ append; read }` and then `contexts.get` does
`as unknown as { append; read; invoke }`, with `unknown` returns because the own-path is _sync
closures_ and a sibling is an _async DO stub_. The `unknown` + `as unknown as` are a direct symptom
of trying to unify sync and async under one loose type.

**The fix: make the whole seam `Promise`-returning, and type it with the real event types.** The
own-path is already async in substance (`append` is `async`, `invoke` is `async`; only `read` is
sync, and wrapping it costs one microtask on a path that then does real I/O anyway).

```ts
// core/stream.ts
export interface Stream {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): Promise<StreamPage>; // StreamPage = { events; scannedThroughOffset }
  subscribe(listener: StreamListener, options?: SubscribeOptions): Promise<Subscription>;
}
export interface Context extends Stream {
  invoke(call: string | Expression): Promise<unknown>;
}
```

Now **every backing satisfies the same interface with no cast**:

- a sibling `DurableObjectStub<StreamDurableObject>` — Workers-RPC methods already return Promises of
  the real types; it _is_ a `Context` structurally (the contravariance problem that forced the old
  `as unknown as` **disappears** because the interface now uses `StreamEventInput`/`StreamEvent`,
  not `unknown[]`);
- the own parent — `localContext(this)`, a five-line adapter that awaits `this`;
- a Pi — its `RpcTarget` returns Promises over capnweb.

```ts
export type ResolveContext = (path: string) => Context; // was: (path) => { append; read }  + a re-cast
```

**Removes:** the `IterateContextHandle`-with-`unknown`-returns idea, both `as unknown as` casts, and
the sync/async bifurcation. **Deletes** the need for `core/iterate-context.ts`'s loose handle — the
real `Stream`/`Context` types replace it.

---

## 3. The expression codec — typed AST, and `boundaryArgs` deleted

**Today:** `type Step = string | [method, ...args]` (a nested array where `typeof step === "string"`
means get and an array means call), and `match()` carries a `boundaryArgs` special case + a
`matchedSegments` count + a `remainder`.

**Typed AST** (string-at-rest unchanged — `parse`/`print` convert):

```ts
// core/expression.ts
export type Value = string | number | boolean | null | Value[] | { [k: string]: Value };
export type Step =
  | { get: string } // property read
  | { call: string; args: Value[] }; // method call
export interface Expression {
  root: string;
  steps: Step[];
}
```

`walkSteps`, `evaluate`, `apply` all read named fields (`step.get` / `step.call`) instead of
`typeof`+index gymnastics.

**Delete `boundaryArgs`.** A mount's left side is names-only (already true —
`parseCapabilityPath` rejects calls). So a mount matches a **name-prefix** of the call's steps, and
**everything after it — gets AND calls-with-their-args — is the `remainder`, replayed on the
evaluated target.**

```ts
export function matchMount(mount: string[], call: Expression): { remainder: Step[] } | null;
// resolve: value = evaluate(target); value = replay(remainder, value); if runtimeArgs: value = value(...runtimeArgs)
```

The only thing `boundaryArgs` did that the remainder can't is "call the _target itself_ with runtime
values" — but that is **`runtimeArgs`** (the delivery batch, the fetch `Request`), which is already a
separate concept (`extraArgs`). So there is exactly one "apply args to a resolved value" idea, not
two. **Removes:** the `boundaryArgs` field, the `i !== path.length - 1` boundary branch in `match`,
and the ambiguity of "does a name match a call or a get" (answer: a mount name matches the call step
of that name; its args land in the remainder).

---

## 4. Sturdy refs — recognize TWO naming layers, don't add a fifth scheme

The "four rhyming string schemes" (itx-expressions, mount `providedAtOffset`, DO-names,
`connectionId`) are **not four peers.** Collapse them honestly:

- **Logical layer — an itx expression IS the sturdy ref.** `restore` = _evaluate it in scope_
  (`connections.get('<id>')`, `contexts.get('/x')`, a capability path — three roots of ONE
  namespace). Mount identity (`providedAtOffset`) is just the _revocation handle_ for one such
  expression, not a naming scheme.
- **Physical layer — the DO-name** (`prj_x.iterate/path`) is what `contexts.get('/x')` _compiles
  to_. It lives BELOW expressions; it is not a peer scheme.

So there are two layers, not four schemes. **Do NOT introduce a parallel `SturdyRef` value type** —
that would be the fifth scheme the rule forbids. Instead, three surgical moves that _harden and type
the one scheme_:

```ts
// core/expression.ts — phantom brand, zero runtime
export type Ref<T> = string & { readonly __ref?: T }; // an itx-expression string, typed
```

1. **Liveness as a type, where it varies.** A `connections.*` ref may be offline; a `contexts.*` /
   capability ref is restore-by-eval. Encode it: `type LiveRef<T> = Ref<T> & { readonly __live: true }`
   returned by `park`, so a caller _sees_ "this call may throw `CONNECTION_OFFLINE`". **Removes** the
   ambient "is this offline?" surprise.
2. **Unguessable connection id.** `connectionId = String(connectedAtOffset)` is sequential and
   guessable, and it is _string-interpolated_ into the target (`itx.connections.get('<id>')`). Mint a
   random id (`crypto.randomUUID()`), keep the offset only as the _audit_ fact's offset. **Removes**
   the guessable-bearer-token smell.
3. **Mint via `print()`, never interpolation.** `#parkAsTarget` builds the target with
   `` `itx.connections.get('${id}')` `` — the one injection-shaped seam. Build it as a typed
   `Expression` and `print()` it. **Removes** the string-interpolation seam the printer's quoting
   exists to defend.

**Removes overall:** the illusion of four schemes, the guessable id, and the interpolation — while
adding _zero_ new runtime concept (a phantom brand is erased at compile time).

---

## 5. The processor's source — a parameter, not a hard-coded `this`

**Today:** a facet processor is driven by the _own_ DO's commit pump (`append` → push batch to every
facet). The source is hard-coded to `this` DO's log.

**Decouple:** a Processor consumes a `StreamSource`. Local and foreign differ only in the source.

```ts
// core/stream.ts
export interface StreamSource {
  read(afterOffset: number, limit: number): Promise<StreamPage>;
  subscribe(onBatch: (batch: StreamBatch) => void): Promise<Subscription>; // batch = { events; scannedOffsetRange }
}
```

- **Local source** = `{ read: page => this.read(...), subscribe: onBatch => this.#pump.tap(onBatch) }`
  — the existing commit pump _is_ the local `subscribe` (push-on-commit, preserving ordering/atomicity).
- **Foreign source** = a remote `Stream` handle (the Pi) — `read` + `subscribe` over the wire, reusing
  the cross-DO delivery that **already exists** (the subscription-forwarder to absent targets + the
  connected lane).

The Processor's reduce / cursor / gap-repair logic is **identical** for both. **Removes** the hidden
coupling "a facet's source is its own log," and makes the Pi work with _zero new machinery_ — a
processor just points at a foreign `StreamSource`.

---

## 6. The DO becomes a thin composition (the 1200-line god object dissolves)

`StreamDurableObject` already has the right _members_ (`#eventLog`, `#itxConnections`, `#alarmArmer`,
`#capabilityTableProcessor`). The target: each layer is its own module with the clean interface
above, and the DO is their ~200-line composition:

```ts
class StreamDurableObject implements Context {
  #log = new EventLog(this.ctx.storage, path); // append/read/dedup
  #stream = new Stream(this.#log, this.#subscribers); // + fan-out (the pump)
  #router = new CapabilityRouter(this.#stream); // the inline reduce + resolve  → invoke
  #transport = new SturdyRefTransport(this.ctx, this.#connections); // pager/relay/park/restore
  #processors = new ProcessorHost(this.#stream /* as StreamSource */);
  // append/read/subscribe delegate to #stream; invoke delegates to #router; the fetch/pager lane to #transport.
}
```

A Pi ships only `EventLog` + `Stream` (+ the trivial `subscribe`). **Removes** the god-object; each
layer becomes independently testable with a legible interface.

---

## 7. Reconciliation — what's a real diff vs. already there

| Move                                           | Already partly there                  | New work                                                                     | Net               |
| ---------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- | ----------------- |
| `Stream`/`Context` real-typed, async           | `StreamEventLog`, ownContext closures | make `read` async on the face; `localContext` adapter; retype `deps.context` | **deletes** casts |
| Typed `Expression` AST + delete `boundaryArgs` | `parse`/`print`/`match` exist         | rewrite Step as a union; drop `boundaryArgs`; keep `runtimeArgs`             | −1 concept        |
| Harden + type the ref                          | expressions already are the scheme    | random id; `print()` not interpolation; phantom `Ref<T>`/`LiveRef<T>`        | −1 smell          |
| `StreamSource` decouple                        | pump + cross-DO delivery exist        | extract the source interface; local = pump, foreign = remote Stream          | −1 coupling       |
| DO composition                                 | members already extracted             | give each a real interface; DO delegates                                     | −god object       |

Nothing here fights a settled decision: the matcher stays dumb longest-prefix (now over typed
steps), the string-at-rest form is untouched, one `itx` object, routed-door revocation, the pager is
permanent.

---

## 8. The three highest-leverage clean-ups (do these first)

1. **Real-typed, uniform-async `Stream` / `Context` interfaces** (§2). This is the direct antidote to
   the "gross" seam — it _deletes_ the `unknown` returns and both `as unknown as` casts, and it is the
   foundation that makes a Pi and a DO genuinely interchangeable. Do this before the `deps.context`
   rename; it replaces it.
2. **Typed `Expression` AST + delete `boundaryArgs`** (§3). The single biggest muddiness drop in the
   codec: named steps instead of nested arrays, and one "apply args" concept (`runtimeArgs`) instead
   of two.
3. **`StreamSource` as a processor's parameter** (§5). The decouple that makes off-platform streams a
   _configuration_, not a subsystem — reusing delivery/read/reduce, removing the "source = my own log"
   coupling.

Then the cheap hardening (§4: random id, `print()`, phantom `Ref<T>`), and the DO composition (§6)
falls out naturally once the layer interfaces exist.
