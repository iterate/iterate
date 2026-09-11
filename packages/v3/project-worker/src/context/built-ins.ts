// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (the one list
// is context/itx-expression-rewriting.ts). Three kinds of key, one record: the AXIOMS (the log, the stub
// registry, the rule table, the two hosts, addressing), the BINDINGS (`kv`, `secrets`, `ai`,
// `cfArtifacts`, `repos` — a Cloudflare binding only this env holds, exposed or scoped) and THE
// LIBRARY (`connectTo*`, library.ts — code a user could write, taking only `itx`).
// THE RECORD IS `itx.builtins`, the reserved root: `itx.builtins.<root>…` runs against it directly
// and never reads the rule table; a short `itx.<root>…` reaches it through the IMPLICIT PLATFORM ROW
// unless the context's own table says otherwise (itx-expression-rewriting.ts, rule 5) — so a test may
// shadow `itx.ai`, a context may mask `itx.kv`, and `itx.builtins.…` is always the physical door.
// Dynamic code has two doors, one per host kind: `workers.get(spec)` (stateless) and
// `facets.get(name, spec)` (durable) — the `BuiltInScope` members below say what each takes.

import type { ReachableContext, StreamPage, WaitForEventFilter } from "../stream/stream.ts";
import { stampPrincipal, type Principal } from "../principal.ts";
import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";
import type { LibraryRoots } from "../library.ts";
import { subscriptionConfiguredEvent } from "../stream/core-processor.ts";
import { resolveContextPath } from "../iterate-context.ts";
import {
  assertFacetSourceWithinCeiling,
  facetSpecOf,
  loadConfinedWorker,
  type FacetSpec,
  type WorkerCacheKey,
  type WorkerSource,
} from "./worker-loader.ts";
import {
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionStep,
  FacetHandle,
  InvokeHandle,
  RpcStubHandle,
} from "./expression.ts";
import type { BuiltInRoot } from "./itx-expression-rewriting.ts";
import {
  projectScopedArtifacts,
  projectScopedRepos,
  type ArtifactsNamespace,
  type ArtifactsScope,
  type ReposScope,
} from "./repos.ts";

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
  /** Where the cursor lane started (0 = the whole log); absent = at the configure. */
  afterOffset?: number;
  /** Set when this row HOSTS a facet (a processor): the facet's name, class and cacheKey (the source
   *  lives in the log + the facet's kv memo, never here — M1). Address-only rows have none. */
  hostedFacet?: { name: string; className: string; cacheKey?: string };
  /** Present only when the STREAM keeps the cursor (a target that cannot own its progress). */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
};

/** THE built-in scope, as ONE interface — the clean-room's whole kernel surface; the library's verbs
 *  come in by `extends` (library.ts). The record is a PLAIN OBJECT of own-enumerable closures,
 *  not an RpcTarget class, on purpose: the resolver gates on `Object.hasOwn`, so a prototype-method
 *  class would leave every root unreachable. Exported for ONE reader: the edge `IterateContextRpcTarget`'s TYPE
 *  merges it in (iterate-context.ts), so what rides the dotted hop is typed where a client holds it. */
