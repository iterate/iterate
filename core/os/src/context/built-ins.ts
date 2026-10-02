// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (the one list
// is context/itx-expression-rewriting.ts). Three kinds of key, one record: the AXIOMS (the log, the stub
// registry, the rule table, the two hosts, addressing), the BINDINGS (`kv`, `secrets`, `ai`,
// `browser`, `cfArtifacts`, `repos` — a Cloudflare binding only this env holds, exposed or scoped) and THE
// LIBRARY (`connectTo*`, library.ts — code a user could write, taking only `itx`).
// THE RECORD IS `itx.builtins`, the reserved root: `itx.builtins.<root>…` runs against it directly
// and never reads the rule table; a short `itx.<root>…` reaches it through the IMPLICIT PLATFORM ROW
// unless the context's own table says otherwise (itx-expression-rewriting.ts `implicitRootsAt`) — so a
// test may shadow `itx.ai`, a context may mask `itx.kv`, and `itx.builtins.…` always reaches the
// physical scope.
// Dynamic code has two entry points, one per host kind: `workers.get(spec)` (stateless) and
// `facets.get(name, spec)` (durable) — the `BuiltInScope` members below say what each takes.

import { codedError, errorCode, jsonEqual, reportIssue, resolveContextPath } from "iterate/lib";
import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import {
  normalizedItxExpression,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionStep,
  InvokeHandle,
} from "iterate/expression";
import type {
  CollectSecretInput,
  CollectSecretLink,
  EveryProjectBorrows,
  FacetSpec,
  IterateContextApi,
  R2ObjectRecord,
  SecretRefresh,
} from "iterate/api";
import {
  ITERATE_ROUTING_SLUG_HEADER,
  projectPublicUrlOf,
  type IngressRouting,
} from "iterate/project-ingress";
import { missingScopes } from "iterate/integration-scopes";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "iterate/platform-retry";
import type { Cause } from "../cause.ts";
import { refusePlatformIdempotencyKeys, sha256Hex, stampCaller, type Caller } from "../caller.ts";
import { verifyOnBehalfOf } from "../on-behalf-of.ts";
import { sessionSigningSecretOf, type AppConfig } from "../app-config.ts";
import { Kept } from "../kept.ts";
import { facetStateOf } from "../context-stub.ts";
import { TARGET_FAILURE_CODES } from "../stream/subscription-delivery.ts";
import { FIRST_PARTY_FACET_CLASSES, firstPartyFacetClassOf } from "../first-party-facets.ts";
import {
  ScheduleKey,
  ScheduledAppendInput,
  ScheduleReceipt,
  type ScheduledAppend,
} from "../stream/scheduled-appends.ts";
import type { ReachableContext } from "../stream/stream.ts";
import type { LibraryRoots } from "../library.ts";
import { assertSecretPath, hmacSha256Hex, normalizeSecretRecord, originsOf } from "../secrets.ts";
import type { LendRevokedReason, SecretCatalog, SecretState } from "../secret/contract.ts";
import { EMAIL_PATH, emailDomainOf } from "../email/contract.ts";
import { deliverToPlatformHook } from "../platform-hook.ts";
import { IntegrationConnectionRow, IntegrationProvider } from "../integrations/contract.ts";
import {
  connectionPathOf,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type HeldToken,
} from "../integrations/connections.ts";
import { sendEmail } from "../integrations/email.ts";
import type {
  ConnectInput,
  FinishConnectAnswer,
  FinishConnectInput,
} from "../integrations/verbs.ts";
import type { ProjectState } from "../project/contract.ts";
import type { AccountState } from "../account/contract.ts";
import type { InstanceState } from "../instance/contract.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import {
  FetchRouteConfiguredPayload,
  matchFetchRoute,
  type FetchRouteTable,
} from "../fetch-routes.ts";
import { normalizeSecretOAuth } from "../secret-oauth.ts";
import { unavailableError } from "../unavailable.ts";
import { facetSpecOf, hostedFacetMarkerOf } from "../stream/core-processor.ts";
import { FacetHandle, RpcStubHandle, materializeItxHandleReference } from "./dispatch.ts";
import { signedFileUrl } from "./file-urls.ts";
import { SNAPSHOT_TTL_MS } from "./rule-snapshots.ts";
import { assertFacetPlacement, assertLoadedCodePlacement } from "./first-party-facet-placement.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  encodeFetchExpression,
  stampCallerHeaders,
  terminalFetchOf,
} from "./rpc-stubs.ts";
import { admitLoadedCodeRow, namesAWorker } from "./itx-expression-rewriting.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID, resourceScope } from "./paths.ts";
import {
  assertFacetSourceWithinCeiling,
  contentHashOfWorkerModules,
  isLoadedWorkerPlatformFailure,
  isWorkerModules,
  namedWorkerLoad,
  prepareConfinedWorker,
  type NamedWorker,
} from "./worker-loader.ts";
import type { BuiltInRoot } from "./itx-expression-rewriting.ts";
import { cfBrowser } from "./browser.ts";
import { projectScopedArtifacts, type ArtifactsNamespace } from "./cf-artifacts.ts";

/** What a lend's borrower path is told of its lender (`itx.secrets.acceptLend`): the lend, the
 *  person whose account a project uses (or the deployment itself, the operator's own secret), their
 *  secret's context and path, its pin, and the connection it is when it is one. */
export type BorrowedSecret = {
  lendId: string;
  lender: { userId: string; email?: string } | { instance: true };
  lenderContext: string;
  lenderPath: string;
  urls: string[];
  integration?: { provider: string; account: string; externalId: string };
};

/** THE PLATFORM'S OWN `itx.secrets` VERBS — deliberately NOT in the published `IterateContextApi`
 *  (iterate/api): the other halves of an OAuth connect and of a lend, which the platform's own hops
 *  call (`assertPlatformCaller`; `completeOAuth` is reached from the OAuth callback alone), and
 *  `revokeLend`'s platform-only options (a published `revokeLend(path, lendId)` is this one with
 *  them absent). */
type PlatformSecretsVerbs = {
  /** The platform's callback completes the attempt through here — the exchange in the secret's
   *  facet, then the facts, on the secret's path like `set` and `delete`. You never call this:
   *  the code and the nonce reach only the callback. */
  completeOAuth(
    path: string,
    input: { code: string; nonce: string },
  ): Promise<{ path: string; scopes: string[]; held?: HeldToken }>;
  /** The platform's move of a Slack workspace here (integrations/verbs.ts `confirmIntegrationMove`):
   *  the token its consent's exchange held aside (secret/durable-object.ts `admitHeldToken`) stored,
   *  then `secret/set`, like `completeOAuth`. You never call it. */
  admitHeldToken(path: string, input: { nonce: string }): Promise<{ path: string }>;
  /** The platform's, when that move failed: the held token dropped, or the record deleted while it
   *  is still the one the admit stored (`admitted`, with `secret/deleted`). You never call it. */
  dropHeldToken(path: string, input: { nonce: string }): Promise<"held" | "admitted" | "gone">;
  /** The platform's, from another secret's facet (secret/durable-object.ts `#clientSecretOf`) or a
   *  webhook's signature (`webhookSigningKey`): the client secret this secret holds, for a request
   *  to `origin`, which must be in this one's pin. A webhook's key signs for the whole project, so
   *  loaded code names one only at the project's root (itx-expression-rewriting.ts's app wall). You
   *  never call it: no value leaves a secret toward a caller. */
  clientSecretFor(path: string, input: { origin: string; field?: string }): Promise<string>;
  revokeLend(
    path: string,
    lendId: string,
    /** The platform's alone: why, and the borrower it must be lent to. */
    options?: { reason?: LendRevokedReason; borrower?: string },
  ): Promise<{ lendId: string }>;
  /** The platform's half of a lend on the borrower's path (`lend` calls it): you never call it. */
  acceptLend(path: string, input: BorrowedSecret): Promise<{ path: string }>;
  /** The platform's, on the global root: a new project borrows every lend to every project
   *  (session.ts `projects.create`). You never call it. */
  borrowEveryProjectLends(projectId: string): Promise<EveryProjectBorrows>;
  /** The platform's, on the deployment's secret: its lend to every project borrowed into one more
   *  project (`borrowEveryProjectLends`). You never call it. */
  lendToProject(
    path: string,
    lendId: string,
    projectId: string,
  ): Promise<"borrowed" | "kept" | "revoked">;
  /** The platform's half of a revocation on the borrower's path: you never call it. */
  dropLend(path: string, input: { lendId: string; reason: LendRevokedReason }): Promise<void>;
  /** The platform's, on a person's own connection's secret: that account connected to a project
   *  they are a member of — `itx.integrations.connect(provider, { account })` on the project, or
   *  the consent that needed (integrations/verbs.ts). The project's path of the same name holds only
   *  a lend of it, and `<provider>/connected { ownerUserId, ownerEmail }` lands on the project's root.
   *  Again for an account already connected there refreshes its row. You never call it. */
  connectToProject(
    path: string,
    input: {
      projectId: string;
      connection: IntegrationConnectionRow;
      /** The person's verified address, which the project's row shows as whose it is. */
      ownerEmail?: string;
      /** Connect only if the project still has this account (a consent begun for one it had). */
      onlyIfConnected?: boolean;
    },
  ): Promise<{ connection: string }>;
};

/** THE PLATFORM'S OWN `itx.integrations` VERBS — not published, the platform's hops alone
 *  (`assertPlatformCaller`): a person's connect a project asked for, on the person's own root, the
 *  OAuth callback's finish, on the owner's root, and `disconnect`'s platform-only option (a published
 *  `disconnect(provider, connection)` is this one with it absent). */
type PlatformIntegrationsVerbs = {
  connectForProject(
    input: ConnectInput & { connectToProject: NonNullable<ConnectionAttempt["connectToProject"]> },
  ): Promise<{ authorizationUrl: string }>;
  finishConnect(input: FinishConnectInput): Promise<FinishConnectAnswer>;
  disconnect(
    provider: IntegrationProvider,
    connection: string,
    /** The platform's alone: a move's cleanup of the connection that held the account
     *  (integrations/verbs.ts `confirmIntegrationMove`), done only while it still names it. */
    options?: { movedExternalId?: string },
  ): Promise<void>;
};

/** THE built-in scope, as one interface — the platform's kernel surface; the library's verbs
 *  come in by `extends` (library.ts). The record is a PLAIN OBJECT of own-enumerable closures,
 *  not an RpcTarget class, on purpose: the resolver gates on `Object.hasOwn`, so a prototype-method
 *  class would leave every root unreachable. Exported for ONE reader: the edge `IterateContextRpcTarget`'s TYPE
 *  merges it in (iterate-context.ts), so what rides the dotted hop is typed where a client holds it.
 *
 *  EVERY ROOT'S SHAPE IS THE PUBLISHED ONE (iterate/api `IterateContextApi[root]`), never declared
 *  here: the docstrings below say how the platform implements each, the types say nothing new. So
 *  the record's `satisfies` (below) checks the implementation against what apps are promised, and
 *  the edge class's `implements IterateContextApi` (iterate-context.ts) checks what this interface
 *  narrows. DELIBERATELY PLATFORM-ONLY — not reachable by app code, so not published:
 *   - `builtins`, the fixed point (the app wall refuses it to loaded code);
 *   - `cd` answering a handle on this side of the hop (the edge's `cd` is the published one);
 *   - the secrets verbs of `PlatformSecretsVerbs` (a lend's and an OAuth connect's other halves);
 *   - the brands `FacetHandle` / `RpcStubHandle` the physical `facets.get` / `rpcStubs.get`
 *     answer (the delivery loop reads them), where the published type says `InvokeHandle`;
 *   - `whoami` always a promise here (the published type also admits a fake's plain value). */
