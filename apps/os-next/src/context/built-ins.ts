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
import { stampPrincipal, type Caller } from "../principal.ts";
import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";
import type { LibraryRoots } from "../library.ts";
import {
  DurableObjectNameCodec,
  GLOBAL_PROJECT_ID,
  resolveContextPath,
  resourceScope,
} from "../iterate-context.ts";
import { codedError } from "../lib.ts";
import {
  assertSecretName,
  normalizeSecretRecord,
  type SecretCatalogEntry,
  type SecretMaterial,
  type SecretRefresh,
} from "../secrets.ts";
import type { SecretDurableObject } from "../secret-durable-object.ts";
import { normalizeSecretOAuth, type SecretOAuthOptions } from "../secret-oauth.ts";
import {
  assertFacetSourceWithinCeiling,
  facetSpecOf,
  prepareConfinedWorker,
  type FacetSpec,
  type WorkerCacheKey,
  type WorkerSource,
} from "./worker-loader.ts";
import {
  itxExpressionStepName,
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
  projectScopedGit,
  type ArtifactsNamespace,
  type ArtifactsScope,
  type GitScope,
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
  /** Durable key/value prefixed with the RESOURCE OWNER's id (iterate-context.ts `resourceScope`:
   *  a project's id, or a global user's/organization's subtree) — the `${owner.id}:` prefix IS the
   *  isolation. */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  /** The resource owner's secrets for egress (a project's; a global user's or organization's own —
   *  never a catalog shared across users) — each one its own Durable Object (secrets.ts,
   *  secret-durable-object.ts): a `getSecret("/secrets/NAME")` placeholder in an outbound request's
   *  URL (path or query) or headers substitutes to the value at egress (`fetch`), and
   *  `getSecret("/secrets/NAME", { field: "a.b" })` to one string field of a JSON material —
   *  apps/os's placeholder grammar for a URL or a header (not its `Basic base64(user:getSecret(…))`
   *  peeling nor its JSON-body template — the body is never scanned). The material is a string or a
   *  JSON object; `urls` (required) pins it to those ORIGINS only — a mis-typed URL cannot mail a
   *  credential to a stranger, nor can an app that forwards a visitor's headers; `refresh` names the
   *  strategy the secret's object re-mints an expired credential with, in trusted code, on a 401 or
   *  on first use (`oauth-refresh-token`, `waitrose-session`). WRITE-ONLY — `set`, `beginOAuth`,
   *  `delete`, and a `list` of names, pins and strategy kinds, never a value. Every change appends
   *  `events.iterate.com/secrets/changed` with the name, the pin and the strategy kind (or
   *  `deleted`) — the value never enters the log — attributed like any append (`source.principal`);
   *  a refresh's outcome is `secrets/refreshed { name, kind, ok, error? }`, appended by the object.
   *  A name is what the placeholder can spell, `[a-zA-Z0-9._-]+`. */
  secrets: {
    set(
      name: string,
      material: SecretMaterial,
      options: { urls: string[]; refresh?: SecretRefresh },
    ): Promise<{ ok: true }>;
    /** OAUTH, THE FIRST TOKENS (secret-oauth.ts): hand back the provider's authorize URL for the
     *  project's own OAuth client — send a human there. The provider redirects the human to the
     *  platform's callback (`/.secrets/oauth/callback`; the human must be signed in to Iterate as
     *  someone who reaches the secret's owner — a project's member, the user themself for a user's
     *  own secret), and the secret's own Durable Object exchanges the code, becomes an
     *  `oauth-refresh-token` secret, and the catalog fact is appended. Until then nothing is stored
     *  under `name` but the attempt. */
    beginOAuth(name: string, options: SecretOAuthOptions): Promise<{ authorizationUrl: string }>;
    /** The platform's callback completes the attempt through here — the exchange in the secret's
     *  object, then the catalog fact, in the same per-name order as `set` and `delete`. You never
     *  call this: the code and the nonce reach only the callback. */
    completeOAuth(name: string, input: { code: string; nonce: string }): Promise<{ ok: true }>;
    delete(name: string): Promise<{ ok: true }>;
    list(): Promise<SecretCatalogEntry[]>;
  };
  /** THE FIRST BINDINGS ROOT: Cloudflare's Workers AI binding, VERBATIM — `run(model, inputs,
   *  options?)`, `models()`, `gateway(id).run({ provider, endpoint, headers, query })`, `toMarkdown()`,
   *  `autorag(id)` — no wrapper, so `itx.ai` reads exactly like `env.AI` and a rewrite rule can pin a
   *  model with `@` (`itx.fable ⇒ itx.ai.run('@cf/…', @)`). A test shadows it with `provide("itx.ai",
   *  fake)`; the physical door stays `itx.builtins.ai`. */
  ai: Ai;
  /** THE ESCAPE HATCH: the raw Cloudflare Artifacts binding, project-scoped (repos.ts
   *  `ArtifactsScope`); `itx.git` is built on top of it. */
  cfArtifacts: ArtifactsScope;
  /** THE GIT ROOT (repos.ts `GitScope`), built on `cfArtifacts` — the PHYSICAL half of repos: a
   *  repo's files on `main` over git-over-HTTPS, by repo-relative path — `list()`, `create`, `tip`,
   *  `snapshot`, `readFile`, `listFiles`, `commitFiles` (one commit, many files), `writeFile`,
   *  `log`. Stateless: every read fetches the tip. The domain half — `itx.repos.get(name)`, the repo
   *  as a stream on `/repos/<name>` with its birth, its commit facts and the tip cache — is the
   *  repo facet (src/repo/), a library root over this one. */
  git: GitScope;
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
    /** The secrets' Durable Objects (secret-durable-object.ts): one per secret, `<owner.id>:<name>` — the
     *  resource owner's id (iterate-context.ts `resourceScope`). */
    SECRET: DurableObjectNamespace<SecretDurableObject>;
    AI: Ai;
    ARTIFACTS: ArtifactsNamespace;
  };
  /** The deploy identity every loader cacheKey folds in (worker.ts `AppConfig`). */
  deployId: string;
  /** The Artifacts account + namespace `itx.git` builds git remotes from (worker.ts `AppConfig`). */
  artifactsAccountId: string;
  artifactsNamespace: string;
  /** The secrets catalog — names, pins and strategy kinds, from the core reduce (strongly
   *  consistent; never a value). */
  secrets: () => SecretCatalogEntry[];
  /** Evaluate a producer source expression through THIS context's dispatch (inside the loader's
   *  `getCode`, so only on a cold isolate). */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** A context stream by CANONICAL path — the own-path parent adapter same-isolate, by-name DO
   *  stubs otherwise. Both satisfy ReachableContext (uniform-async, real-typed — see stream/stream.ts). */
  context: (path: string) => ReachableContext;
  /** The context's egress terminal (secret substitution → `fetch`). */
  egress: (request: Request) => Promise<Response>;
  /** WHO is calling right now — the `Caller` the DO runs this call under (the fetch lane's header,
   *  or the edge's stamp), `{ principal: null }` for an anonymous session, a processor, a loaded
   *  worker and the KERNEL's own delivery loop. Carried across sibling `cd` hops; in the global
   *  namespace `cd` reads it to tell the kernel's config funnel from a person's path. */
  caller: () => Caller;
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

  // THE RESOURCE OWNER (iterate-context.ts `resourceScope`): the project itself, or — in the global
  // namespace — the user's or organization's subtree. Every resource key below is prefixed with
  // `owner.id`; the secrets catalog lives in the log at `owner.rootPath`.
  const owner = resourceScope(projectId, path);
  const kvPrefix = `${owner.id}:`;
  const ownContext = () => deps.context(path);
  // A secret's Durable Object is `<owner.id>:<name>` — the one the context DO's `#egress` forwards a
  // placeholder-bearing request to, by the same derivation (an owner id never holds a `:`). The
  // object appends its own facts (a refresh's outcome, an OAuth completion) to the owner's root log.
  const secretStore = (name: string) =>
    env.SECRET.getByName(`${owner.id}:${assertSecretName(name)}`);
  const secretsCatalog = DurableObjectNameCodec.stringify({ projectId, path: owner.rootPath });
  /** THE append: every event appended through this scope carries WHO appended it — the DO's own
   *  stamp, never a client's (src/principal.ts): the session's verified principal, or none. */
  const append = (...events: StreamEventInput[]) =>
    ownContext().append(...events.map((event) => stampPrincipal(event, deps.caller().principal)));
  /** Secrets are the RESOURCE OWNER's: the value's key is owner-scoped, so the catalog lives in ONE
   *  log — the owner's root context (`owner.rootPath`: a project's `/`, a user's `/users/<id>`).
   *  Each `secrets` verb runs `here` on that root, and on a context below it runs as the same call
   *  on the root, over the DO hop. A user's context IS its own root: no hop, no shared catalog. */
  // A context below the owner's root runs every secrets verb as the SAME call on that ROOT (one
  // catalog, in the root's log). Acquire the root context PER CALL: a stub cached across calls
  // stays broken after a root DO failure (Cloudflare's DO error-handling requires re-acquiring). And
  // forward `deps.caller()` so the durable change event keeps the child call's authenticated principal.
  const onRootContext = <T>(call: ItxExpressionStep, here: () => Promise<T>): Promise<T> =>
    path === owner.rootPath
      ? here()
      : // The owner root runs the SAME secrets verb `here` would run (the one built-in, the same
        // arguments), so its answer has `here`'s type; `invoke` is untyped across the DO hop.
        (deps
          .context(owner.rootPath)
          .invoke(["itx", "builtins", "secrets", call], [], deps.caller()) as Promise<T>);

  // A secret mutation is append-THEN-object, two awaits; a concurrent set and delete of the SAME name
  // could commit the log in one order while their object writes land in the other, leaving egress a
  // value the catalog says is gone (or vice versa). Serialize per name — on the owner's root DO, where
  // every verb runs (`onRootContext`) — so the log order IS the object's order. Different names never
  // contend. (This is `#builtIns`, built ONCE per DO instance, so the chain persists across calls.) An
  // eviction BETWEEN a delete's append and its clear can still strand a value — the catalog is the
  // index a reconciliation sweep would walk; see docs/cleanup-log.md.
  const secretMutations = new Map<string, Promise<unknown>>();
  const serializeSecretMutation = <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const result = (secretMutations.get(name) ?? Promise.resolve()).then(work, work);
    secretMutations.set(
      name,
      result.catch(() => {}),
    );
    return result;
  };

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
            cursor,
          });
          for (const k of page.keys) out.push(k.name.slice(kvPrefix.length));
          if (page.list_complete) return { keys: out };
          cursor = page.cursor;
        }
      },
    },
    secrets: {
      set: (name, material, options) =>
        onRootContext(["set", name, material, options], () =>
          serializeSecretMutation(name, async () => {
            const store = secretStore(name);
            const record = normalizeSecretRecord(material, options);
            // The change is appended FIRST: a refused append (a paused stream) leaves the value
            // untouched; an object failure after it leaves a catalog row whose value egress cannot
            // find — loud, not silent. The fact carries the pin and the strategy KIND, never the material.
            await append({
              type: "events.iterate.com/secrets/changed",
              payload: {
                name,
                urls: record.urls,
                ...(record.refresh && { refresh: record.refresh.kind }),
              },
            });
            await store.set(record, secretsCatalog);
            return { ok: true as const };
          }),
        ),
      // No append here: the catalog learns of the secret when the exchange succeeds, so an
      // abandoned attempt leaves no row that advertises a pin and a strategy the object does not hold.
      beginOAuth: (name, options) =>
        onRootContext(["beginOAuth", name, options], () =>
          secretStore(name).beginOAuth(normalizeSecretOAuth(options), secretsCatalog),
        ),
      // The object FIRST here (the exchange most often fails on the provider's side — a junk code,
      // a stale attempt — and must leave no row), then the fact; a refused append clears the object
      // again, so what `list()` says and what egress finds never disagree. Serialized per name with
      // `set` and `delete`, like every catalog write.
      completeOAuth: (name, input) =>
        onRootContext(["completeOAuth", name, input], () =>
          serializeSecretMutation(name, async () => {
            const store = secretStore(name);
            const { urls } = await store.completeOAuth(input);
            try {
              await append({
                type: "events.iterate.com/secrets/changed",
                payload: { name, urls, refresh: "oauth-refresh-token" },
              });
            } catch (error) {
              await store.clear();
              throw error;
            }
            return { ok: true as const };
          }),
        ),
      delete: (name) =>
        onRootContext(["delete", name], () =>
          serializeSecretMutation(name, async () => {
            const store = secretStore(name);
            await append({
              type: "events.iterate.com/secrets/changed",
              payload: { name, deleted: true },
            });
            await store.clear();
            return { ok: true as const };
          }),
        ),
      list: () => onRootContext(["list"], async () => deps.secrets()),
    },
    ai: env.AI, // the binding object itself — dispatch walks its methods
    cfArtifacts: projectScopedArtifacts(env.ARTIFACTS, owner.id),
    git: projectScopedGit({
      namespace: env.ARTIFACTS,
      projectId: owner.id,
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
        const siblingPath = resolveContextPath(path, contextPath);
        // THE GLOBAL NAMESPACE IS NOT NAVIGABLE (iterate-context.ts `cd`): a person's expression —
        // a rule or subscription written into their own context, run under their principal — may
        // not name another global path. The ONE hop that exists here is the kernel's config funnel,
        // `itx.cd('/').worker…` (the birth row every context carries), which the delivery loop runs
        // under NO principal — so a user's row that spells the same hop can only feed the funnel.
        // Stamped `retryable: false`: a subscription row naming another path can only repeat this
        // refusal, so the delivery loop halts it at once instead of climbing its ladder.
        if (
          projectId === GLOBAL_PROJECT_ID &&
          !(
            deps.caller().principal === null &&
            siblingPath === "/" &&
            itxExpressionStepName(itxExpressionSteps[0]) === "worker"
          )
        )
          throw Object.assign(
            codedError(
              "FORBIDDEN",
              "a global context is reached by identity (session.user, session.organizations), never by path",
            ),
            { retryable: false },
          );
        const context = deps.context(siblingPath); // a ReachableContext
        // The caller crosses with the call: the sibling runs it under the same Caller, so an event
        // appended there is attributed too.
        return context.invoke(["itx", ...itxExpressionSteps], [], deps.caller());
      }),
    fetch: (request: Request) => deps.egress(request),
    rpcStubs: deps.rpcStubs,
    facets: deps.facets,
    subscriptions: deps.subscriptions,
    processors: {
      enable: async (name, spec) => {
        // Refused HERE, before anything is appended: a spec names the source's host class (there are
        // no built-in processors to name), and its literal source is under the ceiling.
        // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a caller-supplied spec (its static type is a claim, not a guarantee, across the capability boundary)
        if (typeof spec !== "object" || spec === null || typeof spec.className !== "string")
          throw new Error(
            `processors.enable(${JSON.stringify(name)}, { source, className, consumes? }): name the host class the source exports — there are no built-in processors to enable by name`,
          );
        assertFacetSourceWithinCeiling(spec, `processors.enable("${name}")`);
        await append({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            name,
            target: [
              "itx",
              "builtins",
              "facets",
              ["get", name, facetSpecOf(spec)],
              "processEventBatch",
            ],
            consumes: spec.consumes,
          },
        });
        return { name };
      },
      disable: async (name) => {
        await append({
          type: "events.iterate.com/stream/subscription-configured",
          payload: { name, target: null },
        });
      },
      list: () => deps.subscriptions.list().filter((row) => row.hostedFacet),
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
          const { load } = await prepareConfinedWorker({
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
          const entrypoint = load().getEntrypoint(
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
