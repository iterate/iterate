// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (the one list
// is context/itx-expression-rewriting.ts). Three kinds of key, one record: the AXIOMS (the log, the stub
// registry, the rule table, the two hosts, addressing), the BINDINGS (`kv`, `secrets`, `ai`,
// `browser`, `cfArtifacts`, `repos` — a Cloudflare binding only this env holds, exposed or scoped) and THE
// LIBRARY (`connectTo*`, library.ts — code a user could write, taking only `itx`).
// THE RECORD IS `itx.builtins`, the reserved root: `itx.builtins.<root>…` runs against it directly
// and never reads the rule table; a short `itx.<root>…` reaches it through the IMPLICIT PLATFORM ROW
// unless the context's own table says otherwise (itx-expression-rewriting.ts, rule 5) — so a test may
// shadow `itx.ai`, a context may mask `itx.kv`, and `itx.builtins.…` is always the physical door.
// Dynamic code has two doors, one per host kind: `workers.get(spec)` (stateless) and
// `facets.get(name, spec)` (durable) — the `BuiltInScope` members below say what each takes.

import { codedError, jsonEqual, resolveContextPath } from "iterate/next/lib";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_GRANT_HEADER,
  ITX_PRINCIPAL_HEADER,
  stampCaller,
  type Caller,
} from "iterate/next/principal";
import type { StreamEvent, StreamEventInput } from "iterate/next/stream/processor";
import {
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionStep,
  FacetHandle,
  InvokeHandle,
  RpcStubHandle,
  materializeItxHandleReference,
} from "iterate/next/expression";
import type { RewriteRuleListEntry, StreamPage, WaitForEventFilter } from "iterate/next/api";
import { projectUrlOf, type IngressRouting } from "iterate/next/project-ingress";
import { FIRST_PARTY_FACET_CLASSES, firstPartyFacetClassOf } from "../first-party-facets.ts";
import {
  ScheduleKey,
  ScheduleReceipt,
  type ScheduledAppendInput,
  type ScheduledAppend,
} from "../stream/scheduled-appends.ts";
import type { ReachableContext } from "../stream/stream.ts";
import type { LibraryRoots } from "../library.ts";
import {
  assertSecretPath,
  normalizeSecretRecord,
  type SecretCatalogEntry,
  type SecretHmacVerification,
  type SecretMaterial,
  type SecretRefresh,
} from "../secrets.ts";
import type { SecretCatalog, SecretState } from "../secret/contract.ts";
import { normalizeSecretOAuth, type SecretOAuthOptions } from "../secret-oauth.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
  FETCH_UPGRADE_SOCKET_HEADER,
  encodeFetchExpression,
  terminalFetchOf,
} from "./rpc-stubs.ts";
import { admitLoadedCodeRow, refuseSelfLoopRow } from "./itx-expression-rewriting.ts";
import { GLOBAL_PROJECT_ID, resourceScope } from "./paths.ts";
import {
  assertFacetSourceWithinCeiling,
  facetSpecOf,
  prepareConfinedWorker,
  type FacetSpec,
  type WorkerCacheKey,
  type WorkerSource,
} from "./worker-loader.ts";
import type { BuiltInRoot } from "./itx-expression-rewriting.ts";
import { cfBrowser } from "./browser.ts";
import { projectScopedArtifacts, type ArtifactsNamespace, type ArtifactsScope } from "./repos.ts";

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
  hostedFacet?: { name: string; className: string; cacheKey?: string; restarts: number };
  /** Present only when the STREAM keeps the cursor (a target that cannot own its progress). */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
};

/** An `R2Object` as `itx.r2` answers it: every field the class carries, as data — the key with the
 *  owner prefix stripped, dates as ISO strings, checksums as hex. */