export interface BuiltInScope extends LibraryRoots {
  /** THE RESERVED ROOT, typed: the physical spelling of every root below. Not a key of the record
   *  (the resolver strips it); here so a strongly typed holder (the scope a loaded worker's
   *  `getItx()` hands it) can spell `itx.builtins.append(…)`. */
  builtins: Omit<BuiltInScope, "builtins">;
  /** Identify this context. A project's `projectUrl` is its apex, `url()`'s answer (on the primary
   *  hostname when it has one), present when the call carries the platform origin. */
  whoami(): Promise<Awaited<ReturnType<IterateContextApi["whoami"]>>>;
  /** THE PUBLIC URL of this project over HTTP — the apex or a `routingSlug`'s host (both reach the
   *  config worker's `fetch`, which reads the slug from `x-iterate-routing-slug`), at `path`
   *  (default "/") — on the project's primary hostname when it has one (`<routingSlug>.<primary>/…`,
   *  the project row the control plane keeps, up to five seconds old: control-plane/edge.ts
   *  `KEPT_MS`), else composed from the deployment's ingress routing (iterate/project-ingress:
   *  `<routingSlug>--<slug>.<hostname>/…` under subdomains, `<origin>/projects/<slug>/<routingSlug>/…`
   *  under paths). Refused on a deployment with no project ingress, and on a call carrying no
   *  platform origin (a processor's own turn, a loaded worker: hold the URL a session handed you
   *  instead). Only a project's context has one. */
  url: IterateContextApi["url"];
  /** Durable key/value prefixed with the RESOURCE OWNER's id (iterate-context.ts `resourceScope`:
   *  a project's id, or a global user's/organization's subtree) — the `${owner.id}:` prefix IS the
   *  isolation. */
  kv: IterateContextApi["kv"];
  /** THE OBJECT STORE: the R2 bucket binding, verbatim, on the resource owner's slice of ONE bucket
   *  (`FILES`) — every key prefixed `<owner.id>/` as kv's are `<owner.id>:`, the prefix applied to
   *  every key and `prefix`/`startAfter` option and stripped from every key and prefix answered.
   *  The binding's own verbs, arguments and pagination (`list` is ONE page, with its cursor); what
   *  cannot cross the wire is answered as data — an `R2Object` as its fields, a body as its bytes.
   *  `presign` is the one verb the binding lacks: a signed URL on the project host (file-urls.ts),
   *  a download or an upload, the platform serving the bytes itself — R2's own presigned URLs need
   *  S3 credentials this worker does not hold. Multipart uploads are not here yet. */
  r2: IterateContextApi["r2"];
  /** THE SECRETS (src/secret/): a secret as a DOMAIN OBJECT — the context at `/secrets/<name>`
   *  under the resource owner's root (a project's; a global user's or organization's own — never a
   *  catalog shared across users), whose `secret` facet is the material's one keeper. A secret IS
   *  its path, and the path is what the placeholder spells: `getSecret("/secrets/<name>")` in an
   *  outbound request's URL (path or query) or headers substitutes to the value at egress
   *  (`fetch`), and `getSecret("/secrets/<name>", { field: "a.b" })` to one string field of a JSON
   *  material — the placeholder grammar for a URL or a header (not `Basic
   *  base64(user:getSecret(…))` peeling nor its JSON-body template — the body is never scanned).
   *  The material is a string or a JSON object; `urls` (required) pins it to those ORIGINS only — a
   *  mis-typed URL cannot mail a credential to a stranger, nor can an app that forwards a visitor's
   *  headers; `refresh` names the strategy the facet re-mints an expired credential with, in trusted
   *  code, on a 401 or on first use (`oauth-refresh-token`, `github-app-installation`, or the secret's own exchange code in a jail, `worker`). WRITE-ONLY — `set`,
   *  `beginOAuth`, `delete`, and a `list` of paths, pins and strategy kinds, never a value. Every
   *  verb runs ON THE SECRET'S PATH (so the log's order is the value's) and lands its fact there —
   *  `secret/set { path, urls, refresh? }`, `secret/deleted { path }` — attributed like any append
   *  (`source.principal`), and cross-posts it to the owner's root, whose catalog `list()` reads; the
   *  value never enters a log. The facet's own facts: `secret/used` per dispatch, `secret/refreshed`
   *  per refresh outcome. The secret's state (whether material is stored, by the offset of the fact
   *  that says so) is `itx.cd(path).facets.get("secret").snapshot()`. `set`'s `merge` lays the
   *  material's fields over the stored ones; `beginOAuth` hands back the provider's authorize URL
   *  (secret-oauth.ts); `verifyHmac` checks a webhook's signature in the secret's facet, one bit
   *  back; `lend` / `revokeLend` lend the deployment's own secret (the operator's) to projects. */
  secrets: Omit<IterateContextApi["secrets"], "revokeLend"> & PlatformSecretsVerbs;
  /** THE INTEGRATIONS (src/integrations/), the one way a caller connects and disconnects this
   *  context's owner — a project's root, or a person's own context (`session.user`). `connect` and
   *  `disconnect` run on the owner's root, whose facet (`project` or `account`) holds the
   *  connections: there they call the facet's own methods, which it does not publish; on any other
   *  context they are the same call on the root. On a project, `connect(provider, { account })`
   *  connects one of the CALLER's own accounts instead (the address `session.user`'s
   *  `state.integrations` names): at once when it holds the scopes the project asks for, else after
   *  a consent on the caller's own connection that adds them. `requestFromUser(provider, { scopes })`
   *  answers a Dash link that asks the signed-in person to connect the provider to this project, for
   *  an agent or the CLI. */
  integrations: Omit<IterateContextApi["integrations"], "disconnect"> & PlatformIntegrationsVerbs;
  /** THE FETCH ROUTES (src/fetch-routes.ts): named rules on the project's root `/` mapping a
   *  request on the project's hosts to an itx expression, the route's `target` — `iterate tunnel`'s
   *  lent stub, a facet, a loaded worker. `set(name, route)` validates the route and appends
   *  `itx/fetch-route-configured` on `/` (`null` deletes it; the same route again appends nothing);
   *  `list()` is the table; `match({ url, headers })` the first route whose matcher holds — by
   *  priority, highest first, then by name — or null (`routingSlug` against the edge's
   *  `x-iterate-routing-slug`, `url` a `URLPattern` against the URL the app sees, `headers` exact).
   *  The edge matches every request on the project's hosts against the root's snapshot of the
   *  table, enforces `authRequirement` and serves a match from `route.target`, before the config
   *  worker's fetch (worker.ts `serveProjectHost`). Only on a project's root. */
  fetchRoutes: IterateContextApi["fetchRoutes"];
  /** THE FIRST BINDINGS ROOT: Workers AI's `run(model, inputs, options?)` and `models()`, through
   *  the stateless `ItxAi` entrypoint (itx-ai.ts), so a rewrite rule can pin a model with `@`
   *  (`itx.fable ⇒ itx.ai.run('@cf/…', @)`). A test shadows it with `provide("itx.ai", fake)`; the
   *  platform's stays `itx.builtins.ai`. */
  ai: IterateContextApi["ai"];
  /** Cloudflare Browser Run: `.quickAction(action, options)` returns the
   *  action's RESULT; `.fetch(input, init)` is the raw CDP endpoint. */
  browser: IterateContextApi["browser"];
  /** THE ARTIFACTS PROXY (cf-artifacts.ts `projectScopedArtifacts`): Cloudflare Artifacts, project-scoped and
   *  addressed BY THE REPO'S PATH — the binding's own verbs only: `create`, `get` (a handle with
   *  `createToken` and `remote()`), `list`, `delete`. Git itself is the repo facet's (src/repo/, the
   *  domain object `itx.repos.get(path)` — THE way a project touches its repos): it mints its token and
   *  learns its remote here, then speaks git-over-HTTPS from inside its own worker. */
  cfArtifacts: IterateContextApi["cfArtifacts"];
  /** The project's mail: email/contract.ts for its address, integrations/email.ts for sending. */
  email: IterateContextApi["email"];
  /** Append to this context's append-only event log (the facets that REDUCE it are
   *  `itx.facets.get(name)`). A top-level root, so the expression surface mirrors the edge
   *  RpcTarget exactly: `itx.append({...})` is one spelling on every hop. */
  append: IterateContextApi["append"];
  /** RESET THIS CONTEXT — Cloudflare's `ctx.abort`, asked for: the Durable Object's in-memory state
   *  is discarded and the next call builds a fresh incarnation from durable storage (a new
   *  `itx/woken`). The FACT comes first — `itx/aborted { reason?, callerPath?, app? }`,
   *  attributed like any append (`source.principal`) and durable before anything resets — then the
   *  answer (that event), then the reset, once the answer left, whatever else is writing here
   *  (iterate-context-durable-object.ts `#abortAfterTheAnswer`). SURVIVES: the log and everything
   *  reduced from it (rewrite rules, subscriptions, schedules), the facets' own storage, kv, an
   *  armed alarm. GOES: in-memory state, every facet instance and its in-flight work, every socket
   *  (a lender's pager re-dials), every borrowed stub, and every call still in flight here — it
   *  rejects with the reset's message. A handle a holder kept is the expression that names it
   *  (dispatch.ts `itxAnswerDetachedFromSession`), so its next call reaches the fresh
   *  incarnation. A context root, so it resets the context it is spelled at; another context of
   *  the project is `itx.cd(path).abort()`. */
  abort: IterateContextApi["abort"];
  /** Durable batches appended after a deadline or on a fixed interval (missed ticks coalesce). Setting a key
   *  replaces it; cancelling cannot retract an occurrence already committed. Pause holds work
   *  until resume; set is refused while paused, while cancel remains available. Failure remains
   *  visible until replacement or cancellation. */
  schedules: IterateContextApi["schedules"];
  /** Read a page of the durable log — `itx.readEvents(afterOffset?, limit?)`, the twin of `append`
   *  (non-minting: a probe never wakes storage). `{ includeEphemeral: true }` merges in the
   *  ephemerals this incarnation still holds (stream.ts, the recent-ephemerals ring). */
  readEvents: IterateContextApi["readEvents"];
  /** Wait for the next event matching `filter` (Stream.waitForEvent owns the contract: type filter,
   *  afterOffset default = the head, 30s/120s timeout → WAIT_TIMEOUT). A root, so the edge declares
   *  nothing for it. */
  waitForEvent: IterateContextApi["waitForEvent"];
  /** Another context of THIS project, every call routed through ITS table (`resolveContextPath`
   *  resolves the path, as the edge `cd` does). */
  cd(path: string): InvokeHandle;
  /** Egress: `getSecret("/secrets/NAME")` placeholders substituted, then the terminal `fetch` — where
   *  a loaded worker's `globalOutbound` and the edge `itx.fetch(request)` land too. */
  fetch: IterateContextApi["fetch"];
  /** The rpc-stub REGISTRY — physical, never event-sourced: a client's live capnweb value lent under
   *  an OPAQUE key by its session (relay-side, DON'T-PIN — the edge owns it, this side borrows).
   *  `get(rpcStubKey)` is how a REWRITE RULE names one: `itx.provide(match, stub)` lends the stub
   *  under the key = the canonical match and configures the pure-data rule `match ⇒
   *  itx.builtins.rpcStubs.get('<match>')`. */
  rpcStubs: Omit<IterateContextApi["rpcStubs"], "get"> & {
    /** One stub by key: a pipelinable handle over its transport (borrowed, or paged then borrowed).
     *  Deep dots walk; a root call reaches the bare lent callable; offline ⇒ RPC_STUB_OFFLINE at call
     *  time. Branded `RpcStubHandle`: the subscription delivery loop reads the brand to know the
     *  callee owns its own progress. */
    get(rpcStubKey: string): RpcStubHandle;
  };
  /** The rewrite-rule table, read — THE EFFECTIVE table: the context's own rows (`origin:
   *  "context"`, a mask shown as `target: null`) plus the implicit platform rows (`origin:
   *  "platform"`) for every root the context has not re-set. Written by `itx.provide` on the edge,
   *  never a verb here. `resolve(call)` is the PURE half of `invoke`: the chain of rewrites, each
   *  printed, nothing dispatched — `invoke(call) ≡ invoke(resolve(call).at(-1))`. */
  rewriteRules: IterateContextApi["rewriteRules"];
  /** The facets of this context. `get(name)` ADDRESSES one that is already running (a processor, a
   *  named instance) — no source; `get(name, { source, cacheKey?, className })` LOADS the class and
   *  hosts it as the durable facet `name` (own storage) — the mirror of Cloudflare's
   *  `ctx.facets.get(name, startupCallback)`; `source`/`cacheKey` as for `workers.get` (a new key
   *  restarts the facet, its storage surviving). A facet leaves with the subscription that hosted it
   *  (`subscription-configured { name, target: null }`) — there is no delete verb. A caller reaches
   *  only what the facet's class lists in `static publicMethods` (context/facet-public-methods.ts);
   *  anything else is refused FORBIDDEN. `abort(name)` is `ctx.facets.abort(name)` from the HOST
   *  (facet-host.ts `abort`), so it resets any facet, one that would never answer a call included,
   *  and starts it again from its startup memo before it answers. */
  facets: Omit<IterateContextApi["facets"], "get"> & {
    /** The physical host's handle, branded (the published `get<Facet>` is the caller's assertion
     *  over it). */
    get(name: string, spec?: FacetSpec): FacetHandle;
  };
  /** The subscriptions layer, read: the table (a slice of core) joined with the stream-kept
   *  cursors. Read-only — `subscribe` lives on the edge as sugar over the `subscription-configured`
   *  event, never a verb here. */
  subscriptions: IterateContextApi["subscriptions"];
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
   *  so loaded code (`using itx = this.getItx(); await itx.processors.enable(…)`) and a sibling
   *  (`itx.cd(p).processors…`) do it through the same built-in as a client. A hosted processor's
   *  `claim(name, at)` is its claim on this context's alarm — "revive me by `at`" while a
   *  `runInBackground` attempt is in flight, `null` to release — durable as a kv row, never an event. */
  processors: IterateContextApi["processors"];
  /** The stateless host: `get({ source, cacheKey?, className?, props? })` → a `WorkerEntrypoint` in
   *  its own confined isolate (no DO, no storage) — ANY method it exports, reached by name (`run`,
   *  `fetch`, `processEventBatch`, …). `source` is the worker's FILES, literally (`{ "package.json":
   *  '{"main":"worker.js"}', "worker.js": code, … }`, its entry as module-resolution.ts `readPackage` finds it), OR an itx EXPRESSION that produces them under `cacheKey` — the producer runs
   *  only when no isolate is warm under it and its answer is not kept (a day, per deploy;
   *  worker-loader.ts: Cloudflare's `get(id, getCode)` contract; the caller owns "same key ⇒ same code"),
   *  OR, an expression with no `cacheKey`, the NAME of another worker, whose code it loads
   *  (`namedWorkerLoad`: `mainModule` by its published identity). `className` names the exported class (default:
   *  the default export); `props` is Cloudflare's own WorkerStubEntrypointOptions.props, read back as
   *  `this.ctx.props` (a url, a key name, …). No name and no `list`: a stateless worker is its spec. */
  workers: IterateContextApi["workers"];
  /** THE PLATFORM HOOK (platform-hook.ts): the platform's own subscriber, that a deployment's birth
   *  events point a fan-out row at (`itx.builtins.platformHook.deliverEvent`). `deliverEvent`
   *  answers the delivery loop alone (`assertDeliveryCaller`) and hands each event to the platform's
   *  code with the bindings every built-in holds. Not in the published API: no one else calls it. */
  platformHook: { deliverEvent(event: StreamEvent): Promise<void> };
  /** HTTP WEBHOOKS (`webhooks.get({ url, signingSecret? })`): a fan-out row's target that POSTs each
   *  event through THIS context's own `itx.fetch`, signed with a secret the row names.
   *  The signing key is read from the secret's context at most once per SNAPSHOT_TTL_MS per spec,
   *  never once per event. A context root: a row delivers from where its events happen. */
  webhooks: IterateContextApi["webhooks"];
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

// THE PUBLISHED LIST: every built-in root but the platform's own hook is a root of iterate/api's
// `IterateContextApi`, and every root declared there is a built-in but the edge's own verbs
// (iterate-context.ts `invoke`, `subscribe`, `provide`) — a root published and never implemented, or
// implemented and never published, fails to typecheck right here.
type EdgeOnlyRoot = "invoke" | "subscribe" | "provide";
type PublishedRoot = Exclude<BuiltInRoot, "platformHook">;
type RootsArePublished = [PublishedRoot] extends [Exclude<keyof IterateContextApi, EdgeOnlyRoot>]
  ? [Exclude<keyof IterateContextApi, EdgeOnlyRoot>] extends [PublishedRoot]
    ? true
    : never
  : never;
const _rootsArePublished: RootsArePublished = true;
void _rootsArePublished;

/** `integrations.connect`'s options (iterate/api `IterateContextApi["integrations"]`): one of the
 *  caller's own accounts, or a connection of the owner's through iterate's app or its own. */
const IntegrationConnectOptions = z
  .object({
    scopes: z.array(z.string().min(1)).optional(),
    next: z.string().optional(),
    connection: z.string().optional(),
    account: z.string().min(1).optional(),
    client: z.enum(["iterate", "project"]).default("iterate"),
    appSlug: z.string().optional(),
    clientId: z.string().optional(),
    installationId: z.string().optional(),
  })
  .refine(
    (picked) =>
      !picked.account ||
      (!picked.connection &&
        picked.client === "iterate" &&
        !picked.appSlug &&
        !picked.clientId &&
        !picked.installationId),
    { message: "account (one of yours) takes only scopes and next" },
  )
  .refine((picked) => picked.client === "iterate" || picked.connection, {
    message: 'client "project" connects the app in /secrets/<provider>-<connection>: name it',
  });

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

/** A reset's reason (`abort`, `facets.abort`): absent, or one line a person reads — it lands in the
 *  fact and in the message every call the reset cuts off rejects with. */
function abortReasonOf(reason: unknown, verb: string): string | undefined {
  const parsed = z.string().max(1000).optional().safeParse(reason);
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      `${verb}(reason?): a reason is a string of at most 1000 chars`,
    );
  return parsed.data;
}

