// The StatefulWorkerDurableObject — a dedicated "durable object runner" for stateful dynamic workers (mirrors
// apps/os's StatefulWorkerDurableObject + DynamicWorkerRunner). ONE instance per stateful capability, named
// `{projectId}::{path}::{callPath}`, each hosting the user's `DurableObject` class DIRECTLY as a single facet
// "target" with its OWN isolated SQLite. The capability host reaches it by NAME (a namespace binding).
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
// The `fetch` lane (WS/streaming, where a 101 can't ride RPC) forwards to the facet's own `fetch`.

import { DurableObject } from "cloudflare:workers";

const FACET_NAME = "target";
const VERSION_KEY = "stateful:version";

interface Env {
  LOADER: WorkerLoader;
  ITX_KV?: KVNamespace; // the repo store (project-prefixed) this runner reads its source from
  // Deploy identity (wrangler `version_metadata`). Folded into the loader cacheKey so a redeploy
  // mints a FRESH loaded isolate — a facet built from a prior deployment's isolate cannot be
  // called from the new parent. Mirrors apps/os workerVersion(env). Absent locally → "unversioned".
  CF_VERSION_METADATA?: { id: string; tag?: string };
}

/** djb2 — a stable content hash so the loader cache key + facet version change when the source changes. */
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The RPC-lane payload the capability host forwards (mirrors apps/os's StatefulWorkerDurableObject input). */
export interface StatefulInvoke {
  module: string;
  className: string;
  method: string;
  args: unknown[];
}

export class StatefulWorkerDurableObject extends DurableObject<Env> {
  /** projectId is the first segment of this runner's name `{projectId}::{path}::{callPath}`. */
  get #projectId(): string {
    return (this.ctx.id.name ?? "").split("::")[0];
  }

  /** Read the capability's source from the project's repo (the same `${projectId}:repo:` view the host writes). */
  async #source(module: string): Promise<string> {
    if (!this.env.ITX_KV) throw new Error("stateful worker: no ITX_KV bound");
    const source = await this.env.ITX_KV.get(`${this.#projectId}:repo:${module}`);
    if (source == null) throw new Error(`stateful worker: no repo file "${module}"`);
    return source;
  }

  /** Construct (or restart on a source change) the facet hosting the user's `className`, keeping its storage
   *  across restarts. The user source is loaded DIRECTLY (no host wrapper) — the class it exports IS the facet. */
  #facet(source: string, className: string): Fetcher {
    const version = hashSource(source);
    // ⚠️  LEARNING: the deploy version MUST be in the loader cacheKey. Worker-Loader isolates are cached
    // ACROSS deployments, but this DO is durable and survives redeploys — so without a per-deploy key
    // component a rollout leaves the runner reusing a PRIOR deployment's isolate, whose facet is
    // cross-Worker to the new parent and thus un-transferable (same DataCloneError family). Mirrors
    // apps/os's cacheKey (WORKER_SELF + workerVersion(env)). CF_VERSION_METADATA.id changes every deploy.
    const deployVersion = this.env.CF_VERSION_METADATA?.id ?? "unversioned";
    const worker = this.env.LOADER.get(
      `stateful:${deployVersion}:${this.ctx.id.name}:${version}`,
      () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "cap.js",
        modules: { "cap.js": source },
        env: {},
      }),
    );
    const klass = worker.getDurableObjectClass(className);
    if (!klass) throw new Error(`stateful worker does not export class "${className}"`);
    // Abort + recreate the facet on a source change (same storage) — apps/os's version-marker pattern.
    const prev = this.ctx.storage.kv.get<string>(VERSION_KEY);
    if (prev !== undefined && prev !== version) this.ctx.facets.abort(FACET_NAME, "source changed");
    if (prev !== version) this.ctx.storage.kv.put(VERSION_KEY, version);
    return this.ctx.facets.get(FACET_NAME, () => ({ class: klass })) as unknown as Fetcher;
  }

  /** RPC lane: resolve/restart the facet and call the method NATIVELY on it (apps/os `replayPath`). The awaited
   *  result is plain data, so the facet stub never crosses back to the host. */
  async invokeCapability(input: StatefulInvoke): Promise<unknown> {
    const facet = this.#facet(await this.#source(input.module), input.className);
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
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════
    const handler = Reflect.get(facet as object, input.method);
    if (typeof handler !== "function")
      throw new Error(`stateful worker: "${input.className}" has no method "${input.method}"`);
    return await Reflect.apply(handler, facet, input.args ?? []);
  }

  /** WS/streaming lane: forward the request to the facet's own `fetch`. The module + class ride in headers set
   *  by the host (small — names, not source). A 101 upgrade tunnels straight through DO→DO→facet. */
  async fetch(request: Request): Promise<Response> {
    const module = request.headers.get("x-itx-module");
    const className = request.headers.get("x-itx-class");
    if (!module || !className)
      return new Response("stateful worker: missing x-itx-module / x-itx-class\n", { status: 400 });
    const facet = this.#facet(await this.#source(module), className);
    return facet.fetch(request);
  }
}
