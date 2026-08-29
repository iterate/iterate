# ITX kernel shape — design (WIP, 2026-08-29)

Working out the internal shape. **Nothing here is implemented yet** — `itx.connections`/`connect()`
still exist in the code and get deleted as part of landing this.

## Decisions

1. **Delete `itx.connections` + `connect()` for now.** The live-client registry is being reshaped; it
   returns later as the `rpcStubs` kernel primitive + a thin `connections` _view_ over it, once the
   surface is right.
2. **`itx.rpcStubs.provide` is for LIVE rpc stubs ONLY.** Restorable/durable references (Kenton's
   `[restore]` machinery) are a SEPARATE concern — NOT managed by `rpcStubs`. (Reverses an earlier
   suggestion that folded them together.)
3. **Flat kernel + one uniform layer.** The surface is a flat set of kernel primitives (log, kv,
   loader, facets, hibernatable stubs, env bindings — all peers) with ONE expression/mount/dotted
   layer on top. A mount always resolves, via an itx expression, to exactly one kernel primitive.
4. **The surface is GRANTED by app config (exokernel).** A context exposes exactly the kernel
   primitives its config grants — authority is explicit, not ambient. Two contexts in one worker can
   have different surfaces.

## The context surface — `ItxRpcTarget`

One RpcTarget. Built-in namespaces are **getters returning their own RpcTargets**; verbs are methods;
unknown dotted roots fall through to the capability table (the prototype-hop fallback we already built).

```ts
import { RpcTarget } from "capnweb";
import type { Expression } from "./core/expression.ts";
import type { StreamEvent, StreamEventInput } from "./core/events.ts";

class ItxRpcTarget extends RpcTarget {
  // ── kernel built-ins, as getters (present only if GRANTED — else the getter throws) ──
  get kv(): Kv; // durable key/value           (kernel: KV binding)
  get stream(): Stream; // this context's event log     (kernel: the DO substrate)
  get secrets(): Secrets; // write-only secret store      (kernel: SECRETS_KV binding)

  // ── verbs ──
  /** Identify this context. */
  whoami(): { projectId: string; path: string };

  /** Navigate to a SIBLING context (rename of contexts.get). Returns THAT context's surface — its own
   *  config, its own grants. A real RpcTarget, so `itx.cd('/x').kv.get(k)` pipelines natively. */
  cd(path: string): ItxRpcTarget;

  /** Load + run confined code as a capability (kernel: the LOADER). */
  runScript(source: WorkerSource, ...args: unknown[]): Promise<unknown>;

  /** Mount a NAMED capability = bind a path to an itx expression (the naming layer over the kernel).
   *  Live-ref provision (parking an RpcTarget) is deferred until `rpcStubs` lands — for now, targets
   *  are expressions. */
  provide(input: {
    path: string;
    target: string | Expression;
  }): Promise<{ providedAtOffset: number }>;

  /** THE universal dispatch door — every dotted miss folds into this. */
  invokeCapability(call: { path: string[]; args?: unknown[] }): Promise<unknown>;

  /** The generic expression door (mid-path args the dotted sugar can't spell). */
  invoke(call: string | Expression): Promise<unknown>;

  // installPrototypeInvokeCapabilityFallback(ItxRpcTarget): unknown roots (config `mounts`, surfaced
  // `bindings` like `ai`) fall through to invokeCapability → the capability table.
}
```

## Kernel built-ins (each its own RpcTarget)

```ts
/** Durable key/value, project-prefixed (kernel: the KV binding). */
class Kv extends RpcTarget {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true }>;
  list(prefix?: string): Promise<{ keys: string[] }>;
}

/** This context's append-only event log (kernel: the DO substrate). */
class Stream extends RpcTarget {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;
  subscribe(input: {
    name?: string;
    target: string | Expression;
    consumes?: string[];
  }): Promise<{ name: string }>;
}

/** Write-only secrets; values re-emerge ONLY as {{secret:NAME}} at egress (kernel: SECRETS_KV). */
class Secrets extends RpcTarget {
  set(name: string, value: string): Promise<{ ok: true }>;
}
```

## Future kernel primitive: `rpcStubs` (the deferred live-stub registry)