/** A webhook's spec (`webhooks.get`): where it POSTs, over http(s), and the secret that signs it. */
const WebhookSpec = z.strictObject({
  url: z.url({ protocol: /^https?$/, error: "a webhook's url is an http(s) URL" }),
  signingSecret: z.string().transform(assertSecretPath).optional(),
});

/** How long one webhook POST may take: under the delivery watchdog (20 s), so the request is
 *  cancelled — and its delivery settles — before the watchdog gives up on it. */
const WEBHOOK_TIMEOUT_MS = 15_000;

/** `deliverEvent` is the delivery loop's own call, for the one event it carries (caller.ts
 *  `Caller.delivery`, the SHA-256 of `eventJson`, as the call being made carries it): anyone else —
 *  loaded code spelling `itx.cd('/').x.deliverEvent(forged)`, a session, a rule or a bound argument
 *  inside the delivery's own call — could hand a subscriber an event no log holds. */
async function assertDeliveryCaller(
  delivery: string | undefined,
  what: string,
  eventJson: string,
): Promise<void> {
  if (!delivery || delivery !== (await sha256Hex(eventJson)))
    throw codedError("FORBIDDEN", `${what} is the delivery loop's own call`);
}

/** What the CONTEXT (the DO) injects: identity, the bindings, and the operations only it can serve. */
export interface BuildBuiltInsDeps {
  projectInfo: () => Promise<{ projectSlug?: string }>;
  /** This project's primary hostname (project/contract.ts `primaryHostname`), or null. */
  primaryHostname: () => Promise<string | null>;
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys). */
  iterateContextName: string;
  /** `ItxAi` for this context's project (itx-ai.ts `itxAiFor`): the built-in root `itx.ai`. */
  ai: IterateContextApi["ai"];
  /** The bindings the built-ins reach (the workers test project binds neither Browser Run nor Artifacts;
   *  nothing there calls them). */
  env: {
    LOADER: WorkerLoader;
    ITX_KV: KVNamespace;
    /** The one R2 bucket, every owner's objects under its own prefix — the built-in root `itx.r2`. */
    FILES: R2Bucket;
    BROWSER: BrowserRun;
    ARTIFACTS: ArtifactsNamespace;
    DB: D1Database;
    /** Email Sending — `itx.email`; absent where a deployment has no mailbox. */
    EMAIL?: SendEmail;
  };
  /** The deploy identity every loader cacheKey folds in (worker.ts `AppConfig`). */
  deployId: string;
  /** How projects are reached over HTTP (app-config.ts `urls.ingressRouting`) — `itx.url`. */
  ingressRouting: IngressRouting;
  /** The domain one project owns outright (app-config.ts `urls.projectWildcard`: iterate.com, the
   *  `iterate` project's): that project may send from any address on it (`itx.email.send`). */
  projectWildcard: { hostname: string; project: string } | undefined;
  /** The Dash that this platform instance names for human administration. */
  dashOrigin: string;
  /** The deployment's platform admins (app-config.ts `admins`): with the admin bearer, the
   *  operator of the deployment's own secrets. */
  platformAdmins: () => readonly string[];
  /** What iterate's app asks for, by provider (app-config.ts `iterateAppScopesOf`): what a project
   *  needs of a person's account it connects. */
  iterateAppScopes: () => Partial<Record<IntegrationProvider, readonly string[]>>;
  /** THE PLATFORM ORIGIN the current call's caller reached the platform on (the DO's caller record)
   *  — null when the call carries none: a processor's own turn, a loaded worker's `env.ITX`, the
   *  delivery loop, an alarm. */
  platformOrigin: () => string | null;
  /** The key the platform signs its own tokens with (app-config.ts `sessionSigningSecretOf`): a
   *  file URL (`itx.r2.presign`), and who a script runs for (on-behalf-of.ts). */
  signingSecret: () => Promise<string>;
  /** Evaluate a producer source expression through THIS context's dispatch (inside the loader's
   *  `getCode`, so only on a cold isolate). */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** The worker a source expression with no cacheKey names, resolved from this context (the DO's
   *  `#namedWorker`): what `workers.get` of such a source loads. */
  namedWorker: (source: ItxExpressionInput) => Promise<NamedWorker>;
  /** A context stream by CANONICAL path — the own-path parent adapter same-isolate, by-name DO
   *  stubs otherwise. Both satisfy ReachableContext (uniform-async, real-typed — see stream/stream.ts). */
  context: (path: string) => ReachableContext;
  /** Another OWNER's context by its Durable Object name — a lend's other side, which crosses from a
   *  person's namespace to a project's. The platform's verbs alone spell one. */
  otherOwnerContext: (name: string) => Pick<ReachableContext, "invoke">;
  /** The context's egress terminal (secret substitution → `fetch`). */
  egress: (request: Request) => Promise<Response>;
  /** WHO is calling right now — the `Caller` the DO runs this call under (an `x-itx-expression` fetch's headers,
   *  or the edge's stamp), `{ principal: null }` for an anonymous session, a processor, a loaded
   *  worker and the KERNEL's own delivery loop. Carried across permitted sibling `cd` hops. */
  caller: () => Caller;
  /** `call` through this context's own resolver under `caller` — a `cd` handle's way on. */
  invokeAs: (caller: Caller, call: ItxExpression) => Promise<unknown>;
  /** The rpcStubs view — closures over the DO's transport table (the pager sockets can never move). */
  rpcStubs: BuiltInScope["rpcStubs"];
  subscriptions: BuiltInScope["subscriptions"];
  schedules: {
    get(key: string): ScheduledAppend | null;
    list(): ScheduledAppend[];
  };
  rewriteRules: BuiltInScope["rewriteRules"];
  /** The route table in this context's core state (stream/core-processor.ts `fetchRoutes`) —
   *  `itx.fetchRoutes` reads it on a project's root. */
  fetchRoutes: () => FetchRouteTable;
  /** The own context's — a wait never crosses a hop. */
  waitForEvent: BuiltInScope["waitForEvent"];
  /** The facet host's entry, verbatim (accepted trade: a busy stateful facet pins its stream), and the
   *  host's reset of one facet, started again before it answers (facet-host.ts `abort`). */
  facets: {
    get: BuiltInScope["facets"]["get"];
    abort(name: string, reason: string | undefined): Promise<void>;
  };
  /** The platform's own call into a facet of this context, past the methods its class lists for
   *  callers (context/facet-host.ts `callFacetAsPlatform`): the `itx.secrets` verbs' way to the
   *  `secret` facet. */
  callFacetAsPlatform: (name: string, itxExpressionSteps: ItxExpression) => Promise<unknown>;
  /** THE CONTEXT'S RESET, once the call that asked for it has its answer (the DO's
   *  `#abortAfterTheAnswer`): asked for here, run after the answer left. */
  abortAfterTheAnswer: (message: string) => void;
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
  const ownContext = () => deps.context(path);
  /** THE append: every event appended through this scope carries WHO appended it and FROM WHERE —
   *  the DO's own stamp, never a client's (src/caller.ts `stampCaller`): the context the call started
   *  at, and the session's verified principal, or none. */
  const append = async (...events: StreamEventInput[]) => {
    const caller = deps.caller();
    // Loaded code's rows are walled as they resolve here; the append boundary validates the rest.
    if (caller.app) for (const event of events) admitLoadedCodeRow(event, path);
    refusePlatformIdempotencyKeys(events, caller, projectId === GLOBAL_PROJECT_ID);
    // STABLE RETRY EFFECTS (cause.ts): during a delivery, an event without a key of its own is keyed
    // by the delivery, where it lands and what it is — the same on every attempt
    const writeKey = caller.cause?.writeKey;
    const keyed = await Promise.all(
      events.map(async (event) =>
        writeKey && !event.idempotencyKey
          ? {
              ...event,
              idempotencyKey: `${writeKey}:append:${path}:${(await sha256Hex(JSON.stringify(event))).slice(0, 16)}`,
            }
          : event,
      ),
    );
    // who a script runs for, from its cause's signed token (on-behalf-of.ts): nobody's when forged
    const onBehalfOf = await verifyOnBehalfOf(
      caller.cause?.onBehalfOf,
      projectId,
      await deps.signingSecret(),
      Date.now(),
    );
    return ownContext().append(
      ...keyed.map((event) => stampCaller(event, { ...caller, onBehalfOf }, path)),
    );
  };
  /** THE PLATFORM'S OWN HOP: the caller rides — principal and grant (the facts stay attributed),
   *  path and origin — but never its `app`: the app wall (itx-expression-rewriting.ts `#admit`) is
   *  for what LOADED CODE spells on its input, and the expressions below are the platform's, fixed
   *  here, their arguments validated here. A script's `itx.secrets.set(…)` reaches this built-in
   *  through its creator's link and is answered exactly as a session's would be. */
  const hopCaller = (): Caller => {
    const { app: _loadedCode, ...caller } = deps.caller();
    return caller;
  };
  /** Secrets are the RESOURCE OWNER's, and a secret IS its path under the owner's root
   *  (`owner.rootPath`: a project's `/`, a user's `/users/<id>` — `resolveContextPath` joins
   *  `/secrets/<name>` onto it). Each writing verb runs `here` on the SECRET'S OWN context — where
   *  the `secret` facet keeps the value, so the log's order is the value's — and on any other
   *  context runs as the same call there, over the DO hop, the caller carried (the fact stays
   *  attributed). The catalog is the owner root's facet (`ownerRootFacet`). */
  const onSecretContext = <T>(
    secretPath: string,
    call: ItxExpressionStep,
    here: (secret: ReachableContext) => Promise<T>,
  ): Promise<T> => {
    assertOperatorOfGlobalSecrets();
    const contextPath = resolveContextPath(owner.rootPath, `.${assertSecretPath(secretPath)}`);
    return path === contextPath
      ? here(ownContext())
      : // The secret's context runs the SAME verb `here` would run (the one built-in, the same
        // arguments), so its answer has `here`'s type; `invoke` is untyped across the DO hop. The
        // context is acquired PER CALL: a stub cached across calls stays broken after a DO failure
        // (Cloudflare's DO error handling requires re-acquiring). `hopCaller()` keeps the change
        // attributed to the authenticated principal.
        (deps
          .context(contextPath)
          .invoke(["itx", "builtins", "secrets", call], [], hopCaller()) as Promise<T>);
  };
  /** THE DEPLOYMENT'S OWN SECRETS (`global:/secrets/<name>`, the global root's) are the
   *  operator's: the admin bearer (actor `admin`, no email) or a platform admin (app-config.ts
   *  `admins`, not viewing an app as someone else), whose `admin` scope is what opened the global
   *  root to them (session.ts `global`) — and the platform's own hops (a lend's other side). */
  const assertOperatorOfGlobalSecrets = () => {
    if (owner.kind !== "global") return;
    const { principal, platform } = deps.caller();
    if (platform) return;
    const email = principal?.email?.trim().toLowerCase();
    const operator = principal?.actor === "admin" && !email;
    const admin = email && !principal?.impersonatedBy && deps.platformAdmins().includes(email);
    if (!operator && !admin)
      throw codedError(
        "FORBIDDEN",
        "itx.secrets: the deployment's own secrets (global:/secrets/<name>) are the operator's — the admin bearer or a platform admin",
      );
  };
  /** The owner root's facet — where the catalog is folded from the certificates cross-posted there
   *  (src/project/contract.ts; src/account/contract.ts, src/organization/contract.ts and
   *  src/instance/contract.ts for the global owners). */
  const ownerRootFacet = (): "project" | "account" | "organization" | "instance" => {
    if (owner.kind === "project") return "project";
    if (owner.kind === "users") return "account";
    if (owner.kind === "organizations") return "organization";
    assertOperatorOfGlobalSecrets();
    return "instance";
  };
  /** The facet that holds this context's owner's connections (src/integrations/verbs.ts): a
   *  project's `project`, a person's `account`. */
  const integrationsFacet = (verb: string): "project" | "account" => {
    if (projectId !== GLOBAL_PROJECT_ID) return "project";
    if (owner.kind === "users") return "account";
    throw codedError(
      "INVALID_CONTEXT",
      `itx.integrations.${verb}: a project's context or a person's own (session.user) holds connections`,
    );
  };
  /** A caller's `integrations.connect` and `disconnect` run `here` on the owner's root, over the
   *  owner's facet, which publishes neither method; on any other context each is the same call on
   *  the root, the caller carried (`hopCaller()`). */
  const onIntegrationsRoot = <T>(
    verb: "connect" | "disconnect",
    args: unknown[],
    here: (facet: "project" | "account") => Promise<T>,
  ): Promise<T> => {
    const facet = integrationsFacet(verb);
    if (path === owner.rootPath) return here(facet);
    // The root runs the same verb `here` would run, so its answer has `here`'s type; `invoke` is
    // untyped across the DO hop.
    return deps
      .context(owner.rootPath)
      .invoke(["itx", "builtins", "integrations", [verb, ...args]], [], hopCaller()) as Promise<T>;
  };
  /** Another project's root, for the other side of a lend. */
  const projectRoot = (id: string) =>
    deps.otherOwnerContext(DurableObjectNameCodec.stringify({ projectId: id, path: "/" }));
  /** A PROJECT'S CONNECT OF THE CALLER'S OWN ACCOUNT (`integrations.connect(provider, { account })`
   *  on a project's context): the person themselves alone — their own grant holding the `account`
   *  scope (caller.ts `Caller.account`), never a grant bound to projects, an admin signed in as
   *  them, the admin secret or loaded code — and the account picked from their own connections, by
   *  the address the provider gives it. Holding the scopes the project asks for (iterate's app's,
   *  plus `scopes`), it is connected at once (`connectToProject` on the person's secret); else the
   *  person's own connection asks the provider for them (an incremental consent, the same account)
   *  and the callback connects it to this project. */
  const connectCallersAccount = async (
    provider: IntegrationProvider,
    input: { account: string; scopes?: string[]; next?: string },
  ): Promise<{ authorizationUrl?: string; connection: string }> => {
    if (owner.kind !== "project")
      throw codedError(
        "INVALID_CONTEXT",
        "itx.integrations.connect: an account of yours is connected to a project, on the project's context",
      );
    const caller = deps.caller();
    const principal = caller.principal;
    if (!principal?.email || !caller.account || caller.app || principal.impersonatedBy)
      throw codedError(
        "FORBIDDEN",
        "itx.integrations.connect: only the person themselves, signed in with access to their account, connects an account of theirs",
      );
    const person = deps.otherOwnerContext(
      DurableObjectNameCodec.stringify({
        projectId: GLOBAL_PROJECT_ID,
        path: `/users/${principal.actor}`,
      }),
    );
    const state = await facetStateOf<AccountState>(person, "account", hopCaller());
    const accounts = Object.values(state.integrations).filter(
      (row) => row.provider === provider && row.account === input.account,
    );
    if (accounts.length !== 1)
      throw codedError(
        "INVALID_INPUT",
        accounts.length === 0
          ? `itx.integrations.connect: you have no ${provider} account ${input.account} — sign in with it, or connect another account`
          : `itx.integrations.connect: you have ${accounts.length} ${provider} accounts named ${input.account}`,
      );
    const account = accounts[0]!;
    // Google's, Cloudflare's and X's consents add scopes to a person's own connection; a GitHub
    // user's token has none to add, so it connects as it is.
    const requiredScopes =
      provider === "google" || provider === "cloudflare" || provider === "x"
        ? [...(deps.iterateAppScopes()[provider] || []), ...(input.scopes || [])]
        : [];
    if (missingScopes(provider, account.scopes || [], requiredScopes).length === 0) {
      await person.invoke(
        [
          "itx",
          "builtins",
          "secrets",
          [
            "connectToProject",
            tokenSecretPathOf(provider, account.connection),
            { projectId, connection: account, ownerEmail: principal.email },
          ],
        ],
        [],
        { ...hopCaller(), platform: true },
      );
      return { connection: account.connection };
    }
    const project = await facetStateOf<ProjectState>(
      deps.context(owner.rootPath),
      "project",
      hopCaller(),
    );
    const { authorizationUrl } = (await person.invoke(
      [
        "itx",
        "builtins",
        "integrations",
        [
          "connectForProject",
          {
            provider,
            connection: account.connection,
            client: "iterate",
            scopes: input.scopes,
            next: input.next,
            connectToProject: {
              projectId,
              requiredScopes,
              reconnect:
                project.integrations[connectionPathOf(provider, account.connection)]
                  ?.ownerUserId === principal.actor,
            },
          },
        ],
      ],
      [],
      { ...hopCaller(), platform: true },
    )) as { authorizationUrl: string };
    return { authorizationUrl, connection: account.connection };
  };
  /** The platform's verbs (a lend's other side): no caller of theirs ever reaches them. */
  /** A webhook's SIGNING KEY, by secret and origin, read from the secret's own context — the
   *  platform's `clientSecretFor`, which answers only for an origin the secret is pinned to — and
   *  kept as long as a rule snapshot is (SNAPSHOT_TTL_MS, how long an isolate may act on a revoked
   *  grant): a row delivering 1,000 events a second reads it once per window, not once per event.
   *  The read in flight is what is kept, so it is shared; a failed one is not kept. */
  const webhookSigningKeys = new Kept<Promise<string>>(SNAPSHOT_TTL_MS);
  const webhookSigningKey = (secretPath: string, origin: string): Promise<string> => {
    const cacheKey = `${secretPath} ${origin}`;
    const kept = webhookSigningKeys.get(cacheKey);
    if (kept) return kept;
    const key = deps
      .context(resolveContextPath(owner.rootPath, `.${secretPath}`))
      .invoke(["itx", "builtins", "secrets", ["clientSecretFor", secretPath, { origin }]], [], {
        principal: null,
        platform: true,
      }) as Promise<string>; // the secret facet's own `clientSecretFor` answers the value, a string
    webhookSigningKeys.set(cacheKey, key);
    key.catch(() => webhookSigningKeys.delete(cacheKey));
    return key;
  };
  const assertPlatformCaller = (verb: string) => {
    if (!deps.caller().platform) throw codedError("FORBIDDEN", `itx.${verb} is the platform's own`);
  };
  /** The `secret` processor row on the secret's context — the facet hosted with a row, so the
   *  engine pushes it every fact (idempotent: a second enable of the same row is a no-op). */
  const enableSecretRow = (secret: ReachableContext) =>
    secret.invoke(["itx", "builtins", "processors", ["enable", "secret"]], [], hopCaller());
  /** The secret's facet on its own context — `write`, `clear`, `beginOAuth`, `completeOAuth`,
   *  `verifyHmac`, `snapshot` (secret/durable-object.ts) — reached through the platform's own call:
   *  a caller's itx expression reaches its reads alone. Hosted on its first call. Every verb runs it
   *  inside `onSecretContext`'s `here`, which runs on the secret's own context. */
  /** One call on the context's first-party `secret` facet. A facet call answers `unknown`; the casts
   *  below are that facet's own return shapes (secret/durable-object.ts). */
  const secretFacet = (call: ItxExpressionStep) => deps.callFacetAsPlatform("secret", [call]);
  /** The fact of a write or a deletion: on the secret's own path (`secret`), attributed to the
   *  caller, then cross-posted to the owner's root for the catalog — stamped `source.platform`, which
   *  a person's or an organization's catalog fold requires (caller.ts `Caller.platform`). */
  const crossPostSecretFact = async (event: StreamEventInput) => {
    const root = deps.context(owner.rootPath);
    // the global root's catalog has no other writer to enable its row (a second enable is a no-op)
    if (owner.kind === "global")
      await root.invoke(["itx", "builtins", "processors", ["enable", "instance"]], [], hopCaller());
    await root.invoke(["itx", "builtins", ["append", event]], [], {
      ...hopCaller(),
      platform: true,
    });
  };
  const secretFact = async (secret: ReachableContext, event: StreamEventInput): Promise<void> => {
    await secret.append(stampCaller(event, deps.caller(), path));
    await crossPostSecretFact(event);
  };
  /** A person's account the project stops using — its path's lend ended: the project deleted the
   *  path (a disconnect), or the person disconnected their account or left — is
   *  `<provider>/disconnected` on the project's root, when the path is such an account's. */
  const disconnectedFromProject = async (secretPath: string) => {
    if (owner.kind !== "project") return;
    const root = deps.context(owner.rootPath);
    const state = await facetStateOf<ProjectState>(root, "project", hopCaller());
    for (const row of Object.values(state.integrations))
      if (row.ownerUserId && tokenSecretPathOf(row.provider, row.connection) === secretPath)
        await root.invoke(
          [
            "itx",
            "builtins",
            [
              "append",
              {
                type: `events.iterate.com/${row.provider}/disconnected`,
                payload: { connection: row.connection },
              },
            ],
          ],
          [],
          { ...hopCaller(), platform: true },
        );
  };
  /** A deleted secret's lends end with it, on both sides: the lends of a lender's secret
   *  (`lender`), and the lend a borrower's path stood on (`borrower-deleted`). */
  const endLendsOf = async (
    secret: ReachableContext,
    secretPath: string,
    cleared: {
      lends: Record<string, { to: string; as: string; borrowers: string[] }>;
      borrowed: { lender: string; lenderPath: string; lendId: string } | null;
    },
  ) => {
    const revoked = (lendId: string, reason: LendRevokedReason) =>
      secretFact(secret, {
        type: "events.iterate.com/secret/lend-revoked",
        payload: { path: secretPath, lendId, reason },
      });
    // the clear kept every lend it ended (secret/durable-object.ts `EndingLends`) until this is done
    await finishEndingLends(secret, secretPath);
    if (!cleared.borrowed) return;
    await deps
      .otherOwnerContext(cleared.borrowed.lender)
      .invoke(
        [
          "itx",
          "builtins",
          "secrets",
          [
            "revokeLend",
            cleared.borrowed.lenderPath,
            cleared.borrowed.lendId,
            { reason: "borrower-deleted", borrower: projectId },
          ],
        ],
        [],
        { ...hopCaller(), platform: true },
      );
    await revoked(cleared.borrowed.lendId, "borrower-deleted");
    await disconnectedFromProject(secretPath);
  };
  /** A LEND ENDED HERE, FINISHED ON EVERY SIDE: its fact (keyed by the lend, so a retry lands it
   *  once), the projects it reached told (`dropFromBorrowers`), then forgotten
   *  (secret/durable-object.ts `finishEndingLend`). A project that could not be told stays in the
   *  facet's record, the rest leave it, and the call fails: a retry of the revocation or the delete
   *  that ended it tells the ones left. */
  const finishEndedLend = async (
    secret: ReachableContext,
    secretPath: string,
    lendId: string,
    ended: { to: string; as: string; borrowers: string[]; reason: LendRevokedReason },
  ) => {
    await secretFact(secret, {
      type: "events.iterate.com/secret/lend-revoked",
      payload: { path: secretPath, lendId, reason: ended.reason },
      idempotencyKey: `secret/lend-revoked:${lendId}`,
    });
    const untold =
      ended.reason === "borrower-deleted"
        ? []
        : await dropFromBorrowers(lendId, ended, ended.reason);
    await secretFacet(["finishEndingLend", lendId, untold.map(({ borrower }) => borrower)]);
    if (untold.length) throw untold[0]!.error;
  };
  /** Every lend this secret ended whose other side is not done yet (`finishEndedLend`). */
  const finishEndingLends = async (secret: ReachableContext, secretPath: string) => {
    // The facet's own answer (secret/durable-object.ts `endingLends`).
    const ending = (await secretFacet(["endingLends"])) as Record<
      string,
      { to: string; as: string; borrowers: string[]; reason: LendRevokedReason }
    >;
    for (const [lendId, ended] of Object.entries(ending))
      await finishEndedLend(secret, secretPath, lendId, ended);
  };
  /** A lend's end told to the projects it reached (`dropLend` on each borrowed path), ten at a
   *  time: the ones that could not be told, each with why. Until one is, its path's use is refused
   *  at the lender all the same ("this lend was revoked"). */
  const dropFromBorrowers = async (
    lendId: string,
    lend: { to: string; as: string; borrowers: string[] },
    reason: LendRevokedReason,
  ) => {
    const untold: { borrower: string; error: unknown }[] = [];
    for (let at = 0; at < lend.borrowers.length; at += 10)
      await Promise.all(
        lend.borrowers.slice(at, at + 10).map(async (borrower) => {
          try {
            await projectRoot(borrower).invoke(
              ["itx", "builtins", "secrets", ["dropLend", lend.as, { lendId, reason }]],
              [],
              { ...hopCaller(), platform: true },
            );
          } catch (error) {
            untold.push({ borrower, error });
          }
        }),
      );
    return untold;
  };
  /** One more project borrows this secret's lend to every project, on the secret's own context:
   *  kept as a borrower here first, so its first use is admitted, then its path told
   *  (`acceptLend`). A path that holds a secret of its own keeps it (`kept`: the borrow refused it,
   *  coded INVALID_INPUT); a lend gone meanwhile borrows nothing (`revoked`). */
  const lendToProjectHere = async (
    secretPath: string,
    lendId: string,
    borrower: string,
  ): Promise<"borrowed" | "kept" | "revoked"> => {
    // the facet's own answer (secret/durable-object.ts `everyProjectBorrower`)
    const lend = (await secretFacet(["everyProjectBorrower", lendId, borrower, true])) as {
      as: string;
      urls: string[];
    } | null;
    if (!lend) return "revoked";
    const borrowed: BorrowedSecret = {
      lendId,
      lender: { instance: true },
      lenderContext: iterateContextName,
      lenderPath: secretPath,
      urls: lend.urls,
    };
    try {
      await projectRoot(borrower).invoke(
        ["itx", "builtins", "secrets", ["acceptLend", lend.as, borrowed]],
        [],
        { ...hopCaller(), platform: true },
      );
      return "borrowed";
    } catch (error) {
      await secretFacet(["everyProjectBorrower", lendId, borrower, false]);
      if (errorCode(error) === "INVALID_INPUT") return "kept";
      throw error;
    }
  };
  /** One project's borrow of a lend to every project, counted into `outcome`: a failure is
   *  reported and counted, never thrown, so one project cannot stop the rest. */
  const tallyBorrow = async (
    outcome: EveryProjectBorrows,
    at: { secretPath: string; lendId: string; borrower: string },
    borrow: () => Promise<"borrowed" | "kept" | "revoked">,
  ) => {
    try {
      const answer = await borrow();
      if (answer === "borrowed") outcome.borrowed++;
      if (answer === "kept") outcome.kept.push(at.borrower);
    } catch (error) {
      reportIssue("itx.secrets.every-project-borrow", error, {
        lendId: at.lendId,
        path: at.secretPath,
        projectId: at.borrower,
      });
      outcome.failed.push({
        projectId: at.borrower,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  /** THE OPERATOR'S LEND of the deployment's own secret, on the secret's context: to one project
   *  (kept, told, then the fact, as a person's), or to every project — the lend kept and its fact
   *  landed first, so a project created from now on borrows it too (session.ts
   *  `projects.create`), then every existing project borrows it, ten at a time (one hop to each
   *  project's root and on to its path's context). A project created during the walk may be told
   *  twice; a second borrow of the same lend is a no-op. */
  const lendFromInstance = async (
    secret: ReachableContext,
    secretPath: string,
    to: string,
    as: string,
  ): Promise<{ lendId: string; everyProject?: EveryProjectBorrows }> => {
    // No snapshot check: the facet's fold trails a `set` just made; its `lend` refuses a path with
    // no material of its own (a borrowed one has none) from its storage, which does not.
    const lendId = `lend_${crypto.randomUUID().replaceAll("-", "")}`;
    const lent = (borrower: string) =>
      secretFact(secret, {
        type: "events.iterate.com/secret/lent",
        payload: { path: secretPath, lendId, to: borrower, as },
      });
    if (to === "every-project") {
      await secretFacet(["lend", { lendId, to, as }]);
      await lent(to);
      const projects = await new ControlPlane(env).reachableProjects("every");
      const everyProject: EveryProjectBorrows = { borrowed: 0, kept: [], failed: [] };
      for (let at = 0; at < projects.length; at += 10)
        await Promise.all(
          projects
            .slice(at, at + 10)
            .map(({ id: borrower }) =>
              tallyBorrow(everyProject, { secretPath, lendId, borrower }, () =>
                lendToProjectHere(secretPath, lendId, borrower),
              ),
            ),
        );
      return { lendId, everyProject };
    }
    const project = await new ControlPlane(env).getProject(to);
    if (!project) throw codedError("INVALID_INPUT", `itx.secrets.lend: no project ${to}`);
    const { urls } = (await secretFacet(["lend", { lendId, to: project.id, as }])) as {
      urls: string[];
    };
    const borrowed: BorrowedSecret = {
      lendId,
      lender: { instance: true },
      lenderContext: iterateContextName,
      lenderPath: secretPath,
      urls,
    };
    try {
      await projectRoot(project.id).invoke(
        ["itx", "builtins", "secrets", ["acceptLend", as, borrowed]],
        [],
        { ...hopCaller(), platform: true },
      );
    } catch (error) {
      await secretFacet(["endLend", lendId]);
      throw error;
    }
    await lent(project.id);
    return { lendId };
  };
  /** The `secret` processor rows on the secret's context — one while the secret lives. */
  const secretRows = (secret: ReachableContext) =>
    // `invoke` is untyped across the DO hop; `processors.list` answers its rows.
    secret.invoke(["itx", "builtins", "processors", ["list"]], [], hopCaller()) as Promise<
      { name: string }[]
    >;

  /** `itx.fetchRoutes` is the project root's: its facts land on `/`, whose core state is the table. */
  const assertOnProjectRoot = (verb: string) => {
    if (projectId === GLOBAL_PROJECT_ID || path !== "/")
      throw codedError(
        "INVALID_CONTEXT",
        `itx.fetchRoutes.${verb}: a project's fetch routes live on its root "/" — reach them there, itx.cd("/").fetchRoutes`,
      );
  };

  // Each root implements one member of `BuiltInScope` above (the canonical doc of the surface); the
  // comments here add only the WHY of a code branch.
  return {
    ...buildPortableBuiltIns(deps),
    ...buildIdentityRoots(deps),
    secrets: {
      // The fact is appended FIRST: a refused append (a paused stream) leaves no value behind; a
      // facet failure after it leaves a fact whose value egress cannot find — loud ("no stored
      // project secret"), not silent. The facts carry the pin and the strategy KIND, never the material.
      set: (secretPath, material, options) =>
        onSecretContext(secretPath, ["set", secretPath, material, options], async (secret) => {
          const record = normalizeSecretRecord(material, options);
          await enableSecretRow(secret);
          // Material of its own over a borrowed path ends the borrow at the lender first, as a
          // delete does: the lend would otherwise stay live there with no borrower.
          const { state } = (await secretFacet(["snapshot"])) as { state: SecretState };
          if (state.borrowed)
            await endLendsOf(
              secret,
              secretPath,
              (await secretFacet(["clear"])) as Parameters<typeof endLendsOf>[2],
            );
          await secretFact(secret, {
            type: "events.iterate.com/secret/set",
            payload: {
              path: secretPath,
              urls: record.urls,
              ...(record.refresh && { refresh: record.refresh.kind }),
              ...(record.refresh?.kind === "worker" && {
                refreshSourceSha256: await sha256Hex(record.refresh.source),
              }),
            },
          });
          await secretFacet(["write", record, options?.merge === true]);
          return { path: secretPath };
        }),
      // No fact here: the log learns of the secret when the exchange succeeds, so an abandoned
      // attempt leaves no row that advertises a pin and a strategy the facet does not hold.
      beginOAuth: (secretPath, options) => {
        if (owner.kind === "global")
          throw codedError(
            "INVALID_INPUT",
            "itx.secrets.beginOAuth: the deployment's own secrets are set (itx.secrets.set), never connected",
          );
        // the provider's callback hangs under the platform origin — the caller's, not a DO's
        const platformOrigin = deps.platformOrigin();
        if (!platformOrigin)
          throw codedError(
            "INVALID_INPUT",
            "itx.secrets.beginOAuth: this call carries no platform origin for the callback URL — call it from a session",
          );
        return onSecretContext(secretPath, ["beginOAuth", secretPath, options], async (secret) => {
          await enableSecretRow(secret);
          return (await secretFacet([
            "beginOAuth",
            normalizeSecretOAuth(options, [platformOrigin, deps.dashOrigin].filter(Boolean)),
            platformOrigin,
          ])) as { authorizationUrl: string; nonce: string };
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
          // A facet call answers `unknown` over the hop; this is the platform's own
          // SecretDurableObject.completeOAuth's declared answer.
          const { urls, refresh, scopes, held } = (await secretFacet(["completeOAuth", input])) as {
            urls: string[];
            refresh?: SecretRefresh["kind"];
            exchanged: boolean;
            scopes: string[];
            held?: HeldToken;
          };
          // held aside, not stored: nothing on the log until a move admits it (`admitHeldToken`)
          if (held) return { path: secretPath, scopes, held };
          await secretFact(secret, {
            type: "events.iterate.com/secret/set",
            payload: { path: secretPath, urls, refresh },
          });
          // what the provider granted, for the connection the callback finishes (integrations/verbs.ts)
          return { path: secretPath, scopes };
        }),
      admitHeldToken: (secretPath, input) => {
        assertPlatformCaller("secrets.admitHeldToken");
        return onSecretContext(
          secretPath,
          ["admitHeldToken", secretPath, input],
          async (secret) => {
            // A facet call answers `unknown` over the hop; this is the platform's own
            // SecretDurableObject.admitHeldToken's declared answer.
            const { urls, refresh } = (await secretFacet(["admitHeldToken", input])) as {
              urls: string[];
              refresh?: SecretRefresh["kind"];
            };
            await secretFact(secret, {
              type: "events.iterate.com/secret/set",
              payload: { path: secretPath, urls, refresh },
            });
            return { path: secretPath };
          },
        );
      },
      dropHeldToken: (secretPath, input) => {
        assertPlatformCaller("secrets.dropHeldToken");
        return onSecretContext(secretPath, ["dropHeldToken", secretPath, input], async (secret) => {
          // the platform's own SecretDurableObject.dropHeldToken's declared answer, `unknown` over the hop
          const dropped = (await secretFacet(["dropHeldToken", input])) as
            | "held"
            | "gone"
            | {
                lends: Record<string, { to: string; as: string; borrowers: string[] }>;
                borrowed: { lender: string; lenderPath: string; lendId: string } | null;
              };
          if (typeof dropped === "string") return dropped;
          // the admitted record, cleared in the facet: its deletion's facts, as `delete` lands them
          await secretFact(secret, {
            type: "events.iterate.com/secret/deleted",
            payload: { path: secretPath },
          });
          await endLendsOf(secret, secretPath, dropped);
          if ((await secretRows(secret)).some((row) => row.name === "secret"))
            await secret.invoke(
              ["itx", "builtins", "processors", ["disable", "secret"]],
              [],
              hopCaller(),
            );
          return "admitted";
        });
      },
      clientSecretFor: (secretPath, input) => {
        assertPlatformCaller("secrets.clientSecretFor");
        return onSecretContext(
          secretPath,
          ["clientSecretFor", secretPath, input],
          // the platform's own SecretDurableObject.clientSecretFor's declared answer, `unknown` over the hop
          async () => (await secretFacet(["clientSecretFor", input])) as string,
        );
      },
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
          const { state } = (await secretFacet(["snapshot"])) as { state: SecretState };
          if (!state.material && !state.deletion) {
            // an OAuth attempt still in flight dies with it: its callback must not store a token
            await secretFacet(["clear"]);
            throw codedError(
              "SECRET_NOT_SET",
              `secret ${secretPath}: never set — nothing to delete`,
            );
          }
          const deleted: StreamEventInput = {
            type: "events.iterate.com/secret/deleted",
            payload: { path: secretPath },
          };
          const rowStands = (await secretRows(secret)).some((row) => row.name === "secret");
          if (state.material) {
            // What the clear ended (secret/durable-object.ts `clear`): this secret's lends, or the
            // lend this path borrowed.
            const cleared = (await secretFacet(["clear"])) as {
              lends: Record<string, { to: string; as: string; borrowers: string[] }>;
              borrowed: { lender: string; lenderPath: string; lendId: string } | null;
            };
            await secretFact(secret, deleted);
            await endLendsOf(secret, secretPath, cleared);
          } else {
            // a delete retried after its lends' other side failed finishes them now
            await finishEndingLends(secret, secretPath);
            if (rowStands) await crossPostSecretFact(deleted);
          }
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
        const state = await facetStateOf<{ secrets: SecretCatalog }>(
          deps.context(owner.rootPath),
          ownerRootFacet(),
          hopCaller(),
        );
        return Object.entries(state.secrets).map(([path, row]) => ({ path, ...row }));
      },
      collectFromUser: async (input: CollectSecretInput): Promise<CollectSecretLink> => {
        const collected = z
          .object({
            path: z.string(),
            egress: z.object({ urls: z.array(z.string()) }),
            description: z.string().optional(),
            fields: z
              .array(
                z.object({
                  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                  label: z.string().trim().min(1).max(80),
                  multiline: z.boolean().optional(),
                }),
              )
              .min(1)
              .max(10)
              .refine(
                (fields) => new Set(fields.map((field) => field.name)).size === fields.length,
                "field names are unique",
              )
              .optional(),
          })
          .parse(input);
        const secretPath = assertSecretPath(collected.path);
        const urls = originsOf(collected.egress.urls);
        if (urls.length === 0)
          throw new Error("itx.secrets.collectFromUser: egress.urls must name at least one URL");
        const unsafeUrl = collected.egress.urls.find((value) => {
          const url = new URL(value);
          return (
            !["http:", "https:"].includes(url.protocol) || Boolean(url.username || url.password)
          );
        });
        if (unsafeUrl)
          throw new Error(
            `itx.secrets.collectFromUser: egress URL ${JSON.stringify(unsafeUrl)} must be an http(s) URL without credentials`,
          );
        if (!deps.dashOrigin)
          throw new Error(
            "itx.secrets.collectFromUser: this platform has no Dash (set APP_CONFIG_URLS__DASH)",
          );
        const platformOrigin = deps.platformOrigin();
        if (!platformOrigin)
          throw new Error(
            "itx.secrets.collectFromUser: this platform has no public origin yet — call it after a person has reached this instance",
          );
        const project = await deps.projectInfo();
        if (!project.projectSlug)
          throw new Error(
            "itx.secrets.collectFromUser: only a project's context can collect a secret",
          );
        // the Dash's page for the link, outside its shell (packages/dash routes/collect-secret.$slug.tsx)
        const url = new URL(
          `/collect-secret/${encodeURIComponent(project.projectSlug)}`,
          deps.dashOrigin,
        );
        url.searchParams.set("project", projectId);
        url.searchParams.set("platform", platformOrigin);
        url.searchParams.set("path", secretPath);
        url.searchParams.set("urls", JSON.stringify(urls));
        if (collected.description)
          url.searchParams.set("description", JSON.stringify(collected.description));
        if (collected.fields) url.searchParams.set("fields", JSON.stringify(collected.fields));
        const callingPath = deps.caller().path;
        // The agent whose `message()` wakes the next turn: an `/agents/**` caller is that agent.
        if (callingPath?.startsWith("/agents/")) url.searchParams.set("agent", callingPath);
        return { path: secretPath, url: url.href };
      },
      verifyHmac: (secretPath, input) =>
        onSecretContext(
          secretPath,
          ["verifyHmac", secretPath, input],
          () => secretFacet(["verifyHmac", input]) as Promise<boolean>,
        ),
      verifyEquals: (secretPath, input) =>
        onSecretContext(
          secretPath,
          ["verifyEquals", secretPath, input],
          // the facet call is untyped; the secret facet's verifyEquals answers a boolean
          () => secretFacet(["verifyEquals", input]) as Promise<boolean>,
        ),
      // THE OPERATOR'S LEND of the deployment's own secret (`lendFromInstance`). A person's account
      // reaches a project through `integrations.connect(provider, { account })` alone, which the
      // platform carries out on their secret (`connectToProject`).
      lend: (secretPath, input) =>
        onSecretContext(secretPath, ["lend", secretPath, input], async (secret) => {
          if (owner.kind !== "global")
            throw codedError(
              "INVALID_INPUT",
              "itx.secrets.lend: the deployment's own secrets, on the global root (session.global) — a person connects an account of theirs to a project with itx.integrations.connect(provider, { account }) on the project",
            );
          const { to, as } = z.object({ to: z.string().min(1), as: z.string() }).parse(input);
          assertSecretPath(as);
          return lendFromInstance(secret, secretPath, to, as);
        }),
      // THE LENDER'S side of a person's account connected to a project: the lend kept in the
      // facet, the project's path told, the fact, then the project's row — so a refused path (one
      // with a secret of its own) leaves no lend behind. Every step converges on a retry: a lend
      // already kept for the project is told and recorded again, its facts keyed by the lend
      // (`idempotencyKey`), so a retry after a lost fact lands it once. `onlyIfConnected` (a consent
      // that finished for an account the project had when it began) connects nothing once the
      // project has disconnected it meanwhile.
      connectToProject: (secretPath, input) => {
        assertPlatformCaller("secrets.connectToProject");
        return onSecretContext(
          secretPath,
          ["connectToProject", secretPath, input],
          async (secret) => {
            if (owner.kind !== "users")
              throw codedError(
                "INVALID_CONTEXT",
                "itx.secrets.connectToProject: a person's own connection, on their own context",
              );
            const connection = IntegrationConnectionRow.parse(input.connection);
            if (tokenSecretPathOf(connection.provider, connection.connection) !== secretPath)
              throw codedError(
                "INVALID_INPUT",
                `itx.secrets.connectToProject: ${secretPath} is not the ${connection.provider} connection ${connection.connection}`,
              );
            const projectId = await new ControlPlane(env).reachableProjectId(
              { userId: owner.ownerId },
              input.projectId,
            );
            if (!projectId)
              throw codedError(
                "FORBIDDEN",
                `itx.integrations.connect: you are not a member of project ${input.projectId}`,
              );
            const project = projectRoot(projectId);
            if (input.onlyIfConnected) {
              const state = await facetStateOf<ProjectState>(project, "project", {
                ...hopCaller(),
                platform: true,
              });
              const row =
                state.integrations[connectionPathOf(connection.provider, connection.connection)];
              if (row?.ownerUserId !== owner.ownerId) return { connection: connection.connection };
            }
            // The facet's own answers, from its storage: a consent that just finished is there
            // before the fold of its `secret/set` is, and its `lend` refuses a path with no token of
            // its own.
            const kept = (await secretFacet(["lendOf", projectId, secretPath])) as {
              lendId: string;
            } | null;
            const lendId = kept?.lendId || `lend_${crypto.randomUUID().replaceAll("-", "")}`;
            // `lend` keeps it again, idempotently, and answers the pin either way
            const { urls } = (await secretFacet([
              "lend",
              { lendId, to: projectId, as: secretPath },
            ])) as { urls: string[] };
            const borrowed: BorrowedSecret = {
              lendId,
              lender: { userId: owner.ownerId },
              lenderContext: iterateContextName,
              lenderPath: secretPath,
              urls,
              integration: {
                provider: connection.provider,
                account: connection.account,
                externalId: connection.externalId,
              },
            };
            try {
              await project.invoke(
                ["itx", "builtins", "secrets", ["acceptLend", secretPath, borrowed]],
                [],
                { ...hopCaller(), platform: true },
              );
            } catch (error) {
              // A refusal (the path holds a secret of its own) leaves no lend behind. Anything else
              // may have landed on the project before it failed, so the lend stays for the retry,
              // which finds it (`lendOf`) and tells the project the same lend again.
              if (errorCode(error) === "INVALID_INPUT") await secretFacet(["endLend", lendId]);
              throw error;
            }
            await secretFact(secret, {
              type: "events.iterate.com/secret/lent",
              payload: { path: secretPath, lendId, to: projectId, as: secretPath },
              idempotencyKey: `secret/lent:${lendId}`,
            });
            const { provider, ...row } = connection;
            await project.invoke(
              [
                "itx",
                "builtins",
                [
                  "append",
                  {
                    type: `events.iterate.com/${provider}/connected`,
                    payload: {
                      ...row,
                      ownerUserId: owner.ownerId,
                      ownerEmail: input.ownerEmail,
                    },
                  },
                ],
              ],
              [],
              { ...hopCaller(), platform: true },
            );
            return { connection: connection.connection };
          },
        );
      },
      // A revocation from the lender, or the platform's (a borrower's delete, the lender gone from
      // the project), which alone names another reason and the borrower the lend must be to.
      // A lend to every project named with one borrower (that project's delete) ends for it alone.
      // A person's are the platform's alone: they disconnect an account from a project there.
      revokeLend: (secretPath, lendId, options) =>
        onSecretContext(secretPath, ["revokeLend", secretPath, lendId, options], async (secret) => {
          const platform = deps.caller().platform === true;
          if (owner.kind !== "global" && !platform)
            throw codedError(
              "INVALID_INPUT",
              "itx.secrets.revokeLend: the deployment's own secrets, on the global root — disconnect a person's account from a project on the project",
            );
          const reason = (platform && options?.reason) || "lender";
          const borrower = platform ? options?.borrower : undefined;
          // The facet's own answers (secret/durable-object.ts `endLend`, `endingLends`).
          const lend = (await secretFacet(["endLend", String(lendId), borrower, reason])) as {
            to: string;
            as: string;
            borrowers: string[];
          } | null;
          // One project's return of a lend to every project: the lend stands for the rest.
          if (lend?.to === "every-project" && borrower) {
            await secretFact(secret, {
              type: "events.iterate.com/secret/lend-revoked",
              payload: { path: secretPath, lendId, reason, borrower },
            });
            return { lendId };
          }
          // Ended now, or by an earlier revocation whose other side is not done: finish it, with the
          // reason it ended for.
          const ending = (
            (await secretFacet(["endingLends"])) as Record<
              string,
              { to: string; as: string; borrowers: string[]; reason: LendRevokedReason }
            >
          )[String(lendId)];
          if (ending) await finishEndedLend(secret, secretPath, String(lendId), ending);
          return { lendId };
        }),
      borrowEveryProjectLends: async (borrower) => {
        assertPlatformCaller("secrets.borrowEveryProjectLends");
        if (owner.kind !== "global")
          throw codedError(
            "INVALID_CONTEXT",
            "itx.secrets.borrowEveryProjectLends: the deployment's lends are the global root's",
          );
        const state = await facetStateOf<InstanceState>(
          deps.context(owner.rootPath),
          "instance",
          hopCaller(),
        );
        const outcome: EveryProjectBorrows = { borrowed: 0, kept: [], failed: [] };
        for (const [secretPath, row] of Object.entries(state.secrets))
          for (const [lendId, lend] of Object.entries(row.lends || {}))
            if (lend.to === "every-project")
              await tallyBorrow(outcome, { secretPath, lendId, borrower }, () =>
                onSecretContext(secretPath, ["lendToProject", secretPath, lendId, borrower], () =>
                  lendToProjectHere(secretPath, lendId, borrower),
                ),
              );
        return outcome;
      },
      lendToProject: (secretPath, lendId, borrower) => {
        assertPlatformCaller("secrets.lendToProject");
        return onSecretContext(secretPath, ["lendToProject", secretPath, lendId, borrower], () =>
          lendToProjectHere(secretPath, lendId, borrower),
        );
      },
      // THE BORROWER'S side, the platform's alone: the path keeps the lend, never material.
      acceptLend: (secretPath, input) => {
        assertPlatformCaller("secrets.acceptLend");
        return onSecretContext(secretPath, ["acceptLend", secretPath, input], async (secret) => {
          await secretFacet([
            "borrow",
            { lender: input.lenderContext, lenderPath: input.lenderPath, lendId: input.lendId },
          ]);
          const { lenderContext: _context, lenderPath: _path, ...payload } = input;
          try {
            await enableSecretRow(secret);
            // keyed by the lend: a retry of the same lend lands it once
            await secretFact(secret, {
              type: "events.iterate.com/secret/borrowed",
              payload: { path: secretPath, ...payload },
              idempotencyKey: `secret/borrowed:${input.lendId}`,
            });
          } catch (error) {
            // a borrow whose fact never landed is no borrow: the lender rolls its lend back too
            await secretFacet(["dropBorrowed", input.lendId]);
            throw error;
          }
          return { path: secretPath };
        });
      },
      dropLend: (secretPath, input) => {
        assertPlatformCaller("secrets.dropLend");
        // The facts FIRST, keyed by the lend, then the pointer dropped: a retry after a lost fact
        // still finds the pointer, lands what is missing once, and drops it; a retry after the drop
        // finds none and is done.
        return onSecretContext(secretPath, ["dropLend", secretPath, input], async (secret) => {
          if ((await secretFacet(["borrowedLendId"])) !== input.lendId) return;
          await secretFact(secret, {
            type: "events.iterate.com/secret/lend-revoked",
            payload: { path: secretPath, lendId: input.lendId, reason: input.reason },
            idempotencyKey: `secret/lend-dropped:${input.lendId}`,
          });
          await disconnectedFromProject(secretPath);
          await secretFacet(["dropBorrowed", input.lendId]);
          await secret.invoke(
            ["itx", "builtins", "processors", ["disable", "secret"]],
            [],
            hopCaller(),
          );
        });
      },
    },
    integrations: {
      connect: async (provider, options = {}) => {
        const parsed = IntegrationConnectOptions.safeParse(options);
        if (!parsed.success)
          throw codedError(
            "INVALID_INPUT",
            `itx.integrations.connect: ${z.prettifyError(parsed.error)}`,
          );
        const input = parsed.data;
        if (input.account)
          return connectCallersAccount(IntegrationProvider.parse(provider), {
            ...input,
            account: input.account,
          });
        return onIntegrationsRoot("connect", [provider, input], async (facet) => {
          // the owner facet's snapshot is its contract's state
          const { state } = (await deps.callFacetAsPlatform(facet, [["snapshot"]])) as {
            state: { integrations: AccountState["integrations"] };
          };
          const held = Object.values(state.integrations).filter((row) => row.provider === provider);
          // a person's one connection to a provider is the one asked for more; a project names its own
          const connection =
            input.connection ||
            (facet === "account" && held.length === 1
              ? held[0]!.connection
              : crypto.randomUUID().slice(0, 8));
          // GitHub sends an installation's human back under the platform origin this call reached
          const platformOrigin = deps.platformOrigin() || undefined;
          if (input.installationId && !platformOrigin)
            throw codedError(
              "INVALID_CONTEXT",
              "itx.integrations.connect: an installation's connect comes back to the platform origin a session reached — call it from a session",
            );
          // the facet's `connectIntegration` answers where to send the human (integrations/verbs.ts)
          const { authorizationUrl } = (await deps.callFacetAsPlatform(facet, [
            [
              "connectIntegration",
              {
                provider: IntegrationProvider.parse(provider),
                connection,
                client: input.client,
                scopes: input.scopes,
                next: input.next,
                appSlug: input.appSlug,
                clientId: input.clientId,
                installationId: input.installationId,
                platformOrigin,
              } satisfies ConnectInput,
            ],
          ])) as { authorizationUrl: string };
          return { authorizationUrl, connection };
        });
      },
      disconnect: (provider, connection, options = {}) =>
        onIntegrationsRoot("disconnect", [provider, connection, options], async (facet) => {
          const parsed = z
            .object({ movedExternalId: z.string().min(1).optional() })
            .safeParse(options);
          if (!parsed.success)
            throw codedError(
              "INVALID_INPUT",
              `itx.integrations.disconnect: ${z.prettifyError(parsed.error)}`,
            );
          const { movedExternalId } = parsed.data;
          if (movedExternalId) assertPlatformCaller("integrations.disconnect's movedExternalId");
          await deps.callFacetAsPlatform(facet, [
            ["disconnectIntegration", { provider, connection, movedExternalId }],
          ]);
        }),
      requestFromUser: async (provider, options = {}) => {
        const { scopes } = z
          .object({ scopes: z.array(z.string().min(1)).default([]) })
          .parse(options);
        if (!deps.dashOrigin)
          throw new Error(
            "itx.integrations.requestFromUser: this platform has no Dash (set APP_CONFIG_URLS__DASH)",
          );
        const project = await deps.projectInfo();
        if (!project.projectSlug)
          throw new Error(
            "itx.integrations.requestFromUser: only a project's context asks a person to connect",
          );
        const url = new URL(
          `/projects/${encodeURIComponent(project.projectSlug)}/integrations`,
          deps.dashOrigin,
        );
        url.searchParams.set("connect", IntegrationProvider.parse(provider));
        if (scopes.length > 0) url.searchParams.set("scopes", scopes.join(" "));
        return { url: url.href };
      },
      connectForProject: (input) => {
        assertPlatformCaller("integrations.connectForProject");
        if (owner.kind !== "users" || path !== owner.rootPath)
          throw codedError(
            "INVALID_CONTEXT",
            "itx.integrations.connectForProject: a person's own root",
          );
        const { connectToProject, ...connect } = input;
        // the account facet's `connectIntegration` answers where to send the human (integrations/verbs.ts)
        return deps.callFacetAsPlatform("account", [
          ["connectIntegration", connect, connectToProject],
        ]) as Promise<{ authorizationUrl: string }>;
      },
      finishConnect: async (input) => {
        assertPlatformCaller("integrations.finishConnect");
        if (path !== owner.rootPath)
          throw codedError("INVALID_CONTEXT", "itx.integrations.finishConnect: the owner's root");
        // the owner facet's own answer (integrations/verbs.ts `finishIntegrationConnect`)
        return (await deps.callFacetAsPlatform(integrationsFacet("finishConnect"), [
          ["finishIntegrationConnect", input],
        ])) as FinishConnectAnswer;
      },
    },
    fetchRoutes: {
      set: async (fetchRouteName, route) => {
        assertOnProjectRoot("set");
        const refusal = (reason: string) =>
          codedError(
            "INVALID_INPUT",
            `itx.fetchRoutes.set(${JSON.stringify(fetchRouteName)}): ${reason}`,
          );
        let target: unknown;
        try {
          // the string half parsed once, here; anything else is the schema's to refuse
          target =
            // oxlint-disable-next-line iterate/simple-truthiness-check -- a caller's RPC input, typed but unchecked until FetchRouteConfiguredPayload parses it below
            typeof route?.target === "string" || Array.isArray(route?.target)
              ? normalizedItxExpression(route.target)
              : route?.target;
        } catch (error) {
          throw refusal(`target: ${error instanceof Error ? error.message : String(error)}`);
        }
        const parsed = FetchRouteConfiguredPayload.safeParse(
          !route
            ? { fetchRouteName, requestMatcher: null }
            : {
                fetchRouteName,
                requestMatcher: route.requestMatcher,
                target,
                authRequirement: route.authRequirement || null,
                priority: route.priority || 0,
              },
        );
        if (!parsed.success) throw refusal(z.prettifyError(parsed.error));
        const payload = parsed.data;
        // IDEMPOTENT: the route as it stands appends nothing — an absent route stands as the
        // deleting payload does. An own key only: a DNS label may be `constructor`.
        const table = deps.fetchRoutes();
        const { configuredOffset: _configuredOffset, ...current } = Object.hasOwn(
          table,
          fetchRouteName,
        )
          ? table[fetchRouteName]!
          : { requestMatcher: null, configuredOffset: 0 };
        if (jsonEqual({ fetchRouteName, ...current }, payload)) return { fetchRouteName };
        // Read-your-writes by construction: the core reduce folds the fact in the commit that
        // appends it, so the next `match` (the very next request) sees this route.
        await append({ type: "events.iterate.com/itx/fetch-route-configured", payload });
        return { fetchRouteName };
      },
      list: async () => {
        assertOnProjectRoot("list");
        return Object.entries(deps.fetchRoutes())
          .map(([fetchRouteName, route]) => ({ fetchRouteName, ...route }))
          .sort(
            (a, b) => b.priority - a.priority || (a.fetchRouteName < b.fetchRouteName ? -1 : 1),
          );
      },
      match: async (request) => {
        assertOnProjectRoot("match");
        return matchFetchRoute(deps.fetchRoutes(), {
          url: request.url,
          headers: new Headers(request.headers),
        });
      },
    },
    append,
    abort: async (reasonInput) => {
      const reason = abortReasonOf(reasonInput, "itx.abort");
      // WHO ASKED, beyond what the append stamps (`source.principal`): the context the call started
      // at when it hopped here, and whether loaded code asked — loaded code carries no principal.
      const { path: callerPath, app } = deps.caller();
      // THE FACT FIRST, through `append` (attributed, pause-exempt — stream.ts); the reset is the
      // DO's, after the answer. A Workers-RPC caller's answer leaves once the fact is durable (the
      // output gate); an in-process caller has it at once, and only what it sends out waits there.
      const [aborted] = await append({
        type: "events.iterate.com/itx/aborted",
        payload: { reason, callerPath, app },
      });
      // The runtime logs this message as an error line (uncatchable), after the DO logs the
      // expected outcome at info (iterate-context-durable-object.ts `#abort`).
      deps.abortAfterTheAnswer(
        `itx.abort() reset the context ${path}${reason ? `: ${reason}` : ""}`,
      );
      return aborted;
    },
    schedules: {
      ...deps.schedules,
      get: (key) => deps.schedules.get(ScheduleKey.parse(key)),
      set: async (input, options) => {
        // An interval set again as it stands keeps its clock: an init case sets it after every
        // commit. A failed one is set again, which revives it, and so is one set again from
        // shallower in a chain: it ticks at that depth from now on (cause.ts).
        const { key, when, events } = ScheduledAppendInput.parse(input);
        const live = deps.schedules.get(key);
        if (
          live &&
          !live.failure &&
          "everyMs" in when &&
          jsonEqual({ when: live.when, events: live.events }, { when, events }) &&
          (deps.caller().cause?.depth ?? 0) >= (live.source?.cause?.depth ?? 0)
        )
          return { key, scheduledAtOffset: live.scheduledAtOffset };
        const [definition] = await append({
          type: "events.iterate.com/itx/schedule-set",
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
          type: "events.iterate.com/itx/schedule-cancelled",
          payload: receipt.success
            ? { key: receipt.data.key, ifScheduledAtOffset: receipt.data.scheduledAtOffset }
            : { key: ScheduleKey.parse(schedule) },
        });
      },
    },
    readEvents: (afterOffset?: number, limit?: number, options?: { includeEphemeral?: boolean }) =>
      ownContext().read(afterOffset, limit, options),
    waitForEvent: deps.waitForEvent,
    rpcStubs: deps.rpcStubs,
    facets: {
      get: deps.facets.get,
      // The reset, then its fact: the host's abort and restart hold every other event off
      // (facet-host.ts `#restart`), so the fact's own delivery to a processor facet meets the fresh
      // instance, never the one going away.
      abort: async (name, reasonInput) => {
        const reason = abortReasonOf(reasonInput, "itx.facets.abort");
        const { path: callerPath, app } = deps.caller(); // who asked, as for `abort` above
        await deps.facets.abort(name, reason);
        const [aborted] = await append({
          type: "events.iterate.com/itx/facet-aborted",
          payload: { name, reason, callerPath, app },
        });
        return aborted;
      },
    },
    subscriptions: deps.subscriptions,
    processors: {
      enable: async (name, spec) => {
        // Refused HERE, before anything is appended. A FIRST-PARTY name (first-party-facets.ts) hosts
        // this worker's own class: `consumes` at most, never a source; any other name's spec names
        // the source's host class, and its literal source is under the ceiling. Either is hosted
        // only where first-party-facet-placement.ts places it — the facet host refuses it anyway;
        // refused here too, so a row that could never deliver is never appended.
        const firstPartyClassName = firstPartyFacetClassOf(name);
        // The declared spec is a union: `{ consumes }` for a first-party name, or a loaded spec. Both
        // are read through the loaded shape, and checked below: a first-party name refuses a source
        // or a class, and any other name must name its class.
        const given = spec as (FacetSpec & { consumes?: string[] }) | undefined;
        // A literal source with no cacheKey is keyed by its content, the key the loader gives it
        // anyway (worker-loader.ts `prepareConfinedWorker`): so changed code is a changed spec that
        // this enable configures, and the same code again is the same spec, which appends nothing.
        const loaded =
          given && !given.cacheKey && isWorkerModules(given.source)
            ? { ...given, cacheKey: contentHashOfWorkerModules(given.source) }
            : given;
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
        assertFacetPlacement(name, { projectId, path });
        // IDEMPOTENT (the rule `provide` follows): a row already hosting this facet under
        // the same spec — its marker, as the reduce keeps it — appends nothing: every entity's
        // `create()` enables its row on every call.
        const { restarts: _restarts, ...existing } = deps.subscriptions.get(name)?.hostedFacet ?? {
          restarts: 0,
        };
        const requested = firstPartyClassName
          ? { name, className: firstPartyClassName }
          : hostedFacetMarkerOf({ name, ...facetSpecOf(loaded!) });
        if (
          jsonEqual(existing, requested) &&
          jsonEqual(deps.subscriptions.get(name)?.consumes ?? null, spec?.consumes || null)
        )
          return { name };
        await append({
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            name,
            target: [
              "itx",
              ...(deps.caller().app ? [] : ["builtins"]),
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
          type: "events.iterate.com/itx/subscription-configured",
          payload: { name, target: null },
        });
      },
      list: () => deps.subscriptions.list().filter((row) => row.hostedFacet),
      claim: async (name, at) => deps.claimFacetAlarm(name, at),
    },
    rewriteRules: deps.rewriteRules,
    workers: workersRoot({
      env,
      deployId: deps.deployId,
      projectId,
      path,
      iterateContextName,
      platformOrigin: deps.platformOrigin,
      itxEntrypoint: deps.itxEntrypoint,
      invoke: deps.invoke,
      caller: deps.caller,
      delivery: () => deps.caller().delivery,
      cause: () => deps.caller().cause,
      namedWorker: deps.namedWorker,
    }),
    platformHook: {
      deliverEvent: async (event) => {
        await assertDeliveryCaller(
          deps.caller().delivery,
          "platformHook.deliverEvent",
          JSON.stringify(event),
        );
        await deliverToPlatformHook(env, event);
      },
    },
    webhooks: {
      // A genuine InvokeHandle, as `workers.get`'s: across a `cd` hop it is the expression that
      // names it (dispatch.ts), so the delivery's call reaches it whole, its authority carried.
      get: (spec) => {
        const { url, signingSecret } = WebhookSpec.parse(spec);
        return new InvokeHandle(async (methodSteps) => {
          const [call] = methodSteps;
          if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] !== "deliverEvent")
            throw new Error(
              `webhooks.get(spec).${print(methodSteps)}: a webhook answers deliverEvent(event) alone`,
            );
          // Only the delivery loop's call passes `assertDeliveryCaller` below, and it hands the
          // committed event it delivers.
          const [, event] = call as [string, StreamEvent];
          const body = JSON.stringify(event);
          await assertDeliveryCaller(
            deps.caller().delivery,
            "webhooks.get(spec).deliverEvent",
            body,
          );
          const headers = new Headers({
            "content-type": "application/json",
            "iterate-event-id": `${projectId}${event.path}@${event.offset}`,
          });
          if (signingSecret) {
            const timestamp = String(Math.floor(Date.now() / 1000));
            const key = await webhookSigningKey(signingSecret, new URL(url).origin);
            headers.set("iterate-timestamp", timestamp);
            headers.set(
              "iterate-signature",
              `v1=${await hmacSha256Hex(key, `${timestamp}.${body}`)}`,
            );
          }
          // Through THIS context's own `itx.fetch`, as its rules resolve it: a context that may not
          // fetch sends nothing (an unresolved fetch dangles the row). `manual`: a redirect is the
          // receiver's answer, retried like any non-2xx — followed, it would carry the event and its
          // signature to an origin the secret is not pinned to. The timeout cancels the request
          // itself, so a slow receiver's call settles and gives its delivery slot back
          // (subscription-delivery.ts).
          const request = new Request(url, {
            method: "POST",
            headers,
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });
          // `itx.fetch` answers a Response (BuiltInScope `fetch`); `invoke` types every answer
          // unknown.
          const response = (await ownContext().invoke(
            ["itx", "fetch"],
            [request],
            hopCaller(),
          )) as Response;
          await response.body?.cancel();
          if (response.ok) return;
          if (response.status === 410)
            throw codedError(
              "GONE",
              `webhook ${url} answered 410 Gone: its row halts until an operator resumes it`,
            );
          throw new Error(`webhook ${url} answered ${response.status}`);
        });
      },
    },
  } satisfies Omit<BuiltInScope, "builtins">;
}

/** `itx.whoami` and `itx.url`: who the context at `deps.path` is and where it is reached — one
 *  builder, so a context's Durable Object and the stateless resolver answer them alike, the
 *  resolver for its own context without a call to it (itx-expression-rewriting.ts
 *  `IDENTITY_ROOTS`). */
export function buildIdentityRoots(
  deps: Pick<
    BuildBuiltInsDeps,
    "projectId" | "path" | "projectInfo" | "platformOrigin" | "primaryHostname" | "ingressRouting"
  >,
): Pick<BuiltInScope, "whoami" | "url"> {
  const { projectId, path } = deps;
  return {
    whoami: async () => {
      const project = await deps.projectInfo();
      const platformOrigin = deps.platformOrigin();
      // the apex, by `itx.url`'s rule, when the caller carries the platform origin to compose it with
      const url =
        project.projectSlug && platformOrigin
          ? projectPublicUrlOf(deps.ingressRouting, platformOrigin, {
              project: project.projectSlug,
              primaryHostname: await deps.primaryHostname(),
            })
          : null;
      return { projectId, path, ...project, ...(url && { projectUrl: url.href }) };
    },
    url: async (target: { routingSlug?: string; path?: string } = {}) => {
      const platformOrigin = deps.platformOrigin();
      if (!platformOrigin)
        throw codedError(
          "INVALID_INPUT",
          "itx.url: this call carries no platform origin to compose a URL with — call it from a session, or hold the URL a session handed you",
        );
      const slug = (await deps.projectInfo()).projectSlug;
      if (!slug)
        throw codedError("INVALID_INPUT", "itx.url: only a project's context has a public URL");
      // on the project's primary hostname when it has one, else under the deployment's ingress
      const url = projectPublicUrlOf(deps.ingressRouting, platformOrigin, {
        project: slug,
        primaryHostname: await deps.primaryHostname(),
        routingSlug: target.routingSlug || null,
        path: target.path,
      });
      if (!url)
        throw codedError(
          "INVALID_INPUT",
          deps.ingressRouting
            ? `itx.url: ${JSON.stringify(target)} is not an address in this project (a routing slug is [a-z][a-z0-9-]*; a path starts with "/")`
            : "itx.url: this deployment has no project ingress (APP_CONFIG urls.ingressRouting is unset) — nothing serves a project over HTTP",
        );
      return url.href;
    },
  };
}

/** What the built-ins read of the deployment and the project, a context's Durable Object's and
 *  the stateless resolver's alike. `projectSlug` is the reader's: the Durable Object keeps it in
 *  its own storage. */
export function projectConfigDeps(
  appConfig: AppConfig,
  projectSlug: () => Promise<string | null | undefined>,
) {
  return {
    projectInfo: async () => {
      const slug = await projectSlug();
      return slug ? { projectSlug: slug } : {};
    },
    ingressRouting: appConfig.urls.ingressRouting,
    projectWildcard: appConfig.urls.projectWildcard,
    signingSecret: () => sessionSigningSecretOf(appConfig),
  } satisfies Partial<BuildBuiltInsDeps>;
}

/** What the portable built-ins read of their context: its identity, the bindings, how it is
 *  reached over HTTP and mail, its egress, a context by path for `cd`, who is calling, and the
 *  library. */
type PortableBuiltInsDeps = Pick<
  BuildBuiltInsDeps,
  | "projectInfo"
  | "projectId"
  | "path"
  | "ai"
  | "env"
  | "ingressRouting"
  | "projectWildcard"
  | "signingSecret"
  | "context"
  | "egress"
  | "caller"
  | "invokeAs"
  | "library"
>;

/** THE PORTABLE BUILT-INS (itx-expression-rewriting.ts `PORTABLE_ROOTS`) and `cd`: what answers the
 *  same from every context of a project, so a context's Durable Object and the stateless entrypoint
 *  (context/stateless-context.ts) both build them — the project's bindings under its prefixes,
 *  egress, mail, the library, and `cd`, addressing. */
export function buildPortableBuiltIns(deps: PortableBuiltInsDeps) {
  const { projectId, path, env } = deps;
  const owner = resourceScope(projectId, path);
  const kvPrefix = `${owner.id}:`;
  const r2Prefix = `${owner.id}/`;
  /** The platform's own hop (`buildBuiltIns`' `hopCaller` says why): the caller without its `app`,
   *  from the context it originated at — this one, when it named none — so a portable root that
   *  runs here and writes elsewhere (a mail sent) names its sender. */
  const hopCaller = (): Caller => {
    const { app: _loadedCode, ...caller } = deps.caller();
    return { ...caller, path: caller.path || path };
  };
  return {
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
        for (let cursor: string | undefined; ;) {
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
      presign: async (input) => {
        // the caller's, or the context's own: the deployment's `urls.os`, else the first one learned
        const { platformOrigin } = deps.caller();
        if (!platformOrigin)
          throw new Error(
            "files: a signed URL is composed from the platform origin the caller reached the platform on — this call carries none (call it from a session)",
          );
        // the URL carries the project's slug (the edge admits a project by it); the claim carries
        // the id — a global context (a user's, an organization's) has no URL
        const slug = owner.kind === "project" && (await deps.projectInfo()).projectSlug;
        if (!slug)
          throw new Error("files: only a project's context can sign a file URL — it has the host");
        return signedFileUrl({
          project: owner.id,
          key: input.key,
          method: input.method || "GET",
          expiresInSeconds: input.expiresInSeconds,
          host: slug,
          secret: await deps.signingSecret(),
          routing: deps.ingressRouting,
          platformOrigin,
        });
      },
    },
    ai: deps.ai,
    browser: cfBrowser(env.BROWSER),
    cfArtifacts: projectScopedArtifacts({ namespace: env.ARTIFACTS, projectId: owner.id }),
    email: {
      send: async (input) => {
        const domain = emailDomainOf(deps.ingressRouting);
        const slug = owner.kind === "project" ? (await deps.projectInfo()).projectSlug : undefined;
        if (!domain || !slug || !env.EMAIL)
          throw codedError(
            "INVALID_CONTEXT",
            "itx.email: only a project has an address, on a deployment whose projects are subdomains and that can send mail",
          );
        const wildcard = deps.projectWildcard;
        return sendEmail(
          {
            EMAIL: env.EMAIL,
            FILES: env.FILES,
            filesPrefix: r2Prefix,
            address: `${slug}@${domain}`,
            name: slug,
            ownDomain:
              wildcard && [slug, projectId].includes(wildcard.project) ? wildcard.hostname : null,
            emailContext: deps.context(EMAIL_PATH),
            caller: hopCaller(),
          },
          input,
        );
      },
    },
    // A bare `cd` handle's calls are this context's resolver's, at the fixed point (so a jail's
    // `itx ⇒ null` masks none of them): the one dispatch path, its hop and where each call runs.
    cd: (contextPath: string) => {
      // WHO crosses with the call is captured when the handle is MADE: a handle held by loaded code
      // and called later runs as that code, never as whoever holds the store then — stamped with the
      // context it originated at, so a relative path means the caller's (`repos.get('./x')`
      // answered at the root is the caller's `./x`). Its delivery authority and cause are the
      // call's, read as each call is made (`callContext`).
      const made = deps.caller();
      return new InvokeHandle((steps) => {
        const now = deps.caller();
        return deps.invokeAs(
          {
            ...made,
            path: made.path || path,
            delivery: now.delivery,
            cause: now.cause || made.cause,
          },
          ["itx", "builtins", ["cd", contextPath], ...steps],
        );
      });
    },
    fetch: (request: Request) => deps.egress(request),
    ...deps.library, // THE LIBRARY (library.ts), built by the context that holds this scope
  } satisfies Pick<
    BuiltInScope,
    "kv" | "r2" | "ai" | "browser" | "cfArtifacts" | "email" | "cd" | "fetch" | keyof LibraryRoots
  >;
}

/** `itx.workers`: stateless loaded code, loaded where the call is and speaking for the context
 *  `iterateContextName` names — its loader identity, its `env.ITX` (`itxEntrypoint`), the producer
 *  of a source expression run as its loaded code (`invoke`). A context builds it for itself (the
 *  record above), and for another context whose rules a call resolved through
 *  (itx-expression-rewriting.ts `ItxExpressionResolver#route`): the code loads here, with that context's
 *  authority, and no call reaches that context to run it.
 *
 *  A genuine InvokeHandle so `workers.get(spec).run()` pipelines over every transport
 *  (workerd#6873). A terminal `fetch(request)` is this same call: `entrypoint.fetch(request)` IS the
 *  entrypoint's fetch channel, socket-bearing Responses included (context/rpc-stubs.ts doctrine,
 *  point 4). Re-resolves per call; the loader caches by key, so a warm isolate is reused and a
 *  producer expression never re-runs. */
export function workersRoot(deps: {
  env: { LOADER: WorkerLoader; ITX_KV: KVNamespace };
  deployId: string;
  projectId: string;
  path: string;
  iterateContextName: string;
  platformOrigin: () => string | null;
  itxEntrypoint: () => Fetcher;
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** Who makes the call: what a loaded worker's `fetch` reads off its Request. */
  caller: () => Caller;
  /** The delivery authority of the call being made (caller.ts `Caller.delivery`), read as it is
   *  made: a context's Durable Object's ambient caller's; the stateless entrypoint has none. */
  delivery: () => string | undefined;
  /** The cause of the call being made, which the worker's code runs under (cause.ts). */
  cause: () => Cause | undefined;
  /** The worker a source expression with no cacheKey NAMES, resolved from the context `workers`
   *  speaks for, as a facet's is (facet-host.ts `FacetHostDeps.namedWorker`). */
  namedWorker: (source: ItxExpressionInput) => Promise<NamedWorker>;
}): BuiltInScope["workers"] {
  const { projectId, path, iterateContextName } = deps;
  return {
    get: (spec: Parameters<BuiltInScope["workers"]["get"]>[0]) =>
      new InvokeHandle(async (methodSteps) => {
        const [call] = methodSteps;
        if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] === "")
          throw new Error(
            `workers.get(spec).${print(methodSteps)}: a WorkerEntrypoint exposes flat methods`,
          );
        const [method, ...callArgs] = call;
        // Workers RPC reaches both on every loaded entrypoint (iterate src/sdk/loaded-worker.ts).
        if (method === "callWithCause" || method === "getItx")
          throw codedError("NOT_A_METHOD", `workers.get(spec).${method}: no caller reaches it`);
        // The cause reaches the loaded code (cause.ts) on the Request, or through `callWithCause`,
        // which every other method is called through. A loaded worker's `fetch` reads who is
        // asking off its Request (iterate/principal): the call's own caller, stamped here — never
        // what the Request says, which `fetch(url, { headers })` would let the code that called it
        // write.
        const cause = deps.cause();
        const args =
          method === "fetch" ? [callerStampedRequest(callArgs, deps.caller(), cause)] : callArgs;
        // A handler's one-event hooks are the delivery loop's to call, as a subscriber's
        // `deliverEvent` is (an IterateConfigEntrypoint's `processEvent` among them).
        if (method === "deliverEvent" || method === "processEvent")
          await assertDeliveryCaller(
            deps.delivery(),
            `workers.get(spec).${method}`,
            JSON.stringify(args[0]),
          );
        // Loaded code runs only inside a project (first-party-facet-placement.ts rule 6) —
        // refused before a source expression runs or anything loads.
        assertLoadedCodePlacement("workers.get", { projectId, path });
        // A source expression with no cacheKey NAMES a worker (iterate/api `workers.get`): the code
        // that rule's spec loads, `mainModule` under its published identity — resolved as the call
        // is, so the call after a publication runs the new code.
        const named = namesAWorker(spec) ? await deps.namedWorker(spec.source) : undefined;
        const worker = named
          ? { ...namedWorkerLoad(named, spec.mainModule, "workers.get"), invoke: named.invoke }
          : { source: spec.source, cacheKey: spec.cacheKey, invoke: deps.invoke };
        // WORKAROUND for the Worker Loader defect `isLoadedWorkerPlatformFailure` names: a cached
        // entry that meets it answers it to every call under that loader id, and `itx.abort()`
        // does not change the id. A call that meets it retires the identity, so the next call
        // loads fresh under the next generation; THIS call is replayed on it once only when a
        // replay cannot do anything twice: a GET or HEAD with no body. A request body may have
        // been read and an RPC method may have run, so those are not replayed. A call the defect
        // failed and nothing replayed, or whose replay it failed too, is the platform's failure:
        // UNAVAILABLE, `disconnected`, which the edge answers 503 with a Retry-After.
        const unavailableNow = (failure: Error) =>
          unavailableError("disconnected", `workers.get(spec).${method}: ${failure.message}`);
        let loaderId: string | undefined;
        const attempt = async () => {
          const prepared = await prepareConfinedWorker({
            env: deps.env,
            deployId: deps.deployId,
            platformOrigin: deps.platformOrigin(),
            itxEntrypoint: deps.itxEntrypoint(),
            kind: "worker",
            owner: iterateContextName,
            source: worker.source,
            cacheKey: worker.cacheKey,
            mainModule: spec.mainModule,
            moduleIdentity: worker.moduleIdentity,
            invoke: worker.invoke,
            where: "workers.get",
          });
          const { load, retire } = prepared;
          loaderId = prepared.loaderId;
          try {
            const entrypoint = load().getEntrypoint(
              spec.className,
              spec.props === undefined ? undefined : { props: spec.props },
              // A loaded entrypoint's methods are the author's; `fn` is checked to be one below.
            ) as Fetcher & Record<string, (...a: unknown[]) => Promise<unknown>>;
            const fn = entrypoint[method];
            if (typeof fn !== "function")
              throw new Error(`workers.get(spec): the entrypoint has no method "${method}"`);
            const called =
              method === "fetch" || !cause
                ? Reflect.apply(fn, entrypoint, args)
                : entrypoint.callWithCause!(cause, [[method, ...args]]);
            if (method !== "deliverEvent") return await called;
            // A handler's own refusal — a name it called that nothing resolves, a verb it may
            // not call — is its event's failure, retried on that event's ladder: never the
            // row's, which those codes dangle or halt (subscription-delivery.ts `#fanOutFailed`).
            return await called.catch((error: unknown) => {
              const code = errorCode(error);
              if (code && TARGET_FAILURE_CODES.has(code))
                throw new Error(error instanceof Error ? error.message : String(error));
              throw error;
            });
          } catch (error) {
            if (isLoadedWorkerPlatformFailure(error)) retire();
            throw error;
          }
        };
        try {
          return await attempt();
        } catch (error) {
          if (!isLoadedWorkerPlatformFailure(error)) throw error;
          const request = method === "fetch" && args[0] instanceof Request ? args[0] : undefined;
          const replayable =
            request && !request.body && (request.method === "GET" || request.method === "HEAD");
          console.warn({
            event: replayable
              ? "workers.platform-failure-retry"
              : "workers.platform-failure-retire",
            namespace: "iterate-context",
            name: iterateContextName,
            method,
            requestMethod: request?.method,
            loaderId,
            message: error.message,
          });
          if (!replayable) throw unavailableNow(error);
          return await attempt().catch((failure: unknown) => {
            throw isLoadedWorkerPlatformFailure(failure) ? unavailableNow(failure) : failure;
          });
        }
      }),
  };
}

