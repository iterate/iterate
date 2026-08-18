// The StatefulWorkerDurableObject — a dedicated "durable object runner" for stateful dynamic workers (mirrors
// apps/os's StatefulWorkerDurableObject + DynamicWorkerRunner). ONE instance per stateful capability, named
// `{projectId}::{path}::{className}:{sourceHash}` (set by StreamDurableObject's #workersView), each hosting
// the user's `DurableObject` class DIRECTLY as a single facet "target" with its OWN isolated SQLite. The
// capability host reaches it by NAME (a namespace binding).
//
// Facet method calls are NATIVE (`replayPath` = `await facet.method(args)`), exactly like apps/os — no fetch
// tunnel. Two things make native work; both are apps/os patterns we now mirror:
//   1. Invoke with `Reflect.apply(handler, facet, args)`, NOT `facet[method].apply(facet, args)`. The latter
//      reads `.apply` off the RPC stub's method proxy (capnweb treats it as a pipelined remote path) and passes
//      the facet stub as an argument, so workerd serializes the stub → DataCloneError "Durable Object Facet
//      stubs cannot be transferred between Workers". A dynamically-loaded facet stub may NEVER be serialized as
//      an RPC value (workerd `requireAllowsTransfer()` throws unconditionally for dynamic entrypoints); a method
//      call executed HERE, in the owning DO, returns plain data and never serializes the stub.
//   2. Deploy-scoped loader cacheKey (see #facet): loader isolates are cached across deployments but this DO is
//      durable, so a facet built from a prior deployment's isolate is cross-Worker to the new parent — and thus
//      un-transferable. Folding CF_VERSION_METADATA.id into the key mints a fresh isolate each rollout.
//
// Every hosted DO class gets `env.ITX` = a stub to its OWNING capability host (the StreamDurableObject for
// this runner's {projectId, path}), plus `globalOutbound` = that same host — IDENTICAL to what a stateless `code`
// cap gets. So a stateful worker calls sibling capabilities with `this.env.ITX.invokeCapability("itx.x", [..])`
// (or imports `itxFromStub` from the injected `itx.js` for the dotted `itx.x.y(..)` surface), and a plain
// `fetch()` inside the class routes out through the host's egress. Mirrors apps/os, whose loaded stateful
// worker gets `env.ITX = ctx.exports.ItxEntrypoint({props})` — same "reach your own host" binding.
//
// The `fetch` lane (WS/streaming, where a 101 can't ride RPC) forwards to the facet's own `fetch`.