Deferred (decision #1) — the reshaped replacement for `connections`. It IS the hibernatable-stub kernel
primitive exposed as a registry; `connections` returns later as a thin _view_ over the transport-backed
entries. Shape, so the rest of the design lines up with it:

```ts
/** Registry of LIVE rpc stubs (kernel: the hibernatable-stub mechanism). Live refs only — restorable/
 *  durable refs are a SEPARATE concern (decision #2). NO `revoke` method — the handle disposes. */
class RpcStubs extends RpcTarget {
  /** Register a live stub. With an explicit `key`, idempotent RE-PROVIDE: any existing entry at that
   *  key is DISPOSED and replaced (connect / reconnect / replace, one verb — reconnect-same-key.test.ts).
   *  Without a key, one is generated. Returns a DISPOSABLE handle carrying the key — dispose it to
   *  revoke; capnweb also auto-disposes it when the provider's session ends (⇒ the entry goes offline).
   *  There is no separate revoke-by-key. */
  provide(target: unknown, opts?: { key?: string }): ProvidedStub;

  /** Address a held stub by key — a pipelinable InvokeHandle. Absent/offline ⇒ CONNECTION_OFFLINE. */
  get(key: string): unknown;

  /** Presence — the keys currently held (backs the future `connections` view + fan-out via list+map). */
  list(): { key: string }[];
}

/** The provider's handle. Disposing it removes the live entry (get(key) ⇒ offline). Same op whether
 *  disposed explicitly, via `using`, or by capnweb at session-end. Reconnect = provide again w/ the key. */
interface ProvidedStub extends Disposable {
  readonly key: string; // what others mount / address: itx.rpcStubs.get(key)
}
```

So `provide(target, { key })` collapses "connect / reconnect / replace" into one verb: same key ⇒ the
old stub is disposed and the new one takes its place, and every mount aliased to `rpcStubs.get(key)`
keeps resolving across the swap. Disposal (explicit OR session-end) removes the live entry ⇒ offline;
reconnect re-provides. This is the kernel-level version of the reconnect property.

## Config → surface

Split the **static, serializable config** (what the config repo/`APP_CONFIG` declares — the grants)
from the **runtime deps** (the actual bindings + the DO host, wired at construction).

```ts
/** STATIC config (serializable — lives in the config repo). Declares the GRANTED surface. A built-in
 *  absent here is absent from the surface. */
interface ContextConfig {
  kv?: { prefix?: string }; // grant kv
  secrets?: true; // grant secrets
  runScript?: true; // grant code loading (the loader)
  provide?: true; // grant the naming/mount layer
  cd?: true; // grant sibling navigation
  bindings?: string[]; // raw env binding NAMES to surface as itx.<name> (env.AI, …)
  mounts?: Record<string, string>; // config mounts: name → itx expression (string form)
  // stream + whoami: TBD whether always-granted or gated (see open questions).
}

/** RUNTIME deps — the kernel mechanisms live on the DO (host); raw bindings come from env. */
interface ContextRuntime {
  host: HostStub; // the DO: log, facets, hibernatable-stub manager, dispatch
  env: Env; // raw bindings: KV, LOADER, service bindings, env.AI, …
  projectId: string;
  path: string;
}

/** Build the surface from static config + runtime deps — wires EXACTLY the granted built-ins, then
 *  hands them to `ItxRpcTarget`. This is the ONE audit point for "what authority does this context
 *  have". */
function itxForContext(config: ContextConfig, rt: ContextRuntime): ItxRpcTarget;
//   assembles: kv? → new Kv(rt.env.ITX_KV, prefix); stream → new Stream(rt.host);
//              secrets? → new Secrets(rt.env.SECRETS_KV); runScript? → a loader closure over rt.env.LOADER;
//              bindings → { name: rt.env[name] } surfaced via the fallback; mounts → seeded into the table.
```

## Resolution, in one paragraph

Declared getters/methods resolve directly. A granted-but-absent built-in getter **throws** "not granted
in this context" (authority is explicit). Unknown dotted roots — config `mounts`, surfaced `bindings`
like `itx.ai` — fall through the prototype-hop fallback into `invokeCapability({path,args})` → the
capability table (shadowing, config mounts, revoke). `cd(path)` returns the sibling context's own
`ItxRpcTarget`. Everything bottoms out at one flat kernel primitive.

## Open questions

- Which built-ins are **always granted** (stream? whoami?) vs config-gated (kv, runScript, secrets)?
- With `connect()` gone, how does a client attach at all? Likely: dial `/api` → get the ROOT context
  surface; live-ref provision (`rpcStubs`) deferred, so no client-provided capabilities until it lands.
- Does `provide` ever take a live ref, or strictly expressions until `rpcStubs`?
- Placement: the raw kernel mechanisms (log, `ctx.facets`, the hibernatable-stub manager) live on the
  DO; `ItxRpcTarget` is a **projection** over them. Is `ItxRpcTarget` constructed in the DO, or in the
  `/api` relay over a host stub? (Today `Itx` is built in both places — keep that seam.)
- Naming: `ItxRpcTarget` vs `Itx` (current). `cd` vs `contexts.get`. `runScript` vs `workers.run`.

```

```