/** `fetch`'s arguments — a Request, or a URL and its init — as one Request whose caller stamps are
 *  `caller`'s identity alone and the call's `cause`, our mark, which the SDK runs its `fetch` under
 *  (rpc-stubs.ts `stampCallerHeaders`), with no expression, and — for loaded code, never the edge —
 *  no routing slug: the host a request arrived on is the edge's word (worker.ts). */
function callerStampedRequest(
  [input, init]: unknown[],
  caller: Caller,
  cause: Cause | undefined,
): Request {
  // `fetch`'s own two arguments, as the Fetch standard types them: the constructor checks them.
  const request = new Request(input as RequestInfo, init as RequestInit | undefined);
  const headers = new Headers(request.headers);
  stampCallerHeaders(headers, { principal: caller.principal, grant: caller.grant, cause });
  if (caller.app) headers.delete(ITERATE_ROUTING_SLUG_HEADER);
  return new Request(request, { headers });
}

/** ONE CALL TO ANOTHER CONTEXT, where it lives: `expression` on the context's Durable Object under
 *  `caller`, which resolves it with its live table. Its delivery authority (caller.ts
 *  `Caller.delivery`) is the CALL's, read from `delivery` as each call is made — this one and each
 *  on a handle it answers — never the one `caller` carried: the delivery loop evaluates a target
 *  without it and reuses the handle. A call whose terminal step is `fetch(request)`
 *  rides the context's native fetch with the expression in `x-itx-expression` — a socket-bearing
 *  Response crosses a native fetch, never Workers RPC (context/rpc-stubs.ts doctrine, point 4). A
 *  Request that cannot do anything twice — a GET or HEAD with no body, never an upgrade — that a
 *  deploy's reset or a lost connection failed is sent once more, to the context's fresh incarnation
 *  on a fresh stub; anything else fails, and an expression fetch answers a platform failure 503
 *  (iterate-context-durable-object.ts). A handle the context answers with (by expression,
 *  dispatch.ts) becomes one of this caller's own, so a handle held here is one whole call per verb,
 *  never a session held open. The context is acquired PER CALL (`contextOf`): a stub that saw a
 *  reset replays it on every later call (Cloudflare's Durable Object error handling). */
