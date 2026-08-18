// core/roots.ts — `roots`: the ONE primordial scope symbol, the physical layer as THIS project is
// allowed to see it. Everything else in the system is an expression over the routing table; this
// object is where expressions bottom out. Two rules make it safe:
//   1. PRE-SCOPED, not policed: every getter closes over the context's identity — kv keys are
//      prefixed, sibling contexts are named through the codec, the loader's cache keys embed the
//      context — so a cross-project reference is UNSPELLABLE, there is no method that takes one.
//   2. Provenance-gated: `roots` is only in scope while resolving a CONFIG seed's target (see
//      iterate-context-stream-processor.ts). Event-provided mounts never see it.
//
// It is an RpcTarget so the same object works across a Workers-RPC hop (workerd exposes getters
// and methods on RpcTargets; plain instance fields stay invisible) — a facet or loaded worker
// handed `roots` evaluates against it exactly like in-DO code does.

import { RpcTarget } from "cloudflare:workers";

/** What the hosting DO injects — the raw bindings plus the two views only it can build. */
export type RootsDeps = {
  projectId: string;
  path: string;
  itxKv?: KVNamespace;
  secretsKv?: KVNamespace;
  /** A named service binding (the forker door + `itx.os`). Throws on an unknown name. */
  binding: (name: string) => unknown;
  /** A sibling context (a stream IS a context) by path — the codec-named DO stub. */
  context: (path: string) => {
    append(...e: unknown[]): unknown;
    read(after?: number, limit?: number): unknown;
  };
  /** The parked-stub registry view (clients + live capabilities — one registry). */
  clients: ClientsView;
  /** The facet address (a facet hosts a durable object; processor is just a role it may play). */
  facets: FacetsView;
  /** Run dynamic workers (stateless entrypoints + stateful runner facets). */
  workers: WorkersView;
  /** The v1 file reader (a hello-module map; later a real repo read at a ref). */
  readFile: (path: string) => Record<string, string>;
};

export type ClientsView = {
  /** Single-target: a method proxy over one parked stub (wake → leg → invoke). Deep dots walk. */
  get(key: string): unknown;
  /** Fan-out over every connection at a client path (allSettled; dead connections drop out). */
  at(path: string): { call(method: string[], args: unknown[]): Promise<unknown[]> };
  /** Promise-valued when the view is RPC-backed (the facet host) — evaluation awaits every step. */
  list(): unknown[] | Promise<unknown[]>;
  connections(path: string): unknown[] | Promise<unknown[]>;
  close(key: string): { ok: true } | Promise<{ ok: true }>;
};

export type WorkersView = {
  get(ref: { type: "stateless" | "stateful"; source: unknown; className?: string }): unknown;
};

/** `roots.facets.get(slug)` → a dotted method proxy over ONE enabled facet — ANY method its
 *  durable object exposes, not just the processor role (facet stubs are non-transferable, so
 *  the walk happens parent-side and this view is thin RPC wrappers, like the clients view). */
export type FacetsView = {
  get(slug: string): unknown;
};

export class Roots extends RpcTarget {
  #deps: RootsDeps;
  constructor(deps: RootsDeps) {
    super();
    this.#deps = deps;
  }

  whoami(): { projectId: string; path: string } {
    return { projectId: this.#deps.projectId, path: this.#deps.path };
  }

  /** Project-prefixed KV — the raw namespace is shared; the prefix is the isolation. */
  get kv() {
    const kv = this.#deps.itxKv;
    if (!kv) throw new Error("roots.kv: no ITX_KV bound");
    const prefix = `${this.#deps.projectId}:`;
    return {
      get: (k: string) => kv.get(prefix + k),
      put: async (k: string, v: string) => (await kv.put(prefix + k, String(v)), { ok: true }),
      delete: async (k: string) => (await kv.delete(prefix + k), { ok: true }),
      list: async (start = "") => ({
        keys: (await kv.list({ prefix: prefix + start })).keys.map((x) =>
          x.name.slice(prefix.length),
        ),
      }),
    };
  }

  /** The project's file store (`repo:`-prefixed kv view) — where the config worker lives. */
  get repo() {
    const kv = this.#deps.itxKv;
    if (!kv) throw new Error("roots.repo: no ITX_KV bound");
    const prefix = `${this.#deps.projectId}:repo:`;
    return {
      get: (k: string) => kv.get(prefix + k),
      put: async (k: string, v: string) => (await kv.put(prefix + k, String(v)), { ok: true }),
      list: async () => ({
        files: (await kv.list({ prefix })).keys.map((x) => x.name.slice(prefix.length)),
      }),
    };
  }

  /** Write-only secret store. Values come back out ONLY as `{{secret:NAME}}` substitution at the
   *  egress terminal — never through a read here. */
  get secrets() {
    const kv = this.#deps.secretsKv;
    if (!kv) throw new Error("roots.secrets: no SECRETS_KV bound");
    return {
      set: async (name: string, value: string) => (
        await kv.put(`secret:${this.#deps.projectId}:${name}`, String(value)), { ok: true }
      ),
    };
  }

  /** Sibling context streams, codec-named — `roots.streams.get('/x')` can only reach THIS project. */
  get streams() {
    return { get: (path: string) => this.#deps.context(path) };
  }

  get clients(): ClientsView {
    return this.#deps.clients;
  }

  get facets(): FacetsView {
    return this.#deps.facets;
  }

  get workers(): WorkersView {
    return this.#deps.workers;
  }

  get files() {
    return { read: (path: string) => this.#deps.readFile(path) };
  }

  /** The forker door: any wrangler service binding, referenced by name from a config seed. */
  binding(name: string): unknown {
    return this.#deps.binding(name);
  }
}