export interface BuiltInScope extends LibraryRoots {
  /** THE RESERVED ROOT, typed: the physical spelling of every root below. Not a key of the record
   *  (the resolver strips it); here so a strongly typed holder (a loaded worker's `env.ITX.get()`)
   *  can spell `itx.builtins.append(…)`. */
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
  /** Project secrets for egress: `getSecret("/secrets/NAME")` in an outbound request's URL (path
   *  or query) or headers substitutes to the value at the fetch door (`fetch`), and
   *  `getSecret("/secrets/NAME", { field: "a.b" })` to one dotted field of a JSON value — apps/os's
   *  placeholder grammar for a URL or a header (iterate-context-durable-object.ts
   *  `substituteProjectSecrets`); not its `Basic base64(user:getSecret(…))` peeling nor its
   *  JSON-body template — the body is never scanned. WRITE-ONLY — `set`, `delete`,
   *  and a `list` of names and origins, never a value (the same physical-write carve-out as
   *  `kv.put`). A secret `set` with an `origin` is sent to that origin ONLY: a mis-typed URL cannot
   *  mail a credential to a stranger. Every change appends `events.iterate.com/secrets/changed` with
   *  the name (and origin, or `deleted`) — the value never enters the log — attributed like any
   *  append (`source.principal`). A name is what the placeholder can spell, `[a-zA-Z0-9._-]+`; the
   *  project's own API key lives outside this catalog (principal.ts) and no placeholder reaches it. */
  secrets: {
    set(name: string, value: string, options?: { origin?: string }): Promise<{ ok: true }>;
    delete(name: string): Promise<{ ok: true }>;
    list(): Promise<{ name: string; origin?: string }[]>;
  };
  /** THE FIRST BINDINGS ROOT: Cloudflare's Workers AI binding, VERBATIM — `run(model, inputs,
   *  options?)`, `models()`, `gateway(id).run({ provider, endpoint, headers, query })`, `toMarkdown()`,
   *  `autorag(id)` — no wrapper, so `itx.ai` reads exactly like `env.AI` and a rewrite rule can pin a
   *  model with `@` (`itx.fable ⇒ itx.ai.run('@cf/…', @)`). A test shadows it with `provide("itx.ai",
   *  fake)`; the physical door stays `itx.builtins.ai`. */
  ai: Ai;
  /** THE ESCAPE HATCH: the raw Cloudflare Artifacts binding, project-scoped (repos.ts
   *  `ArtifactsScope`); `itx.repos` is built on top of it. */
  cfArtifacts: ArtifactsScope;
  /** THE PRIMARY REPO DOOR (repos.ts `ReposScope`): a repo's file BYTES over git-over-HTTPS —
   *  `readFile`/`writeFile` one root-level path on `main`, enough to hold the config worker's source
   *  (`itx.provide("itx.worker", "…itx.repos.readFile(…)")`). */
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
  /** Another context of THIS project, every call routed through ITS table (`resolveContextPath`
   *  resolves the path, as the edge `cd` does). */
  cd(path: string): InvokeHandle;
  /** Egress: `getSecret("/secrets/NAME")` placeholders substituted, then the terminal `fetch` — the
   *  same door a loaded worker's `globalOutbound` and the edge `itx.fetch(request)` land on. */
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
  /** The rewrite-rule table, read — THE EFFECTIVE table: the context's own rows (`origin:
   *  "context"`, a mask shown as `target: null`) plus the implicit platform rows (`origin:
   *  "platform"`) for every root the context has not re-set. Written by `itx.provide` on the edge,
   *  never a verb here. `resolve(call)` is the PURE half of `invoke`: the chain of rewrites, each
   *  printed, nothing dispatched — `invoke(call) ≡ invoke(resolve(call).at(-1))`. */
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
  /** THE PROCESSORS LAYER — the third of the onion's three, each on the one below: `rpcStubs` (a live
   *  value), `subscriptions` (a delivery to a target), `processors` (a subscription whose target is a
   *  hosted facet's `processEventBatch`). `enable(name, spec)` hosts `className` (the
   *  `StreamProcessorDurableObject` subclass `source` exports — the host whose `processor` field holds
   *  the pure `StreamProcessor`) as the facet `name` and subscribes it to every commit: literally ONE
   *  `subscription-configured` event whose target is `itx.builtins.facets.get(name, spec).processEventBatch`;
   *  DURABLE, no handle — a processor outlives the session that enabled it. `disable(name)` is ONE
   *  event, `{ name, target: null }`: the DO deletes the facet the row hosted, storage included, before
   *  the append returns, so a re-enable is a clean rebuild from the log. `list()` is the subscriptions
   *  that host a facet. `consumes` is the subscription's filter (absent = every durable event). A root,
   *  so loaded code (`env.ITX.get().processors.enable(…)`) and a sibling (`itx.cd(p).processors…`) do
   *  it through the same door as a client. */
  processors: {
    enable(name: string, spec: FacetSpec & { consumes?: string[] }): Promise<{ name: string }>;
    disable(name: string): Promise<void>;
    list(): SubscriptionListEntry[];
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
}

// THE ONE LIST: `keyof BuiltInScope` (minus the reserved root itself, which names the record, not a
// key of it) and context/itx-expression-rewriting.ts's `BUILT_IN_ROOTS` are the same set — a root added to
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
  /** The bindings the built-ins reach (the workers lane binds neither AI nor Artifacts; nothing
   *  there calls them). */
  env: {
    LOADER: WorkerLoader;
    ITX_KV: KVNamespace;
    /** The per-project secret store egress substitutes from (`secret:<projectId>:<name>`). */
    SECRETS_KV: KVNamespace;
    AI: Ai;
    ARTIFACTS: ArtifactsNamespace;
  };
  /** The deploy identity every loader cacheKey folds in (worker.ts `AppConfig`). */
  deployId: string;
  /** The Artifacts account + namespace `itx.repos` builds git remotes from (worker.ts `AppConfig`). */
  artifactsAccountId: string;
  artifactsNamespace: string;
  /** The secrets catalog — names and origins, from the core reduce (strongly consistent; a KV list
   *  lags a write by up to a minute). */
  secrets: () => { name: string; origin?: string }[];
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
  /** The rpcStubs view — closures over the DO's transport table (the pager sockets can never move). */
  rpcStubs: BuiltInScope["rpcStubs"];
  subscriptions: BuiltInScope["subscriptions"];
  rewriteRules: BuiltInScope["rewriteRules"];
  /** The own context's — a wait never crosses a hop. */
  waitForEvent: BuiltInScope["waitForEvent"];
  /** The facet door, verbatim (accepted trade: a busy stateful facet pins its stream). */
  facets: BuiltInScope["facets"];
  /** The `ItxEntrypoint` stub a loaded worker gets as `env.ITX` and `globalOutbound` — the loopback
   *  minted once for this context (the DO's `#itxEntrypoint`; iterate-context.ts's `ItxEntrypoint` for why it is never a
   *  raw getByName stub). */
  itxEntrypoint: Fetcher;
  /** THE LIBRARY's roots (library.ts `buildLibrary(itx).roots`), built by the DO over its own
   *  `itx` handle so a library call's `itx.fetch(...)` resolves through THIS context's rules. */
  library: LibraryRoots;
}

