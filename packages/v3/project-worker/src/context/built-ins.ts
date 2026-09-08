// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (the one list
// is context/built-in-roots.ts). Three kinds of key, one record: the AXIOMS (the log, the stub
// registry, the rule table, the two hosts, addressing), the BINDINGS (`kv`, `ai` — a Cloudflare
// binding only this env holds, exposed verbatim) and THE LIBRARY (`connectTo*`, src/library/ — code a
// user could write, taking only `itx`). THE RECORD IS `itx.builtins`, the reserved root: a call
// `itx.builtins.<root>…` runs against it directly and never reads the rule table; a short
// `itx.<root>…` reaches it through the IMPLICIT PLATFORM ROW `itx.<root> ⇒ itx.builtins.<root>` unless
// the context's own table says otherwise (itx-expression-rewriting.ts, rule 5) — so a test may shadow
// `itx.ai`, a context may mask `itx.kv`, and `itx.builtins.…` is always the physical door. The
// platform never spells a short name.
//
// LOADING DYNAMIC CODE — two doors, ONE PER HOST KIND, each a `get` on a noun:
//   • `itx.workers.get({ source, className?, props? }).method(...)` — a STATELESS `WorkerEntrypoint`
//     (its own isolate, no storage). No name: a stateless worker has no identity beyond its spec, so
//     the spec IS the address (naming one is a rewrite rule's job).
//   • `itx.facets.get(name, { source, className }).method(...)` — a `DurableObject` class hosted as
//     the durable FACET `name` of this stream (own storage) — the mirror of `ctx.facets.get(name,
//     startupCallback)`. Without the spec, `itx.facets.get(name)` ADDRESSES a facet that is already
//     running (a processor, a named instance) — same door, no source.
// Both bottom out in Cloudflare's Worker Loader (`env.LOADER.get(cacheKey, …)` then
// `worker.getEntrypoint()` / `worker.getDurableObjectClass()`); the two-step is folded into one door
// per host on purpose. `itx.runScript(lambda)` is sugar for the one bare-lambda case (wrap →
// `workers.get({ source }).run`).

import { RpcTarget } from "capnweb";
import type { ReachableContext, StreamPage, WaitForEventFilter } from "../stream/stream.ts";
import { stampPrincipal, type Principal } from "../principal.ts";
import type { StreamEvent, StreamEventInput } from "../stream/events.ts";
import type { LibraryRoots } from "../library/index.ts";
import {
  loadConfinedWorker,
  type FacetSpec,
  type WorkerCacheKey,
  type WorkerSource,
} from "./worker-loader.ts";
import { resolveContextPath } from "./durable-object-names.ts";
import { print, type ItxExpression, type ItxExpressionInput } from "./expression.ts";
import { FacetHandle, InvokeHandle, RpcStubHandle } from "./invoke-handle.ts";
import type { BuiltInRoot } from "./built-in-roots.ts";
import { projectScopedRepos, type ReposScope } from "./repos.ts";

/** One row of `itx.rewriteRules.list()`: a context row (`target` a string, or `null` for a mask) or an
 *  implicit platform row. */
export type RewriteRuleListEntry = {
  match: string;
  target: string | null;
  origin: "platform" | "context";
};

/** One row of `itx.subscriptions.list()`. */
export type SubscriptionListEntry = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  /** Set when this row HOSTS a facet (a processor): the facet's name, class and cacheKey (the source
   *  lives in the log + the facet's kv memo, never here — M1). Address-only rows have none. */
  hostedFacet?: { name: string; className: string; cacheKey?: string };
  /** Present only when the STREAM keeps the cursor (a target that cannot own its progress). */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
};

/** The one bare-lambda wrapper — `itx.runScript("async (itx, x) => …")`. The lambda STRING becomes
 *  a `WorkerEntrypoint`'s default export, so `runScript` bottoms out at the SAME `workers.get({
 *  source })` path as any exported entrypoint (no separate loader branch). `run()` injects
 *  the itx scope via `env.ITX.get()` — mid-chain handles/callbacks pipeline natively, exactly like a
 *  capnweb client after `projects.get(id)`. */
