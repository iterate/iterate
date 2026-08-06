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
//
// Every hosted DO class gets `env.ITX` = a stub to its OWNING capability host (the ItxDurableObject for this
// runner's {projectId, path}), plus `globalOutbound` = that same host — IDENTICAL to what a stateless `code`
// cap gets. So a stateful worker calls sibling capabilities with `this.env.ITX.invokeCapability("itx.x", [..])`
// (or imports `itxFromStub` from the injected `itx.js` for the dotted `itx.x.y(..)` surface), and a plain
// `fetch()` inside the class routes out through the host's egress. Mirrors apps/os, whose loaded stateful
// worker gets `env.ITX = ctx.exports.ItxEntrypoint({props})` — same "reach your own host" binding.
//
// The `fetch` lane (WS/streaming, where a 101 can't ride RPC) forwards to the facet's own `fetch`.

import { DurableObject } from "cloudflare:workers";
import { ITX_SURFACE_MODULE } from "./core/agent-runtime.ts";
import { evaluateItxExpression, itxRoot, type ItxExpression } from "./core/itx-expression.ts";
import { stringifyName } from "./core/names.ts";
import type { ItxDurableObject } from "./itx-durable-object.ts";

const FACET_NAME = "target";
const VERSION_KEY = "stateful:version";

interface Env {
  LOADER: WorkerLoader;
  // The capability host namespace (same worker). A stub to the owning context is minted into each facet's
  // env.ITX + globalOutbound AND is where this runner resolves its source expression (itx.files.read) — the
  // runner reads NO KV directly; source comes through the host like everything else.
  ITX_HOST: DurableObjectNamespace<ItxDurableObject>;
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
  source: ItxExpression; // a source EXPRESSION resolved (via the host) to the facet's modules — not a file path
  className: string;
  method: string;
  args: unknown[];
}

export class StatefulWorkerDurableObject extends DurableObject<Env> {
  /** Evaluate a source EXPRESSION against the OWNING host's itx into a `{ name: source }` modules map — the
   *  same repo-agnostic resolution the host uses for stateless workers (v1 → `itx.files.read`). */
  async #loadModules(source: ItxExpression): Promise<Record<string, string>> {
    const host = this.#hostStub();
    const root = itxRoot((p, a) => host.invokeCapability(p, a));
    return (await evaluateItxExpression(root, source)) as Record<string, string>;
  }

  /** A stub to the OWNING capability host — the `env.ITX` every hosted DO class gets (like a stateless code
   *  cap). Reconstructed from this runner's name `{projectId}::{path}::{callPath}`, which the host sets in
   *  ItxDurableObject#statefulRunner; the first two `::`-segments are the context {projectId, path}. */
  #hostStub(): DurableObjectStub<ItxDurableObject> {
    const [projectId, path] = (this.ctx.id.name ?? "").split("::");
    return this.env.ITX_HOST.getByName(
      stringifyName({ projectId: projectId ?? "", path: path ?? "/" }),
    );
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
    // env.ITX (+ globalOutbound) = a stub to the OWNING capability host, so the hosted DO class calls sibling
    // capabilities and egresses exactly like a stateless code cap; `itx.js` lets it import the dotted surface.
    const host = this.#hostStub();
    const worker = this.env.LOADER.get(
      `stateful:${deployVersion}:${this.ctx.id.name}:${version}`,
      () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "cap.js",
        modules: { "itx.js": ITX_SURFACE_MODULE, ...modules },
        env: { ITX: host },
        globalOutbound: host,
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
    // ═══════════════════════════════════════════════════════════════════════════════════════════════════
    const handler = Reflect.get(facet as object, input.method);
    if (typeof handler !== "function")
      throw new Error(`stateful worker: "${input.className}" has no method "${input.method}"`);
    return await Reflect.apply(handler, facet, input.args ?? []);
  }

  /** WS/streaming lane: forward the request to the facet's own `fetch`. The module + class ride in headers set
   *  by the host (small — names, not source). A 101 upgrade tunnels straight through DO→DO→facet. */
  async fetch(request: Request): Promise<Response> {
    const sourceHdr = request.headers.get("x-itx-source");
    const className = request.headers.get("x-itx-class");
    if (!sourceHdr || !className)
      return new Response("stateful worker: missing x-itx-source / x-itx-class\n", { status: 400 });
    const modules = await this.#loadModules(JSON.parse(sourceHdr) as ItxExpression);
    const facet = this.#facet(modules, className);
    return facet.fetch(request);
  }
}