/** Assemble the built-in scope for one context. Every entry closes over the context's identity —
 *  PRE-SCOPED, not policed: cross-project access is unspellable by construction. */
export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const { projectId, path, iterateContextName, env } = deps;

  const kvPrefix = `${projectId}:`;
  const ownContext = () => deps.context(path);
  // A project secret lives at `secret:<projectId>:<name>` — the key the DO's egress door reads.
  const secretKey = (name: string): string => {
    if (!/^[a-zA-Z0-9._-]+$/.test(name))
      throw new Error(
        `secrets: a name is [a-zA-Z0-9._-]+ (what getSecret("/secrets/NAME") can spell), got ${JSON.stringify(name)}`,
      );
    return `secret:${projectId}:${name}`;
  };
  /** THE append: every event appended through this scope carries WHO appended it — the DO's own
   *  stamp, never a client's (src/principal.ts): the session's verified principal, or none. */
  const append = (...events: StreamEventInput[]) =>
    ownContext().append(...events.map((event) => stampPrincipal(event, deps.principal())));
  /** Secrets are the PROJECT's: the value's key is project-scoped, so the catalog lives in ONE log —
   *  the root context's. Each `secrets` verb runs `here` on the root context, and on a child context
   *  runs as the same call on the root, over the DO hop. */
  const rootContext = path === "/" ? null : deps.context("/");
  const onRootContext = <T>(call: ItxExpressionStep, here: () => Promise<T>): Promise<T> =>
    rootContext ? (rootContext.invoke(["itx", "builtins", "secrets", call]) as Promise<T>) : here();

  // Each root implements one member of `BuiltInScope` above (the canonical doc of the surface); the
  // comments here add only the WHY of a code branch.
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
    secrets: {
      set: (name, value, options) =>
        onRootContext(["set", name, value, options], async () => {
          const origin = options?.origin === undefined ? undefined : new URL(options.origin).origin;
          // The change is appended FIRST: a refused append (a paused stream) leaves the value
          // untouched; a KV failure after it leaves a catalog row whose value egress cannot find —
          // loud, not silent.
          const key = secretKey(name);
          await append({
            type: "events.iterate.com/secrets/changed",
            payload: { name, ...(origin && { origin }) },
          });
          await env.SECRETS_KV.put(key, String(value), { metadata: { ...(origin && { origin }) } });
          return { ok: true as const };
        }),
      delete: (name) =>
        onRootContext(["delete", name], async () => {
          const key = secretKey(name);
          await append({
            type: "events.iterate.com/secrets/changed",
            payload: { name, deleted: true },
          });
          await env.SECRETS_KV.delete(key);
          return { ok: true as const };
        }),
      list: () => onRootContext(["list"], async () => deps.secrets()),
    },
    ai: env.AI, // the binding object itself — dispatch walks its methods
    cfArtifacts: projectScopedArtifacts(env.ARTIFACTS, projectId),
    repos: projectScopedRepos({
      namespace: env.ARTIFACTS,
      projectId,
      accountId: deps.artifactsAccountId,
      namespaceName: deps.artifactsNamespace,
    }),
    append,
    readEvents: (afterOffset?: number, limit?: number) => ownContext().read(afterOffset, limit),
    waitForEvent: deps.waitForEvent,
    // WHO crosses with the call: a sibling context runs it under the caller's principal (a Workers-RPC
    // hop, where the ambient store does not reach), so an event appended there is attributed too.
    cd: (contextPath: string) =>
      new InvokeHandle((itxExpressionSteps) => {
        const context = deps.context(resolveContextPath(path, contextPath)); // a ReachableContext
        const principal = deps.principal();
        return principal
          ? context.invokeAs(principal, ["itx", ...itxExpressionSteps])
          : context.invoke(["itx", ...itxExpressionSteps]);
      }),
    fetch: (request: Request) => deps.egress(request),
    rpcStubs: deps.rpcStubs,
    facets: deps.facets,
    subscriptions: deps.subscriptions,
    processors: {
      enable: async (name, spec) => {
        // Refused HERE, before anything is appended: a spec names the source's host class (there are
        // no built-in processors to name), and its literal source is under the ceiling.
        if (typeof spec !== "object" || spec === null || typeof spec.className !== "string")
          throw new Error(
            `processors.enable(${JSON.stringify(name)}, { source, className, consumes? }): name the host class the source exports — there are no built-in processors to enable by name`,
          );
        assertFacetSourceWithinCeiling(spec, `processors.enable("${name}")`);
        await append(
          subscriptionConfiguredEvent({
            name,
            target: [
              "itx",
              "builtins",
              "facets",
              ["get", name, facetSpecOf(spec)],
              "processEventBatch",
            ],
            ...(spec.consumes && { consumes: spec.consumes }),
          }),
        );
        return { name };
      },
      disable: async (name) => {
        await append(subscriptionConfiguredEvent({ name, target: null }));
      },
      list: () => deps.subscriptions.list().filter((row) => row.hostedFacet !== undefined),
    },
    rewriteRules: deps.rewriteRules,
    // A genuine InvokeHandle so `workers.get(spec).run()` pipelines on every lane (workerd#6873). A
    // terminal `fetch(request)` is this same call: `entrypoint.fetch(request)` IS the entrypoint's
    // fetch channel, socket-bearing Responses included (context/rpc-stubs.ts doctrine, point 4).
    // Re-resolves per call; the loader caches by key, so a warm isolate is reused and a producer
    // expression never re-runs.
    workers: {
      get: (spec: {
        source: WorkerSource;
        cacheKey?: WorkerCacheKey;
        className?: string;
        props?: unknown;
      }) =>
        new InvokeHandle(async (methodSteps) => {
          const [call] = methodSteps;
          if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] === "")
            throw new Error(
              `workers.get(spec).${print(methodSteps)}: a WorkerEntrypoint exposes flat methods`,
            );
          const [method, ...args] = call;
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
        }),
    },
    ...deps.library, // THE LIBRARY (library.ts), built and owned by the DO
  } satisfies Omit<BuiltInScope, "builtins">;
}