import { DurableObject } from "cloudflare:workers";
import { confinedWorker } from "./core/agent-runtime.ts";
import { stepGet, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { stringifyName } from "./core/names.ts";
import { itxEntrypointFor } from "./iterate-context-entrypoint.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";

const FACET_NAME = "target";
const VERSION_KEY = "stateful:version";

interface Env {
  LOADER: WorkerLoader;
  // The context namespace (same worker). A stub to the owning context is minted into each facet's
  // env.ITX + globalOutbound AND is where this runner resolves its source expression — the
  // runner reads NO KV directly; source comes through the host like everything else.
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
  // Deploy identity (wrangler `version_metadata`). Folded into the loader cacheKey so a redeploy
  // mints a FRESH loaded isolate — a facet built from a prior deployment's isolate cannot be
  // called from the new parent. Mirrors apps/os workerVersion(env). Absent locally → "unversioned".
  CF_VERSION_METADATA?: { id: string };
}

/** The RPC-lane payload the capability host forwards (mirrors apps/os's StatefulWorkerDurableObject input). */
export interface StatefulInvoke {
  source: Expression; // a source EXPRESSION resolved (via the host) to the facet's modules — not a file path
  className: string;
  method: string; // may be DOTTED ("counters.add") — the host joins remaining path parts with "."
  args: unknown[];
}

export class StatefulWorkerDurableObject extends DurableObject<Env> {
  /** Evaluate a source EXPRESSION through the OWNING context's dispatch into a `{ name: source }`
   *  modules map — the same repo-agnostic resolution the host uses for stateless workers. */
  async #loadModules(source: Expression): Promise<Record<string, string>> {
    return (await this.#hostStub().invoke(source)) as Record<string, string>;
  }

  /** The OWNING context's codec name, reconstructed from this runner's name
   *  `{projectId}::{path}::{className}:{sourceHash}` (set by StreamDurableObject's workers view). */
  #hostName(): string {
    const name = this.ctx.id.name;
    const [projectId, path] = name?.split("::") ?? [];
    if (!projectId || !path)
      throw new Error(
        `stateful worker: runner name ${JSON.stringify(name)} is not {projectId}::{path}::{className}:{sourceHash} — reach this DO via the capability host, never by raw id`,
      );
    return stringifyName({ projectId, path });
  }

  /** A stub to the OWNING capability host (module resolution + the hosted class's env.ITX rides
   *  the interposition entrypoint instead — see iterate-context-entrypoint.ts). */
  #hostStub(): DurableObjectStub<StreamDurableObject> {
    return this.env.CONTEXT.getByName(this.#hostName());
  }

  /** Construct (or restart on a source change) the facet hosting the user's `className`, keeping its storage
   *  across restarts. The modules are loaded DIRECTLY (no host wrapper) — the class they export IS the facet. */
  #facet(modules: Record<string, string>, className: string): Fetcher {
    const version = hashSource(JSON.stringify(modules));
    // ⚠️  LEARNING: the deploy version MUST be in the loader cacheKey. Worker-Loader isolates are cached
    // ACROSS deployments, but this DO is durable and survives redeploys — so without a per-deploy key
    // component a rollout leaves the runner reusing a PRIOR deployment's isolate, whose facet is
    // cross-Worker to the new parent and thus un-transferable (same DataCloneError family). Mirrors
    // apps/os's cacheKey (WORKER_SELF + workerVersion(env)). CF_VERSION_METADATA.id changes every deploy.
    const deployVersion = this.env.CF_VERSION_METADATA?.id ?? "unversioned";
    // The confinement contract (env.ITX + globalOutbound = the owning host) is confinedWorker's.
    const worker = confinedWorker(
      this.env.LOADER,
      `stateful:${deployVersion}:${this.ctx.id.name}:${version}`,
      "cap.js",
      modules,
      itxEntrypointFor(this.ctx, this.#hostName()),
    );
    const klass = worker.getDurableObjectClass(className);
    if (!klass) throw new Error(`stateful worker does not export class "${className}"`);
    // Abort + recreate the facet on a source change (same storage) — apps/os's version-marker pattern.
    const prev = this.ctx.storage.kv.get<string>(VERSION_KEY);
    if (prev !== undefined && prev !== version) this.ctx.facets.abort(FACET_NAME, "source changed");
    if (prev !== version) this.ctx.storage.kv.put(VERSION_KEY, version);
    return this.ctx.facets.get(FACET_NAME, () => ({ class: klass })) as unknown as Fetcher;
  }

  /** RPC lane: resolve/restart the facet and call the method NATIVELY on it (apps/os `replayPath`). A DOTTED
   *  `method` walks the intermediate segments receiver-preservingly before the terminal apply. The awaited
   *  result is plain data, so the facet stub never crosses back to the host. */
  async invokeCapability(input: StatefulInvoke): Promise<unknown> {
    const facet = this.#facet(await this.#loadModules(input.source), input.className);
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════
    // ⚠️  GOTCHA — INVOKE FACET/RPC-STUB METHODS WITH Reflect.apply, *NEVER* `stub[m].apply(stub, args)`.
    // Reading `.apply` (or ANY property) off an RPC stub's method proxy is a capnweb PIPELINED REMOTE PATH;
    // calling it passes the facet stub as an argument, so workerd SERIALIZES the stub — and a Worker-Loader
    // (dynamic-entrypoint) facet stub may NEVER be serialized (`requireAllowsTransfer()` throws
    // unconditionally, workerd server.c++) → `DataCloneError: Durable Object Facet stubs cannot be
    // transferred between Workers`. `Reflect.apply` invokes the function's [[Call]] directly (no property
    // read, thisArg not serialized); a plain `await facet.increment(2)` is equally safe. This one idiom cost
    // a full investigation (we wrongly blamed account entitlement) — see FACET-RPC-INVESTIGATION.md. DO NOT
    // "simplify" this to `facet[input.method](...input.args)` captured into a variable and `.apply`-d.
    // The SAME rule governs a DOTTED path: walk intermediates with awaited `Reflect.get(receiver, seg)` and
    // apply ONLY the terminal — receiver-preserving, exactly apps/os `replayPath` (live-capability.ts).
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════
    // `stepGet` (not bare Reflect.get) so the plain objects walked after the first await never
    // expose Object.prototype inheritance — workerd filters the stub hop itself.
    const path = input.method.split(".");
    let receiver: unknown = facet;
    for (let i = 0; i < path.length - 1; i++) {
      receiver = await stepGet(receiver as object, path[i]);
      if (receiver == null)
        throw new Error(
          `stateful worker: "${input.className}" path "${input.method}" hit ${String(receiver)} at "${path[i]}"`,
        );
    }
    const handler = stepGet(receiver as object, path[path.length - 1]);
    if (typeof handler !== "function")
      throw new Error(`stateful worker: "${input.className}" has no method "${input.method}"`);
    return await Reflect.apply(handler, receiver, input.args ?? []);
  }

  /** WS/streaming lane: forward the request to the facet's own `fetch`. The module + class ride in headers set
   *  by the host (small — names, not source). A 101 upgrade tunnels straight through DO→DO→facet. */
  async fetch(request: Request): Promise<Response> {
    const sourceHdr = request.headers.get("x-itx-source");
    const className = request.headers.get("x-itx-class");
    if (!sourceHdr || !className)
      return new Response("stateful worker: missing x-itx-source / x-itx-class\n", { status: 400 });
    const modules = await this.#loadModules(JSON.parse(sourceHdr) as Expression);
    const facet = this.#facet(modules, className);
    return facet.fetch(request);
  }
}