export function callContext(
  contextOf: () => Pick<ReachableContext, "fetch" | "invoke">,
  expression: ItxExpression,
  args: unknown[],
  caller: Caller,
  path: string,
  delivery?: () => string | undefined,
): Promise<unknown> {
  const { delivery: _made, ...made } = caller;
  const callerNow = (): Caller => {
    const now = delivery?.();
    return now ? { ...made, delivery: now } : made;
  };
  const terminalFetch = terminalFetchOf(expression, args);
  if (terminalFetch) {
    const headers = new Headers(terminalFetch.request.headers);
    stampCallerHeaders(headers, made);
    headers.set(ITX_EXPRESSION_FETCH_HEADER, encodeFetchExpression(terminalFetch.steps));
    const request = new Request(terminalFetch.request, { headers });
    return retryPlatformFailures(() => contextOf().fetch(request), {
      area: "cd",
      schedule: ONCE_NOW,
      idempotent:
        !request.body &&
        (request.method === "GET" || request.method === "HEAD") &&
        !request.headers.has("upgrade"),
      kind: failureKind,
      describe: () => ({ name: "fetch", path }),
    });
  }
  return Promise.resolve(contextOf().invoke(expression, args, callerNow())).then((result) =>
    materializeItxHandleReference(result, (handleExpression) =>
      contextOf().invoke(handleExpression, [], callerNow()),
    ),
  );
}