export type R2ObjectRecord = {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  checksums: Record<string, string>;
  uploaded: string;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  range?: R2Range;
  storageClass: string;
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
  whoami():
    | { projectId: string; path: string; projectSlug?: string; projectUrl?: string }
    | Promise<{ projectId: string; path: string; projectSlug?: string; projectUrl?: string }>;
  /** THE PUBLIC URL of this project over HTTP — the apex (the config worker's `fetch`) or `app`'s
   *  (`itx.apps.<app>`), at `path` (default "/") — composed from the deployment's ingress routing
   *  (iterate/next/project-ingress: `<app>--<slug>.<hostname>/…` under subdomains,
   *  `<origin>/<slug>/<app>/…` under paths). Refused on a deployment with no project ingress, and on
   *  a call carrying no platform origin (a processor's own turn, a loaded worker: hold the URL a
   *  session handed you instead). Only a project's context has one. */
  url(target?: { app?: string; path?: string }): Promise<string>;
  /** Durable key/value prefixed with the RESOURCE OWNER's id (iterate-context.ts `resourceScope`:
   *  a project's id, or a global user's/organization's subtree) — the `${owner.id}:` prefix IS the
   *  isolation. */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  /** THE OBJECT STORE: the R2 bucket binding, verbatim, on the resource owner's slice of ONE bucket
   *  (`FILES`) — every key prefixed `<owner.id>/` as kv's are `<owner.id>:`, the prefix applied to
   *  every key and `prefix`/`startAfter` option and stripped from every key and prefix answered.
   *  The binding's own verbs, arguments and pagination (`list` is ONE page, with its cursor); what
   *  cannot cross the wire is answered as data — an `R2Object` as its fields, a body as its bytes.
   *  `presign` is the one verb the binding lacks: a signed URL on the project host (file-urls.ts),
   *  a download or an upload, the platform serving the bytes itself — R2's own presigned URLs need
   *  S3 credentials this worker does not hold. Multipart uploads are not here yet. */
  r2: {
    head(key: string): Promise<R2ObjectRecord | null>;
    get(
      key: string,
      options?: { range?: R2Range },
    ): Promise<(R2ObjectRecord & { data: Uint8Array }) | null>;
    put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | null,
      options?: {
        httpMetadata?: R2HTTPMetadata;
        customMetadata?: Record<string, string>;
        storageClass?: string;
      },
    ): Promise<R2ObjectRecord>;
    delete(keys: string | string[]): Promise<void>;
    list(options?: {
      limit?: number;
      prefix?: string;
      cursor?: string;
      delimiter?: string;
      startAfter?: string;
    }): Promise<{
      objects: R2ObjectRecord[];
      delimitedPrefixes: string[];
      truncated: boolean;
      cursor?: string;
    }>;
    presign(input: {
      key: string;
      method?: "GET" | "PUT";
      expiresInSeconds?: number;
    }): Promise<{ url: string; expiresAt: string }>;
  };
  /** THE SECRETS (src/secret/): a secret as a DOMAIN OBJECT — the context at `/secrets/<name>`
   *  under the resource owner's root (a project's; a global user's or organization's own — never a
   *  catalog shared across users), whose `secret` facet is the material's one keeper. A secret IS
   *  its path, and the path is what the placeholder spells: `getSecret("/secrets/<name>")` in an
   *  outbound request's URL (path or query) or headers substitutes to the value at egress
   *  (`fetch`), and `getSecret("/secrets/<name>", { field: "a.b" })` to one string field of a JSON
   *  material — apps/os's placeholder grammar for a URL or a header (not its `Basic
   *  base64(user:getSecret(…))` peeling nor its JSON-body template — the body is never scanned).
   *  The material is a string or a JSON object; `urls` (required) pins it to those ORIGINS only — a
   *  mis-typed URL cannot mail a credential to a stranger, nor can an app that forwards a visitor's
   *  headers; `refresh` names the strategy the facet re-mints an expired credential with, in trusted
   *  code, on a 401 or on first use (`oauth-refresh-token`, `waitrose-session`). WRITE-ONLY — `set`,
   *  `beginOAuth`, `delete`, and a `list` of paths, pins and strategy kinds, never a value. Every
   *  verb runs ON THE SECRET'S PATH (so the log's order is the value's) and lands its fact there —
   *  `secret/set { path, urls, refresh? }`, `secret/deleted { path }` — attributed like any append
   *  (`source.principal`), and cross-posts it to the owner's root, whose catalog `list()` reads; the
   *  value never enters a log. The facet's own facts: `secret/used` per dispatch, `secret/refreshed`
   *  per refresh outcome. The secret's state (whether material is stored, by the offset of the fact
   *  that says so) is `itx.cd(path).facets.get("secret").snapshot()`. */
  secrets: {
    set(
      path: string,
      material: SecretMaterial,
      options: { urls: string[]; refresh?: SecretRefresh },
    ): Promise<{ path: string }>;
    /** OAUTH, THE FIRST TOKENS (secret-oauth.ts): hand back the provider's authorize URL for the
     *  project's own OAuth client — send a human there. The provider redirects the human to the
     *  platform's callback (`/.secrets/oauth/callback`; the human must be signed in to Iterate as
     *  someone who reaches the secret's owner — a project's member, the user themself for a user's
     *  own secret), and the secret's facet exchanges the code, becomes an `oauth-refresh-token`
     *  secret, and `secret/set` lands. Until then nothing is stored at `path` but the attempt. */
    beginOAuth(path: string, options: SecretOAuthOptions): Promise<{ authorizationUrl: string }>;
    /** The platform's callback completes the attempt through here — the exchange in the secret's
     *  facet, then the facts, on the secret's path like `set` and `delete`. You never call this:
     *  the code and the nonce reach only the callback. */
    completeOAuth(path: string, input: { code: string; nonce: string }): Promise<{ path: string }>;
    /** Forget the value: the facet clears it, `secret/deleted` lands on the path and on the owner's
     *  root, and the `secret` processor row goes (the facet's storage with it). A secret never set
     *  has nothing to delete (thrown); one already deleted answers at once; a deleted secret can be
     *  set again. */
    delete(path: string): Promise<{ path: string }>;
    list(): Promise<SecretCatalogEntry[]>;
    /** THE VERIFY LANE — a webhook's signature checked against a secret WITHOUT revealing it: is
     *  `signature` (hex, either case) the HMAC-SHA256 of `payload` (a string is its UTF-8 bytes)
     *  under the secret's material — the whole value, or the string at `field` of a JSON value?
     *  Runs in the secret's facet on its own context; one bit comes back. Constant-time, and a
     *  secret never set (or a material with no key at the field) answers false, never a description
     *  — the candidate comes from an unauthenticated door. The caller assembles the signed bytes the
     *  provider's scheme names (Stripe `${t}.${body}` with its own tolerance check on `t`, GitHub the
     *  body, Slack `v0:${t}:${body}`) and strips the scheme's prefix (`sha256=`, `v0=`). */
    verifyHmac(path: string, input: SecretHmacVerification): Promise<boolean>;
  };
  /** THE FIRST BINDINGS ROOT: Cloudflare's Workers AI binding, VERBATIM — `run(model, inputs,
   *  options?)`, `models()`, `gateway(id).run({ provider, endpoint, headers, query })`, `toMarkdown()`,
   *  `autorag(id)` — no wrapper, so `itx.ai` reads exactly like `env.AI` and a rewrite rule can pin a
   *  model with `@` (`itx.fable ⇒ itx.ai.run('@cf/…', @)`). A test shadows it with `provide("itx.ai",
   *  fake)`; the physical door stays `itx.builtins.ai`. */
  ai: Ai;
  /** Cloudflare Browser Run (`apps/os` `itx.browser`): `.quickAction(action, options)` returns the
   *  action's RESULT; `.fetch(input, init)` is the raw CDP door. */
  browser: ReturnType<typeof cfBrowser>;
  /** THE ARTIFACTS PROXY (repos.ts `ArtifactsScope`): Cloudflare Artifacts, project-scoped and
   *  addressed BY THE REPO'S PATH — the binding's own verbs only: `create`, `get` (a handle with
   *  `createToken` and `remote()`), `list`, `delete`. Git itself is the repo facet's (src/repo/, the
   *  domain object `itx.repos.get(path)` — THE way a project touches its repos): it mints its token and
   *  learns its remote here, then speaks git-over-HTTPS from inside its own worker. */
  cfArtifacts: ArtifactsScope;
  /** Append to this context's append-only event log (the facets that REDUCE it are
   *  `itx.facets.get(name)`). A top-level root, so the expression surface mirrors the edge
   *  RpcTarget exactly: `itx.append({...})` is one spelling on every hop. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** Durable batches appended after a deadline or on a fixed interval (missed ticks coalesce). Setting a key
   *  replaces it; cancelling cannot retract an occurrence already committed. Pause holds work
   *  until resume; set is refused while paused, while cancel remains available. Failure remains
   *  visible until replacement or cancellation. */
  schedules: {
    set(
      input: ScheduledAppendInput,
      options?: { idempotencyKey?: string },
    ): Promise<ScheduleReceipt>;
    cancel(schedule: ScheduleKey | ScheduleReceipt): Promise<StreamEvent[]>;
    list(): ScheduledAppend[];
    get(key: ScheduleKey): ScheduledAppend | null;
  };
  /** Read a page of the durable log — `itx.readEvents(afterOffset?, limit?)`, the twin of `append`
   *  (non-minting: a probe never wakes storage). `{ includeEphemeral: true }` merges in the
   *  ephemerals this incarnation still holds (stream.ts, the recent-ephemerals ring). */
  readEvents(
    afterOffset?: number,
    limit?: number,
    options?: { includeEphemeral?: boolean },
  ): Promise<StreamPage>;
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
    list(depth?: number): Promise<RewriteRuleListEntry[]>;
    get(match: string): Promise<RewriteRuleListEntry | null>;
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
    enable(
      name: string,
      spec?: (FacetSpec & { consumes?: string[] }) | { consumes?: string[] },
    ): Promise<{ name: string }>;
    disable(name: string): Promise<void>;
    list(): SubscriptionListEntry[];
    /** A hosted processor's claim on this context's alarm: "revive me by `at`" — the engine holds
     *  one while a `runInBackground` attempt is in flight (packages/iterate stream/processor.ts rule
     *  3) — or `null` to release it. Durable on the context (a kv row), never a log event. */
    claim(name: string, at: number | null): Promise<void>;
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