const RUN_SCRIPT_ENTRYPOINT = (script: string) => /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
const cap = ${script};
export default class RunScript extends WorkerEntrypoint {
  async run(...args) {
    if (typeof cap !== "function") throw new Error("runScript: expected a function");
    return await cap(await this.env.ITX.get(), ...args);
  }
}
`;

/** THE built-in scope, as ONE interface — the physical-layer roots: `itx.builtins.<root>` runs
 *  against them directly; `itx.<root>` reaches them through the implicit platform row unless the
 *  context's table says otherwise (itx-expression-rewriting.ts, rule 5: rules FIRST). The library's
 *  three verbs come in by `extends` (library/index.ts).
 *  This is the clean-room's whole kernel surface. It is a PLAIN OBJECT, not an RpcTarget class, on
 *  purpose: the resolver gates on `Object.hasOwn`, so a prototype-method class would leave every
 *  root unreachable. Exported for ONE reader: the edge `IterateContext`'s TYPE merges it in
 *  (iterate-context.ts), so what rides the dotted hop is typed where a client holds it. */
/** Cloudflare Artifacts ("git for agents", beta) — the per-namespace binding, CONTROL PLANE ONLY, and
 *  typed minimally here (not in `@cloudflare/workers-types` yet; reconcile against `wrangler types`
 *  when the namespace is provisioned). `create` returns the repo's initial git credential; `get`
 *  returns a repo HANDLE (mint a credential with `createToken`); `list` is UNFILTERED. A repo's file
 *  BYTES ride git over the remote — the `itx.repos` layer's job, later, not this raw escape hatch. */
export interface ArtifactsNamespace {
  create(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
  get(name: string): Promise<ArtifactRepoHandle>;
  list(options?: { limit?: number; cursor?: string }): Promise<ArtifactListResult>;
  delete(name: string): Promise<boolean>;
}
/** `create`/`import`'s result: the repo's initial git credential (typed minimally — there may be more). */
export interface ArtifactCreateResult {
  token: string;
}
/** The REAL repo handle `get()` yields (a live RPC stub). `createToken`/`lastPushAt` are scoped to this
 *  one repo and safe; `fork(name, …)` is NOT — its name is unprefixed and would escape the project — so
 *  the scoped handle `itx.cfArtifacts.get` returns (`ScopedArtifactRepo`) re-exposes only `createToken`. */
export interface ArtifactRepoHandle {
  lastPushAt: string | null;
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken>;
  fork(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
}
/** `createToken`'s result — `plaintext` is the git credential string. */
export interface ArtifactToken {
  plaintext: string;
  expiresAt?: string;
}
/** What `itx.cfArtifacts.get` returns: a genuine capnweb `RpcTarget`, so a client can pipeline
 *  `get(name).createToken(...)` ACROSS the /api hop exactly like the real binding's handle — a plain
 *  object cannot (its `createToken` closure is NonPipelinable and fails to serialize; invoke-handle.ts).
 *  It re-exposes ONLY `createToken`, delegated to the already-prefixed repo; the real handle's `fork`
 *  (whose unprefixed name escapes the wall) and everything else are deliberately withheld. */
export class ScopedArtifactRepo extends RpcTarget {
  readonly #handle: ArtifactRepoHandle;
  constructor(handle: ArtifactRepoHandle) {
    super();
    this.#handle = handle;
  }
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken> {
    return this.#handle.createToken(scope, ttlSeconds);
  }
}
/** `list`'s result: repos in the WHOLE namespace (the binding does NOT filter by name), one page. */
export interface ArtifactListResult {
  repos: { name: string }[];
  cursor?: string;
}

/** `itx.cfArtifacts` — the RAW Artifacts binding, project-scoped, and shaped like the real binding.
 *  Every repo name is forced under this project's `${projectId}.` prefix (the isolation wall, like
 *  `itx.kv`'s `${projectId}:`). The delimiter is `.` ON PURPOSE: project IDs are `[A-Za-z0-9_-]` (no
 *  `.`), so `${projectId}.` cannot collide even when IDs contain `-` (a `--` delimiter could: `a` +
 *  `b--x` == `a--b` + `x`), and repo names allow `.`. `create` and `list` return the real shapes
 *  (`list` filtered to this prefix LOCALLY — the binding returns EVERY project's repos). `get` returns
 *  a `ScopedArtifactRepo` RpcTarget exposing only `createToken` (the real handle's `fork` — whose
 *  unprefixed name escapes the wall — is withheld). Pure and namespace-injected: unit-tests alone. */
export function projectScopedArtifacts(
  namespace: ArtifactsNamespace,
  projectId: string,
): BuiltInScope["cfArtifacts"] {
  const prefix = `${projectId}.`;
  return {
    create: (name, options) => namespace.create(prefix + name, options),
    // Wrap the raw handle in an RpcTarget so `get(name).createToken(...)` pipelines across /api; the
    // wrapper exposes only `createToken` (scoped to this already-prefixed repo), never `fork`.
    get: async (name) => new ScopedArtifactRepo(await namespace.get(prefix + name)),
    list: async (options) => {
      const page = await namespace.list(options);
      return {
        repos: page.repos.flatMap((r) =>
          r.name.startsWith(prefix) ? [{ name: r.name.slice(prefix.length) }] : [],
        ),
        ...(page.cursor !== undefined && { cursor: page.cursor }),
      };
    },
    delete: (name) => namespace.delete(prefix + name),
  };
}

export interface BuiltInScope extends LibraryRoots {
  /** THE RESERVED ROOT, typed: `itx.builtins.<root>` is the physical spelling of every root below —
   *  the fixed point of rewriting, never shadowed by a context's rows (itx-expression-rewriting.ts
   *  rule 5). Not a key of the record (the resolver strips it); here so a strongly typed holder — the
   *  SDK host's engine port, a loaded worker's `env.ITX.get()` — can spell `itx.builtins.append(…)`. */
  builtins: Omit<BuiltInScope, "builtins">;
  /** Identify this context. */
  whoami(): { projectId: string; path: string };
  /** Project-prefixed durable key/value (the `${projectId}:` prefix IS the isolation). */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  /** THE FIRST BINDINGS ROOT: Cloudflare's Workers AI binding, VERBATIM — `run(model, inputs,
   *  options?)`, `models()`, `gateway(id).run({ provider, endpoint, headers, query })`, `toMarkdown()`,
   *  `autorag(id)` — no wrapper, so `itx.ai` reads exactly like `env.AI` and a rewrite rule can pin a
   *  model with `@` (`itx.fable ⇒ itx.ai.run('@cf/…', @)`). A test shadows it with `provide("itx.ai",
   *  fake)`; the physical door stays `itx.builtins.ai`. */
  ai: Ai;
  /** THE ESCAPE HATCH: Cloudflare Artifacts, project-scoped. `itx.cfArtifacts` proxies the ONE bound
   *  namespace, forcing every repo name under this project's `${projectId}.` prefix (the isolation
   *  wall, exactly like `itx.kv`). The nicer `itx.repos` API is built ON TOP of this; anyone who wants
   *  raw Artifacts falls back here — same shape as `itx.ai` proxying `env.AI`, and its methods return
   *  the SAME SHAPES as the real binding: `create` a repo (→ its initial git token), `get` a repo's
   *  handle (mint a git credential with `createToken`; NO `fork` — its name escapes the wall), `list`
   *  this project's repos, or `delete` one (project teardown deletes a project's repos). A repo's
   *  bytes are git-over-HTTPS (the `itx.repos` layer's job). */
  cfArtifacts: {
    create(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
    get(name: string): Promise<ScopedArtifactRepo>;
    list(options?: { limit?: number; cursor?: string }): Promise<ArtifactListResult>;
    delete(name: string): Promise<boolean>;
  };
  /** THE PRIMARY REPO DOOR — `itx.repos` (repos.ts): a repo's file BYTES, git-over-HTTPS, built ON TOP
   *  of `cfArtifacts` + `context/git-wire`. `cfArtifacts` is the raw control-plane escape hatch
   *  beneath it. Minimal today: `readFile`/`writeFile` one root-level path on `main` — enough to move
   *  the config worker's source out of KV (`itx.provide("itx.worker", "…itx.repos.readFile(…)")`). */
  repos: ReposScope;
  /** Append to this context's append-only event log (the facets that REDUCE it are
   *  `itx.facets.get(name)`). A top-level root, so the expression surface mirrors the edge
   *  RpcTarget exactly: `itx.append({...})` is one spelling on every hop. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** Read a page of the durable log — `itx.readEvents(afterOffset?, limit?)`, the twin of `append`
   *  (non-minting: a probe never wakes storage). */
  readEvents(afterOffset?: number, limit?: number): Promise<StreamPage>;
  /** Wait for the next event matching `filter` (Stream.waitForEvent owns the contract: type filter,
   *  afterOffset default = the head, 30s/120s timeout → WAIT_TIMEOUT). A root, so the edge declares
   *  nothing for it. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
  /** Navigate to another context of THIS project, routed through its own table. Absolute by
   *  convention ("/agents/x"); relative ("agents/x", "../inbox") resolves against this context's
   *  path — the same resolver the edge `cd` uses (resolveContextPath). */
  cd(path: string): InvokeHandle;
  /** Egress: `{{secret:project:NAME}}` (then platform) placeholders substituted, then the terminal
   *  `fetch` — the same door a loaded worker's `globalOutbound` and the edge `itx.fetch(request)`
   *  land on. */
  fetch(request: Request): Promise<Response>;
  /** The rpc-stub REGISTRY — physical, never event-sourced: a client's live capnweb value lent under
   *  an OPAQUE key by its session (relay-side, DON'T-PIN — the edge owns it, this side borrows).
   *  `get(rpcStubKey)` is how a REWRITE RULE names one: `itx.provide(match, stub)` lends the stub
   *  under the key = the canonical match and configures the pure-data rule `match ⇒
   *  itx.builtins.rpcStubs.get('<match>')`. */
  rpcStubs: {
    /** One stub by key: a pipelinable handle over its transport (borrowed, or paged then borrowed).
     *  Deep dots walk; a root call reaches the bare lent callable; offline ⇒ RPC_STUB_OFFLINE at call
     *  time. Branded `RpcStubHandle`: the subscription delivery loop reads the brand to know the
     *  callee owns its own progress. */
    get(rpcStubKey: string): RpcStubHandle;
    /** PRESENCE — the keys borrowed or pager-backed right now. */
    list(): string[];
  };
  /** The itx-expression rewrite-rule table, read — THE EFFECTIVE table: the context's own rows (a
   *  slice of core; `origin: "context"`, a mask shown as `target: null`) plus the implicit platform
   *  rows `itx.<root> ⇒ itx.builtins.<root>` (`origin: "platform"`) for every root the context has
   *  not re-set. Written by `itx.provide(match, target | null)` on the edge (sugar over the ONE
   *  `itx/rewrite-rule-configured` event), never a verb here. `resolve(call)` is the PURE half of
   *  `invoke`: the chain of rewrites, each printed, from the call to the builtins-rooted call that
   *  would run — nothing is dispatched; the law is `invoke(call) ≡ invoke(resolve(call).at(-1))`. */
  rewriteRules: {
    list(): RewriteRuleListEntry[];
    get(match: string): RewriteRuleListEntry | null;
    resolve(call: ItxExpressionInput): string[];
  };
  /** The facets of this context. `get(name)` ADDRESSES one that is already running (a processor, a
   *  named instance) — no source; `get(name, { source, cacheKey?, className })` LOADS the class and
   *  hosts it as the durable facet `name` (own storage) — the mirror of Cloudflare's
   *  `ctx.facets.get(name, startupCallback)`; `source`/`cacheKey` as for `workers.get` (a new key
   *  restarts the facet, its storage surviving). A facet leaves with the subscription that hosted it
   *  (`subscription-configured { name, target: null }`) — there is no delete verb. */
  facets: { get(name: string, spec?: FacetSpec): FacetHandle };
  /** The subscriptions layer, read: the table (a slice of core) joined with the stream-kept
   *  cursors. Read-only — `subscribe` lives on the edge as sugar over the `subscription-configured`
   *  event, never a verb here. */
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };
  /** The stateless host: `get({ source, cacheKey?, className?, props? })` → a `WorkerEntrypoint` in
   *  its own confined isolate (no DO, no storage) — ANY method it exports, reached by name (`run`,
   *  `fetch`, `processEventBatch`, …). `source` is the worker's MODULES, literally (`{ "cap.js": code,
   *  … }`), OR an itx EXPRESSION that produces them — then `cacheKey` is REQUIRED and the producer runs
   *  only when no isolate is warm under it (worker-loader.ts: Cloudflare's `get(id, getCode)`
   *  contract; the caller owns "same key ⇒ same code"). `className` names the exported class (default:
   *  the default export); `props` is Cloudflare's own WorkerStubEntrypointOptions.props, read back as
   *  `this.ctx.props` (a url, a key name, …). No name and no `list`: a stateless worker is its spec. */
  workers: {
    get(spec: {
      source: WorkerSource;
      cacheKey?: WorkerCacheKey;
      className?: string;
      props?: unknown;
    }): InvokeHandle;
  };
  /** Run a stateless lambda STRING — sugar: wrap into a `WorkerEntrypoint`, then
   *  `workers.get({ source }).run(...)`. The one bare-lambda ergonomic (same as apps/os). */
  runScript(script: string, ...args: unknown[]): Promise<unknown>;
  // ── THE LIBRARY (src/library/) — `connectToMcp`, `connectToOpenApi`, `connectToCapnweb` — is
  // the `extends LibraryRoots` above: first-party code that takes ONLY `itx`. ──
}

// THE ONE LIST: `keyof BuiltInScope` (minus the reserved root itself, which names the record, not a
// key of it) and context/built-in-roots.ts's `BUILT_IN_ROOTS` are the same set — a root added to
// either without the other fails to typecheck right here.
type RootsAreTheSameSet = [Exclude<keyof BuiltInScope, "builtins">] extends [BuiltInRoot]
  ? [BuiltInRoot] extends [Exclude<keyof BuiltInScope, "builtins">]
    ? true
    : never
  : never;
const _rootsAreTheSameSet: RootsAreTheSameSet = true;
void _rootsAreTheSameSet;

/** What the CONTEXT (the DO) injects: identity, the bindings, and the seams only it can serve. */
interface BuildBuiltInsDeps {
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys). */
  iterateContextName: string;
  /** The bindings the built-ins reach: the loader, the project kv and the Workers AI binding (all
   *  bound in both wrangler configs). */
  env: {
    LOADER: WorkerLoader;
    ITX_KV: KVNamespace;
    AI: Ai;
    /** Cloudflare Artifacts, the ONE bound namespace — `itx.cfArtifacts` scopes it per project. */
    ARTIFACTS: ArtifactsNamespace;
    /** The Artifacts account + namespace `itx.repos` builds git remotes from (git-over-HTTPS). */
    ARTIFACTS_ACCOUNT_ID: string;
    ARTIFACTS_NAMESPACE: string;
  };
  /** The deploy identity every loader cacheKey folds in (app-config.ts). */
  deployId: string;
  /** Evaluate a producer source expression through THIS context's dispatch (inside the loader's
   *  `getCode`, so only on a cold isolate). */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** A context stream by CANONICAL path — the own-path parent adapter same-isolate, by-name DO
   *  stubs otherwise. Both satisfy ReachableContext (uniform-async, real-typed — see stream/stream.ts). */
  context: (path: string) => ReachableContext;
  /** The context's egress terminal (secret substitution → `fetch`). */
  egress: (request: Request) => Promise<Response>;
  /** WHO is calling right now — the principal the DO runs this call under (`invokeAs`, the fetch
   *  lane's header), null for an anonymous session, a processor, a loaded worker. */
  principal: () => Principal | null;
  /** The rpcStubs view — PARENT-LOCAL closures over the context's transport table (the pager
   *  sockets live in the DO and can never move). */
  rpcStubs: BuiltInScope["rpcStubs"];
  /** The subscriptions view — the core slice ⋈ the delivery loop's cursors. */
  subscriptions: BuiltInScope["subscriptions"];
  /** The rewrite-rule view — the core slice, printed. */
  rewriteRules: BuiltInScope["rewriteRules"];
  /** The stream's waitForEvent (the own context's — a wait never crosses a hop). */
  waitForEvent: BuiltInScope["waitForEvent"];
  /** `facets.get(name, spec?)` — the public door, verbatim: address a running facet by name, or host
   *  `spec` as the facet `name` (accepted trade: a busy stateful facet pins its stream). */
  facets: BuiltInScope["facets"];
  /** The `ItxEntrypoint` stub a loaded worker gets as `env.ITX` and `globalOutbound` — the loopback
   *  minted once for this context (the DO's `#itxEntrypoint`; itx-entrypoint.ts for why it is never a
   *  raw getByName stub). */
  itxEntrypoint: Fetcher;
  /** THE LIBRARY's roots (library/index.ts `buildLibrary(itx).roots`): built by the DO over its own
   *  `itx` handle, so a library call's `itx.fetch(...)` resolves through THIS context's rules (a test
   *  may shadow `itx.fetch`) and lands on egress with zero hops. */
  library: LibraryRoots;
}

/** Assemble the built-in scope for one context. Every entry closes over the context's identity —
 *  PRE-SCOPED, not policed: cross-project access is unspellable by construction. */
export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const { projectId, path, iterateContextName, env } = deps;

  /** THE stateless host — `itx.workers.get(spec)`: a fresh confined isolate (no DO, no storage,
   *  `env.ITX` bound) over the loaded WorkerEntrypoint, and ONE method on it by name — `run`,
   *  `fetch`, `processEventBatch`, whatever the class declares. A terminal `fetch(request)` is this
   *  same call: `entrypoint.fetch(request)` IS the entrypoint's fetch channel, socket-bearing
   *  Responses included (fetch/rpc-stub-fetch.ts doctrine, points 1 & 4). The source EXPORTS the
   *  entrypoint (no host-injected wrapper — Cloudflare's `worker.getEntrypoint()` underneath).
   *  Re-resolves per call, but the loader caches by the key (cacheKey | content hash) so a warm
   *  isolate is reused and a producer expression never re-runs. */
  const callEntrypoint = async (
    spec: { source: WorkerSource; cacheKey?: WorkerCacheKey; className?: string; props?: unknown },
    method: string,
    args: unknown[],
  ) => {
    const { worker } = await loadConfinedWorker({
      env,
      deployId: deps.deployId,
      itxEntrypoint: deps.itxEntrypoint,
      kind: "worker",
      owner: iterateContextName,
      source: spec.source,
      cacheKey: spec.cacheKey,
      invoke: deps.invoke,
      where: "workers.get",
    });
    const entrypoint = worker.getEntrypoint(
      spec.className,
      spec.props === undefined ? undefined : { props: spec.props },
    ) as Fetcher & Record<string, (...a: unknown[]) => Promise<unknown>>;
    const fn = entrypoint[method];
    if (typeof fn !== "function")
      throw new Error(`workers.get(spec): the entrypoint has no method "${method}"`);
    return Reflect.apply(fn, entrypoint, args);
  };

  const kvPrefix = `${projectId}:`;
  const ownContext = () => deps.context(path);

  // Each root implements one member of the BuiltInScope interface above (the canonical doc of the
  // kernel surface); the comments here add only what the interface can't say — the WHY of a code branch.
  return {
    whoami: () => ({ projectId, path }),
    kv: {
      get: (k: string) => env.ITX_KV.get(kvPrefix + k),
      put: async (k: string, v: string) => {
        await env.ITX_KV.put(kvPrefix + k, String(v));
        return { ok: true };
      },
      delete: async (k: string) => {
        await env.ITX_KV.delete(kvPrefix + k);
        return { ok: true };
      },
      list: async (prefix = "") => {
        // Paginate on the cursor: Cloudflare KV caps ONE list page at 1000 keys, so a single
        // `list()` would present page 1 as the whole truth (sweep/GC would orphan key 1001+). Drain.
        const out: string[] = [];
        for (let cursor: string | undefined; ; ) {
          const page = await env.ITX_KV.list({
            prefix: kvPrefix + prefix,
            ...(cursor && { cursor }),
          });
          for (const k of page.keys) out.push(k.name.slice(kvPrefix.length));
          if (page.list_complete) return { keys: out };
          cursor = page.cursor;
        }
      },
    },
    // The binding object itself — dispatch walks its methods (`run`, `models`, `gateway`, …).
    ai: env.AI,
    // THE ESCAPE HATCH: Cloudflare Artifacts, project-scoped (projectScopedArtifacts, below).
    cfArtifacts: projectScopedArtifacts(env.ARTIFACTS, projectId),
    repos: projectScopedRepos({
      namespace: env.ARTIFACTS,
      projectId,
      accountId: env.ARTIFACTS_ACCOUNT_ID,
      namespaceName: env.ARTIFACTS_NAMESPACE,
    }),
    // Own-enumerable closures (NOT prototype methods) — the resolver's `Object.hasOwn` gate is why.
    // Every event appended through the scope carries WHO appended it — the DO's own stamp, never a
    // client's (src/principal.ts): the session's verified principal, or none.
    append: (...e: StreamEventInput[]) =>
      ownContext().append(...e.map((event) => stampPrincipal(event, deps.principal()))),
    readEvents: (afterOffset?: number, limit?: number) => ownContext().read(afterOffset, limit),
    waitForEvent: deps.waitForEvent,
    // `cd` routes EVERY call through the target context's own table — a sibling's rows apply, its
    // whole-context override included; the physical spelling is `cd(p).builtins.append(…)`, which is
    // the fixed point there and reads no table. Codec-named, so only THIS project is reachable; the
    // path resolves against THIS context (absolute, or relative with `.`/`..`).
    cd: (contextPath: string) =>
      new InvokeHandle((itxExpressionSteps) =>
        deps
          .context(resolveContextPath(path, contextPath)) // a ReachableContext — real-typed seam
          .invoke(["itx", ...itxExpressionSteps]),
      ),
    fetch: (request: Request) => deps.egress(request),
    rpcStubs: deps.rpcStubs,
    facets: deps.facets,
    subscriptions: deps.subscriptions,
    rewriteRules: deps.rewriteRules,
    // A genuine InvokeHandle, so `workers.get(spec).run()` pipelines on every lane (workerd#6873).
    workers: {
      get: (spec: {
        source: WorkerSource;
        cacheKey?: WorkerCacheKey;
        className?: string;
        props?: unknown;
      }) =>
        new InvokeHandle((methodSteps) => {
          const [call] = methodSteps;
          if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] === "")
            throw new Error(
              `workers.get(spec).${print(methodSteps)}: a WorkerEntrypoint exposes flat methods`,
            );
          return callEntrypoint(spec, call[0], call.slice(1));
        }),
    },
    // `RUN_SCRIPT_ENTRYPOINT` wraps the lambda string into a WorkerEntrypoint default export, so even
    // this bare-lambda door bottoms out at `workers.get({ source }).run(...)`.
    runScript: (script: string, ...args: unknown[]) =>
      callEntrypoint({ source: { "cap.js": RUN_SCRIPT_ENTRYPOINT(script) } }, "run", args),
    // THE LIBRARY: three verbs closed over the context's own `itx` handle, built and owned by the DO
    // (library/index.ts — it also owns the live connections' release at the idle quiesce).
    ...deps.library,
  } satisfies Omit<BuiltInScope, "builtins">;
}