/** An `R2Object` as data, the owner prefix off its key. */
function r2ObjectRecord(object: R2Object, prefix: string): R2ObjectRecord {
  return {
    key: object.key.slice(prefix.length),
    version: object.version,
    size: object.size,
    etag: object.etag,
    httpEtag: object.httpEtag,
    // R2Checksums.toJSON: the hex forms — the class holds ArrayBuffers, which are not data over the wire.
    checksums: object.checksums.toJSON() as Record<string, string>,
    uploaded: object.uploaded.toISOString(),
    httpMetadata: object.httpMetadata || {},
    customMetadata: object.customMetadata || {},
    range: object.range,
    storageClass: object.storageClass,
  };
}

/** What the CONTEXT (the DO) injects: identity, the bindings, and the seams only it can serve. */
interface BuildBuiltInsDeps {
  projectInfo?: () => Promise<{ projectSlug?: string; projectUrl?: string }>;
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys). */
  iterateContextName: string;
  /** The bindings the built-ins reach (the workers lane binds neither AI, Browser Run, nor Artifacts;
   *  nothing there calls them). */
  env: {
    LOADER: WorkerLoader;
    ITX_KV: KVNamespace;
    /** The one R2 bucket, every owner's objects under its own prefix — the built-in root `itx.r2`. */
    FILES: R2Bucket;
    AI: Ai;
    BROWSER: BrowserRun;
    ARTIFACTS: ArtifactsNamespace;
  };
  /** The deploy identity every loader cacheKey folds in (worker.ts `AppConfig`). */
  deployId: string;
  /** How projects are reached over HTTP (app-config.ts `urls.ingressRouting`) — `itx.url`. */
  ingressRouting: IngressRouting;
  /** THE PLATFORM ORIGIN the current call's caller reached the platform on (the DO's caller record)
   *  — null when the call carries none: a processor's own turn, a loaded worker's `env.ITX`, the
   *  delivery loop, an alarm. */
  platformOrigin: () => string | null;
  /** A signed file URL on the project host (file-urls.ts `signedFileUrl`, closed over the app
   *  config's secret and hosts) — `itx.r2.presign`. */
  signFileUrl: (input: {
    project: string;
    key: string;
    method: "GET" | "PUT";
    expiresInSeconds?: number;
  }) => Promise<{ url: string; expiresAt: string }>;
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
   *  worker and the KERNEL's own delivery loop. Carried across permitted sibling `cd` hops. */
  caller: () => Caller;
  /** The rpcStubs view — closures over the DO's transport table (the pager sockets can never move). */
  rpcStubs: BuiltInScope["rpcStubs"];
  subscriptions: BuiltInScope["subscriptions"];
  schedules: {
    get(key: string): ScheduledAppend | null;
    list(): ScheduledAppend[];
  };
  rewriteRules: BuiltInScope["rewriteRules"];
  /** The own context's — a wait never crosses a hop. */
  waitForEvent: BuiltInScope["waitForEvent"];
  /** The facet door, verbatim (accepted trade: a busy stateful facet pins its stream). */
  facets: BuiltInScope["facets"];
  /** The DO's claim table for hosted processors (`processors.claim`). */
  claimFacetAlarm: (name: string, at: number | null) => void;
  /** The `ItxEntrypoint` stub a loaded worker gets as `env.ITX` and `globalOutbound` — the loopback
   *  minted for this context at its current origin (the DO's `#itxEntrypoint`; iterate-context.ts's `ItxEntrypoint` for why it is never a
   *  raw getByName stub). */
  itxEntrypoint: () => Fetcher;
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
  const r2Prefix = `${owner.id}/`;
  const ownContext = () => deps.context(path);
  /** THE append: every event appended through this scope carries WHO appended it — the DO's own
   *  stamp, never a client's (src/principal.ts): the session's verified principal, or none. */
  const append = (...events: StreamEventInput[]) => {
    const caller = deps.caller();
    // LOADED CODE's rows are walled on their targets (itx-expression-rewriting.ts): the same wall its
    // calls meet, applied where the row is written.
    for (const event of events) {
      refuseSelfLoopRow(event, path);
      if (caller.app) admitLoadedCodeRow(event, path);
    }
    return ownContext().append(...events.map((event) => stampCaller(event, caller)));
  };
  /** Secrets are the RESOURCE OWNER's, and a secret IS its path under the owner's root
   *  (`owner.rootPath`: a project's `/`, a user's `/users/<id>` — `resolveContextPath` joins
   *  `/secrets/<name>` onto it). Each writing verb runs `here` on the SECRET'S OWN context — where
   *  the `secret` facet keeps the value, so the log's order is the value's — and on any other
   *  context runs as the same call there, over the DO hop, the caller carried (the fact stays
   *  attributed). The catalog is the owner root's facet (`ownerRootFacet`). */
  // A context below the owner's root runs every secrets verb as the SAME call on that ROOT (one
  // catalog, in the root's log). Acquire the root context PER CALL: a stub cached across calls
  // stays broken after a root DO failure (Cloudflare's DO error-handling requires re-acquiring). And
  // forward `deps.caller()` so the durable change event keeps the child call's authenticated principal.
  /** THE PLATFORM'S OWN HOP: the caller rides — principal and grant (the facts stay attributed),
   *  path and origin — but never its `app`: the app wall (itx-expression-rewriting.ts `#admit`) is
   *  for what LOADED CODE spells on its input, and the expressions below are the platform's, fixed
   *  here, their arguments validated here. A script's `itx.secrets.set(…)` reaches this built-in
   *  through its creator's link and is answered exactly as a session's would be. */
  const hopCaller = (): Caller => {
    const { app: _loadedCode, ...caller } = deps.caller();
    return caller;
  };
  const onSecretContext = <T>(
    secretPath: string,
    call: ItxExpressionStep,
    here: (secret: ReachableContext) => Promise<T>,
  ): Promise<T> => {
    const contextPath = resolveContextPath(owner.rootPath, `.${assertSecretPath(secretPath)}`);
    return path === contextPath
      ? here(ownContext())
      : // The secret's context runs the SAME verb `here` would run (the one built-in, the same
        // arguments), so its answer has `here`'s type; `invoke` is untyped across the DO hop.
        (deps
          .context(contextPath)
          .invoke(["itx", "builtins", "secrets", call], [], hopCaller()) as Promise<T>);
  };
  /** The owner root's facet — where the catalog is folded from the certificates cross-posted there
   *  (src/project/contract.ts; src/account/contract.ts and src/organization/contract.ts for the
   *  global owners). The global root itself owns no secrets. */
  const ownerRootFacet = (): "project" | "account" | "organization" => {
    if (projectId !== GLOBAL_PROJECT_ID) return "project";
    if (owner.rootPath.startsWith("/users/")) return "account";
    if (owner.rootPath.startsWith("/organizations/")) return "organization";
    throw codedError(
      "INVALID_CONTEXT",
      "itx.secrets: the global root owns no secrets — a project's, a user's or an organization's context does",
    );
  };
  /** The `secret` processor row on the secret's context — the facet hosted with a row, so the
   *  engine pushes it every fact (idempotent at the door: a second enable of the same row is a no-op). */
  const enableSecretRow = (secret: ReachableContext) =>
    secret.invoke(["itx", "builtins", "processors", ["enable", "secret"]], [], hopCaller());
  /** The secret's facet on its own context — `write`, `clear`, `beginOAuth`, `completeOAuth`
   *  (secret/durable-object.ts) — reached through the facet door; hosted on its first call. */
  const secretFacet = (secret: ReachableContext, call: ItxExpressionStep) =>
    secret.invoke(["itx", "facets", ["get", "secret"], call], [], hopCaller());
  /** The fact of a write or a deletion: on the secret's own path (`secret`), attributed to the
   *  caller, then cross-posted to the owner's root for the catalog. */
  const crossPostSecretFact = (event: StreamEventInput) =>
    deps.context(owner.rootPath).invoke(["itx", "builtins", ["append", event]], [], hopCaller());
  const secretFact = async (secret: ReachableContext, event: StreamEventInput): Promise<void> => {
    await secret.append(stampCaller(event, deps.caller()));
    await crossPostSecretFact(event);
  };
  /** The `secret` processor rows on the secret's context — one while the secret lives. */
  const secretRows = (secret: ReachableContext) =>
    secret.invoke(["itx", "builtins", "processors", ["list"]], [], hopCaller()) as Promise<
      { name: string }[]
    >;

  // Each root implements one member of `BuiltInScope` above (the canonical doc of the surface); the
  // comments here add only the WHY of a code branch.
  return {
    whoami: () =>
      deps.projectInfo
        ? deps.projectInfo().then((project) => ({ projectId, path, ...project }))
        : { projectId, path },
    url: async (target: { app?: string; path?: string } = {}) => {
      const platformOrigin = deps.platformOrigin();
      if (!platformOrigin)
        throw codedError(
          "INVALID_INPUT",
          "itx.url: this call carries no platform origin to compose a URL with — call it from a session, or hold the URL a session handed you",
        );
      const slug = (await deps.projectInfo?.())?.projectSlug;
      if (!slug)
        throw codedError("INVALID_INPUT", "itx.url: only a project's context has a public URL");
      const url = projectUrlOf(deps.ingressRouting, platformOrigin, {
        project: slug,
        app: target.app || null,
        path: target.path,
      });
      if (!url)
        throw codedError(
          "INVALID_INPUT",
          deps.ingressRouting
            ? `itx.url: ${JSON.stringify(target)} is not an address in this project (an app label is [a-z][a-z0-9-]*; a path starts with "/")`
            : "itx.url: this deployment has no project ingress (APP_CONFIG urls.ingressRouting is unset) — nothing serves a project over HTTP",
        );
      return url.href;
    },
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
    r2: {
      head: async (key) => {
        const object = await env.FILES.head(r2Prefix + key);
        return object ? r2ObjectRecord(object, r2Prefix) : null;
      },
      get: async (key, options = {}) => {
        const object = await env.FILES.get(r2Prefix + key, options);
        if (!object) return null;
        return {
          ...r2ObjectRecord(object, r2Prefix),
          data: new Uint8Array(await object.arrayBuffer()),
        };
      },
      put: async (key, value, options = {}) =>
        r2ObjectRecord(await env.FILES.put(r2Prefix + key, value, options), r2Prefix),
      delete: (keys) =>
        env.FILES.delete(
          typeof keys === "string" ? r2Prefix + keys : keys.map((key) => r2Prefix + key),
        ),
      list: async (options = {}) => {
        const page = await env.FILES.list({
          ...options,
          prefix: r2Prefix + (options.prefix || ""),
          ...(options.startAfter && { startAfter: r2Prefix + options.startAfter }),
        });
        return {
          objects: page.objects.map((object) => r2ObjectRecord(object, r2Prefix)),
          delimitedPrefixes: page.delimitedPrefixes.map((prefix) => prefix.slice(r2Prefix.length)),
          truncated: page.truncated,
          ...(page.truncated && { cursor: page.cursor }),
        };
      },
      presign: (input) =>
        deps.signFileUrl({
          project: owner.id,
          key: input.key,
          method: input.method || "GET",
          expiresInSeconds: input.expiresInSeconds,
        }),
    },
    secrets: {
      // The fact is appended FIRST: a refused append (a paused stream) leaves no value behind; a
      // facet failure after it leaves a fact whose value egress cannot find — loud ("no stored
      // project secret"), not silent. The facts carry the pin and the strategy KIND, never the material.
      set: (secretPath, material, options) =>
        onSecretContext(secretPath, ["set", secretPath, material, options], async (secret) => {
          const record = normalizeSecretRecord(material, options);
          await enableSecretRow(secret);
          await secretFact(secret, {
            type: "events.iterate.com/secret/set",
            payload: {
              path: secretPath,
              urls: record.urls,
              ...(record.refresh && { refresh: record.refresh.kind }),
            },
          });
          await secretFacet(secret, ["write", record]);
          return { path: secretPath };
        }),
      // No fact here: the log learns of the secret when the exchange succeeds, so an abandoned
      // attempt leaves no row that advertises a pin and a strategy the facet does not hold.
      beginOAuth: (secretPath, options) => {
        // the provider's callback hangs under the platform origin — the caller's, not a DO's
        const platformOrigin = deps.platformOrigin();
        if (!platformOrigin)
          throw codedError(
            "INVALID_INPUT",
            "itx.secrets.beginOAuth: this call carries no platform origin for the callback URL — call it from a session",
          );
        return onSecretContext(secretPath, ["beginOAuth", secretPath, options], async (secret) => {
          await enableSecretRow(secret);
          return (await secretFacet(secret, [
            "beginOAuth",
            normalizeSecretOAuth(options),
            platformOrigin,
          ])) as { authorizationUrl: string };
        });
      },
      // The facet FIRST here (the exchange most often fails on the provider's side — a junk code, a
      // stale attempt — and must leave no fact), then the facts. A refused fact (a paused stream, a
      // lost cross-post) is the OAuth exception to "fail loud, never a live secret without its
      // row": the tokens stay — the person's consent cannot be re-obtained by a retry, and the code
      // was spent — the callback answers the error, and its replay (a refreshed tab; the facet
      // completes the attempt it completed idempotently, no second exchange) lands the facts and
      // catches the log up. Until then `list()` does not show the secret while egress already honours it.
      completeOAuth: (secretPath, input) =>
        onSecretContext(secretPath, ["completeOAuth", secretPath, input], async (secret) => {
          const { urls } = (await secretFacet(secret, ["completeOAuth", input])) as {
            urls: string[];
            exchanged: boolean;
          };
          await secretFact(secret, {
            type: "events.iterate.com/secret/set",
            payload: { path: secretPath, urls, refresh: "oauth-refresh-token" },
          });
          return { path: secretPath };
        }),
      // The facet FIRST here, the reverse of `set`: each verb runs its steps in the order whose
      // crash window fails LOUD. A clear not yet followed by its fact leaves a log that says set
      // while egress answers 502 ("no stored project secret") until the delete is retried; the
      // other order would leave live material behind a log that says it is gone — silent. The
      // `secret` processor row goes LAST, so the row standing IS the mark of a delete not finished:
      // a retry (a call that lost its answer after its own-path fact — before the cross-post, or
      // before the disable) cross-posts the certificate again (the catalog drops the entry once; a
      // second root fact is harmless) and takes the row; a delete that finished answers at once
      // and appends nothing.
      delete: (secretPath) =>
        onSecretContext(secretPath, ["delete", secretPath], async (secret) => {
          // The facet is the platform's own SecretDurableObject and `snapshot()` the engine's
          // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted.
          const { state } = (await secret.invoke(
            ["itx", "facets", ["get", "secret"], ["snapshot"]],
            [],
            hopCaller(),
          )) as { state: SecretState };
          if (!state.material && !state.deletion)
            throw new Error(`secret ${secretPath}: never set — nothing to delete`);
          const deleted: StreamEventInput = {
            type: "events.iterate.com/secret/deleted",
            payload: { path: secretPath },
          };
          const rowStands = (await secretRows(secret)).some((row) => row.name === "secret");
          if (state.material) {
            await secretFacet(secret, ["clear"]);
            await secretFact(secret, deleted);
          } else if (rowStands) await crossPostSecretFact(deleted);
          if (rowStands)
            await secret.invoke(
              ["itx", "builtins", "processors", ["disable", "secret"]],
              [],
              hopCaller(),
            );
          return { path: secretPath };
        }),
      // The owner root's catalog — strongly consistent with `set` and `delete`, which cross-post
      // their facts there before they answer.
      list: async () => {
        const { state } = (await deps
          .context(owner.rootPath)
          .invoke(["itx", "facets", ["get", ownerRootFacet()], ["snapshot"]], [], hopCaller())) as {
          state: { secrets: SecretCatalog };
        };
        return Object.entries(state.secrets).map(([path, row]) => ({ path, ...row }));
      },
      verifyHmac: (secretPath, input) =>
        onSecretContext(
          secretPath,
          ["verifyHmac", secretPath, input],
          (secret) => secretFacet(secret, ["verifyHmac", input]) as Promise<boolean>,
        ),
    },
    ai: env.AI, // the binding object itself — dispatch walks its methods
    browser: cfBrowser(env.BROWSER),
    cfArtifacts: projectScopedArtifacts({ namespace: env.ARTIFACTS, projectId: owner.id }),
    append,
    schedules: {
      ...deps.schedules,
      get: (key) => deps.schedules.get(ScheduleKey.parse(key)),
      set: async (input, options) => {
        const [definition] = await append({
          type: "events.iterate.com/stream/append-scheduled",
          payload: input,
          idempotencyKey: options?.idempotencyKey,
        });
        return ScheduleReceipt.parse({
          key: definition.payload?.key,
          scheduledAtOffset: definition.offset,
        });
      },
      cancel: (schedule) => {
        const receipt = ScheduleReceipt.safeParse(schedule);
        return append({
          type: "events.iterate.com/stream/append-schedule-cancelled",
          payload: receipt.success
            ? { key: receipt.data.key, ifScheduledAtOffset: receipt.data.scheduledAtOffset }
            : { key: ScheduleKey.parse(schedule) },
        });
      },
    },
    readEvents: (afterOffset?: number, limit?: number, options?: { includeEphemeral?: boolean }) =>
      ownContext().read(afterOffset, limit, options),
    waitForEvent: deps.waitForEvent,
    // WHO crosses with the call: a sibling context runs it under the caller's principal (a Workers-RPC
    // hop, where the ambient store does not reach), so an event appended there is attributed too.
    cd: (contextPath: string) => {
      // Captured when the handle is MADE: a handle held by loaded code and called later runs as that
      // code, never as whoever holds the store then. A relative path resolves against the caller's
      // ORIGINATING context when the call rode a hop here (`repos.get('./x')` answered at the root is
      // the caller's `./x`); a row's target should spell an absolute path.
      const caller = deps.caller();
      const base = caller.path || path;
      return new InvokeHandle((itxExpressionSteps) => {
        const siblingPath = resolveContextPath(base, contextPath);
        // Global contexts are addressed by identity, never navigated through cd.
        if (projectId === GLOBAL_PROJECT_ID)
          throw Object.assign(
            codedError(
              "FORBIDDEN",
              "a global context is reached by identity (session.user, session.organizations), never by path",
            ),
            { retryable: false },
          );
        const context = deps.context(siblingPath); // a ReachableContext
        // The caller crosses with the call — the sibling runs it under the same Caller, so an event
        // appended there is attributed too — stamped with the context it originated at (once, at the
        // first hop) so a relative path there still means the caller's.
        const terminalFetch = terminalFetchOf(["itx", ...itxExpressionSteps], []);
        if (terminalFetch) {
          // A socket-bearing Response must cross a native fetch, never Workers RPC.
          const headers = new Headers(terminalFetch.request.headers);
          for (const name of [
            ITX_PRINCIPAL_HEADER,
            ITX_GRANT_HEADER,
            ITX_APP_HEADER,
            "x-itx-platform-origin",
            RPC_STUB_PAGER_WEBSOCKET_HEADER,
            FETCH_UPGRADE_SOCKET_HEADER,
          ])
            headers.delete(name);
          headers.set(ITX_EXPRESSION_FETCH_HEADER, encodeFetchExpression(terminalFetch.steps));
          headers.set(ITX_CALLER_PATH_HEADER, caller.path || path);
          if (caller.principal) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(caller.principal));
          if (caller.grant) headers.set(ITX_GRANT_HEADER, caller.grant);
          if (caller.app) headers.set(ITX_APP_HEADER, "1");
          if (caller.platformOrigin) headers.set("x-itx-platform-origin", caller.platformOrigin);
          return context.fetch(new Request(terminalFetch.request, { headers }));
        }
        const hopCaller = { ...caller, path: caller.path || path };
        // The sibling names a handle by expression (expression.ts): this context mints its own over the
        // sibling's stub, so a handle held here is one whole call per verb, never a session held open.
        return Promise.resolve(context.invoke(["itx", ...itxExpressionSteps], [], hopCaller)).then(
          (result) =>
            materializeItxHandleReference(result, (expression) =>
              context.invoke(expression, [], hopCaller),
            ),
        );
      });
    },
    fetch: (request: Request) => deps.egress(request),
    rpcStubs: deps.rpcStubs,
    facets: deps.facets,
    subscriptions: deps.subscriptions,
    processors: {
      enable: async (name, spec) => {
        // Refused HERE, before anything is appended. A FIRST-PARTY name (first-party-facets.ts) hosts
        // this worker's own class: `consumes` at most, never a source; any other name's spec names
        // the source's host class, and its literal source is under the ceiling.
        const firstPartyClassName = firstPartyFacetClassOf(name);
        const loaded = spec as (FacetSpec & { consumes?: string[] }) | undefined;
        if (firstPartyClassName) {
          if (loaded && ("source" in loaded || "className" in loaded))
            throw new Error(
              `processors.enable(${JSON.stringify(name)}): "${name}" is first-party — hosted from this worker's own ${firstPartyClassName}; pass { consumes? } at most, never a source`,
            );
        } else {
          // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a caller-supplied spec (its static type is a claim, not a guarantee, across the capability boundary)
          if (typeof loaded !== "object" || loaded === null || typeof loaded.className !== "string")
            throw new Error(
              `processors.enable(${JSON.stringify(name)}, { source, className, consumes? }): name the host class the source exports — only a first-party name (${Object.keys(FIRST_PARTY_FACET_CLASSES).join(", ")}) is enabled without one`,
            );
          assertFacetSourceWithinCeiling(loaded, `processors.enable("${name}")`);
        }
        // IDEMPOTENT AT THE DOOR (the rule `provide` follows): a row already hosting this facet under
        // the same spec appends nothing — every entity's `create()` enables its row on every call.
        const existing = deps.subscriptions.get(name)?.hostedFacet;
        if (
          existing &&
          existing.name === name &&
          (firstPartyClassName
            ? existing.className === firstPartyClassName
            : existing.className === loaded!.className && existing.cacheKey === loaded!.cacheKey) &&
          jsonEqual(deps.subscriptions.get(name)?.consumes ?? null, spec?.consumes ?? null)
        )
          return { name };
        await append({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            name,
            target: [
              "itx",
              "builtins",
              "facets",
              firstPartyClassName ? ["get", name] : ["get", name, facetSpecOf(loaded!)],
              "processEventBatch",
            ],
            consumes: spec?.consumes,
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
      claim: async (name, at) => deps.claimFacetAlarm(name, at),
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
            platformOrigin: deps.platformOrigin(),
            itxEntrypoint: deps.itxEntrypoint(),
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
