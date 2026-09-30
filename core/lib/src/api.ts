// api.ts — THE API AN APP DIALS: the shapes of core/os's `/api` root, the session it vends and a
// context's surface, as a capnweb client sees them. DECLARED here, never generated, and never the
// platform's classes: in core/os `IterateRpcTarget implements IterateApi` and
// `IterateContextRpcTarget implements IterateContextApi` (src/session.ts, src/iterate-context.ts),
// so an app built against this package types against exactly what the deployment answers. A context
// has ONE method — `invoke(call, ...args)`, a dotted itx expression — and a capnweb stub proxies the
// dotted spelling (`itx.repos.get(path).readFile(file)`) onto it. THIS FILE IS THE SOURCE OF TRUTH
// for every root app code reaches: core/os derives its built-in record's type from these members
// (context/built-ins.ts `BuiltInScope`, library.ts `LibraryRoots`), so a root or a verb the platform
// implements and this file does not declare — or declares differently — fails to typecheck there.
// The roots installed apps add are NOT here: each app registers its own on `InstalledAppRoots` from
// its package, and `IterateContextApiWith` spells a context that has them.

import type { Ai, R2HTTPMetadata, R2Range } from "@cloudflare/workers-types";
import type { InvokeHandle, ItxExpression, ItxExpressionInput } from "./expression.ts";
import type { ConsentScope } from "./oauth-scopes.ts";
import type { Principal } from "./principal.ts";
import type { IngressRouting } from "./project-ingress.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";

/** What `authenticate` accepts: the browser (its login cookie rode the upgrade), a device or script
 *  (its bearer `token`, always presented here: a static page on another origin cannot put a header
 *  on a WebSocket), or the operator (the deployment's admin secret, verified in-band). */
export type SessionCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer"; token: string }
  | { type: "admin-secret"; secret: string; as?: { email: string } };

/** One page of a context's durable log (`readEvents`). */
export interface StreamPage {
  events: StreamEvent[];
  scannedThroughOffset: number;
  /** True iff the scan reached the durable mark: nothing more to read until the next commit. */
  atHead: boolean;
}

/** `waitForEvent`'s filter: an event type (or one of a list), payload fields the event must carry
 *  with exactly these values (each a JSON primitive, compared with `===`), a floor, a timeout. With
 *  an explicit `afterOffset` the log after it is searched first, so a match that already landed
 *  answers at once. */
export type WaitForEventFilter = {
  type?: string | string[];
  payload?: Record<string, string | number | boolean | null>;
  afterOffset?: number;
  timeoutMs?: number;
};

/** The `rewrite-rule-configured` event's payload — what `itx.append` writes durably and `provide`
 *  writes for its session: make `match` mean `target` (an expression, or `null` to deny). `description` is the one
 *  line a model reads for the name; it rides the row into `rewriteRules.list()`. */
export type RewriteRuleConfigured = {
  match: ItxExpressionInput;
  target: ItxExpressionInput | null;
  /** What the name means here, in one line (≤ 500 chars). */
  description?: string;
};

/** One row of `rewriteRules.list()` — the tree a context can spell. `context` is the path the row
 *  was read from: this context for its own rows and its implicit rows, the target context for the
 *  rows a bare hop row (`itx ⇒ itx.builtins.cd(path)`) reaches. A mask lists as `target: null`. */
export type RewriteRuleListEntry = {
  match: string;
  target: string | null;
  description?: string;
  context: string;
};

/** One row of `subscriptions.list()` / `processors.list()`. */
export type SubscriptionListEntry = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  afterOffset?: number;
  /** `false`: a FAN-OUT row — one event per call, in any order, each event retried on its own and
   *  dead-lettered alone (`itx/subscription-delivery-failed`). Its `cursor` is how far it has
   *  admitted events, `pending` how many events wait for a retry, and `paused` whether new events
   *  wait for the receiver (it failed the last few distinct events: one new event is let through at
   *  each rung of the row's own probe). */
  ordered?: false;
  pending?: number;
  paused?: boolean;
  /** Set when this row hosts a facet (a processor). `restarts`: how many times the platform failed
   *  the facet at its start and the context restarted it under a fresh loaded identity (a platform
   *  defect the context works around; the count is the cheap way to ask "how often, here"). */
  hostedFacet?: {
    name: string;
    className: string;
    cacheKey?: string;
    mainModule?: string;
    /** The worker's name when the source is one (`FacetSpec`): any other source is not listed. */
    source?: unknown;
    restarts: number;
  };
  /** Set for a row the context delivers at-least-once (an itx expression target; a facet and a lent
   *  stub own their progress): the offset the last acked call confirmed, the retry ladder's attempt
   *  and when the next attempt is due. */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  /** Set once delivery exhausted its retries: the offset it stopped after, and why. */
  halted?: { afterOffset: number; attempts: number; error?: string };
};

/** A loaded worker's source: its modules, literally, or an itx expression that produces them (then
 *  `cacheKey` names the build, and the caller owns "same key ⇒ same code"). */
export type WorkerSource = Record<string, string> | ItxExpressionInput;

/** What hosts a class as a durable facet — `facets.get(name, spec)`, `processors.enable(name, spec)`.
 *  `source` is the code (its modules, or an expression that produces them under `cacheKey`), or —
 *  an expression with NO `cacheKey` — the NAME of a loaded worker: one that resolves, as a call
 *  would, to `itx.builtins.workers.get(spec)` in the table of the context whose rule it is
 *  (`itx.cd('/').config`, the project's published config). The facet loads that worker's source,
 *  its producer run with that context's authority. `mainModule` names the module of the source that
 *  exports `className` when it is not the source's entry (`agents.ts` of a config repo whose entry
 *  is `worker.ts`): the facet runs that module's own graph, and — named by the project's published
 *  config — restarts in place, storage kept, only when that module's identity changes, never onto
 *  an older publication. */
export type FacetSpec = {
  source: WorkerSource;
  cacheKey?: string;
  className: string;
  mainModule?: string;
};

/** What `schedules.set` answers: the definition's identity, to cancel exactly it. */
export type ScheduleReceipt = { key: string; scheduledAtOffset: number };

/** A schedule's key: a string, or a pair that scopes a local key to its owner (a facet instance). */
export type ScheduleKey = string | [string, string];

/** When a schedule fires: at an instant (ISO, with offset), after a delay, or on an interval (at
 *  least a second; missed ticks coalesce). */
export type ScheduleWhen = { at: string } | { afterMs: number } | { everyMs: number };

/** What `schedules.set` takes: the key, when, and the events (one to a hundred) each occurrence
 *  appends — an event's type, payload and metadata only: identity and provenance are the firing's. */
export type ScheduledAppendInput = {
  key: ScheduleKey;
  when: ScheduleWhen;
  events: Pick<StreamEventInput, "type" | "payload" | "metadata">[];
};

/** One live schedule as `schedules.list()` / `get(key)` answer it: the definition (its key
 *  normalized to a string), when it fires next, the offset of the fact that set it, who set it, and
 *  the last failure until it is replaced or cancelled. */
export type ScheduledAppend = {
  key: string;
  when: ScheduleWhen;
  events: Pick<StreamEventInput, "type" | "payload" | "metadata">[];
  nextAt: string;
  scheduledAtOffset: number;
  source?: StreamEventInput["source"];
  failure?: { error: string; offset: number };
};

/** A secret's material: one string (`getSecret("/secrets/<name>")` is the whole value) or a JSON
 *  object whose string fields `getSecret("/secrets/<name>", { field: "a.b" })` picks — the
 *  multidimensional shape a credential exchange needs (`{ username, password, accessToken }`,
 *  `{ clientId, clientSecret, refreshToken, accessToken }`). A string is always the one value: it has
 *  no fields, whether or not it parses as JSON. */
export type SecretMaterial = string | Record<string, unknown>;

/** How a token endpoint wants the client credential — the RFC 8414 `token_endpoint_auth_methods_supported`
 *  registry values, so a provider's discovery document pastes straight in: `client_secret_basic`
 *  (HTTP Basic — Google, Slack, the petshop; the default), `client_secret_post` (`client_id` +
 *  `client_secret` as form fields — GitHub, Linear), `none` (a public client: `client_id` alone,
 *  PKCE stands in for the secret). RFC 6749 §2.3.1 forbids sending two forms at once. */
export type ClientAuth = "client_secret_basic" | "client_secret_post" | "none";

/** How the secret's facet re-mints an expired credential, in its own trusted code: the
 *  exchange reads this secret's own material, POSTs to an endpoint within the pin, and writes the
 *  answer back into the material — `accessToken` (and a rotated `refreshToken`). Triggered on a 401
 *  from the pinned host, and on first use when the placeholder's field is not there yet. */
export type SecretRefresh =
  /** RFC 6749 §6, the refresh_token grant: `refreshToken` + `clientId` (+ `clientSecret` for a
   *  confidential client) from the material → `accessToken` (+ the newest `refreshToken`). Google,
   *  GitHub, an MCP server's authorization server, the petshop fixture. With `client`, the client is
   *  the deployment's own app at the provider (an integration connected through it): the material
   *  holds the tokens alone, and the refresh attaches the client's credentials inside the facet. */
  | {
      kind: "oauth-refresh-token";
      tokenEndpoint: string;
      clientAuth?: ClientAuth;
      client?: { platform: IntegrationProvider };
    }
  /** A GitHub App installation's token (`POST <apiOrigin>/app/installations/<id>/access_tokens`
   *  with an App JWT) → `accessToken`, minted on first use and on a 401. The App is the deployment's
   *  (`{ platform: "github" }`, minted only for an installation the control plane routes to this
   *  project) or the project's own, whose `appId` and `privateKey` the material holds
   *  (`{ project: "github" }`). */
  | {
      kind: "github-app-installation";
      apiOrigin: string;
      installationId: string;
      client: { platform: "github" } | { project: "github" };
    }
  /** EXCHANGE CODE: `source` is one ES module exporting `async function exchange(material, fetch)`,
   *  which logs in (any vendor's shape: a CSRF form and its cookie, a GraphQL mutation) and returns
   *  the NEXT material — keep what the next login needs (`{ ...material, accessToken }`). It runs
   *  only on first use and on a 401, in a jail the secret's facet loads: no bindings, `fetch` (the
   *  argument and the global alike) reaches the secret's pinned origins and nothing else — a
   *  request anywhere else fails the refresh — and `console` is silenced. Only the returned object
   *  is kept. The source is part of the record, so changing it is a `set` like the material's. */
  | { kind: "worker"; source: string };

/** A secret's catalog entry — `secrets.list()` — its path, the pin, the strategy's KIND and when
 *  it was first set; never a value (the owner root's fold of the `secret/set` certificates). */
export type SecretCatalogEntry = {
  path: string;
  urls: string[];
  refresh?: SecretRefresh["kind"];
  /** For exchange code (`refresh.kind` "worker"): the SHA-256 of its source, hex — which code it is. */
  refreshSourceSha256?: string;
  createdAt: string;
  /** A path that forwards every use to a secret elsewhere: a person's account connected to this
   *  project (`integrations.connect(provider, { account })`), or the deployment's own secret its
   *  operator lent (`itx.secrets.lend`) — whose, under which lend, and the connection it is. */
  borrowed?: {
    lendId: string;
    lender: { userId: string; email?: string } | { instance: true };
    integration?: { provider: string; account: string; externalId: string };
  };
  /** A lender's secret's live lends, by lend id: the project (or `every-project`) and the path it
   *  is lent as. */
  lends?: Record<string, { to: string; as: string; since: string }>;
};

/** The input an agent gives `itx.secrets.collectFromUser`: the write-only secret path, the
 * origins its material may reach, what the collection page shows the person, and, for a secret of
 * several parts, one field each. `description` is markdown: say where the value comes from, with
 * links (they open in a new tab). */
export type CollectSecretInput = {
  path: string;
  egress: { urls: string[] };
  description?: string;
  /** One input per field, saved as one JSON secret `{ [name]: value }`, whose parts are then
   *  `getSecret(path, { field: name })`: an OAuth app's `clientSecret` (which `beginOAuth` takes as
   *  a placeholder), a webhook's `signingSecret`. Without it, one Value. */
  fields?: CollectSecretField[];
};

/** One part of a secret a collection page asks for: its name in the JSON secret
 *  (`[A-Za-z_][A-Za-z0-9_]*`), the label the person reads, and whether its value is several lines
 *  (a PEM private key). */
export type CollectSecretField = { name: string; label: string; multiline?: boolean };

/** A secret collection link. Sending this asks the person to authenticate to the intended
 * Iterate instance; it is not itself permission to write a secret. */
export type CollectSecretLink = { path: string; url: string };

/** What `secrets.verifyHmac(path, input)` checks: the bytes the provider signed (a string is its
 *  UTF-8 bytes), the hex HMAC-SHA256 it sent (either case, the scheme's prefix — `sha256=`, `v0=` —
 *  stripped), and which field of a JSON material is the key (the whole material when omitted).
 *  Stripe signs `${t}.${body}`, GitHub the body, Slack `v0:${t}:${body}`: the caller assembles them. */
export type SecretHmacVerification = {
  payload: string | Uint8Array;
  signature: string;
  field?: string;
};

/** What `secrets.verifyEquals(path, input)` checks: the candidate string a request presented (a
 *  static header token, say), and which field of a JSON material is the secret (the whole
 *  material when omitted). */
export type SecretEqualsVerification = {
  value: string;
  field?: string;
};

/** EVERY PROVIDER AN INTEGRATION CONNECTS, spelled once: a connection to one is the log
 *  `/integrations/<provider>/<connection>` and the secret `/secrets/<provider>-<connection>`. The
 *  kinds below are read off it. */
export const INTEGRATION_PROVIDERS = ["slack", "google", "cloudflare", "github", "x"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** Each provider's name as a person reads it, wherever a page or a message names one. */
export const INTEGRATION_PROVIDER_NAMES = {
  slack: "Slack",
  google: "Google",
  cloudflare: "Cloudflare",
  github: "GitHub",
  x: "X",
} as const satisfies Record<IntegrationProvider, string>;

/** The providers an integration connects through OAuth (`/api/integrations/<provider>/callback`):
 *  GitHub's connect is its App's install instead. */
export type OAuthIntegrationProvider = Exclude<IntegrationProvider, "github">;

/** The providers a person signs in with, each through iterate's app there. */
export type SignInProvider = Exclude<IntegrationProvider, "slack" | "x">;

/** Whose OAuth app a secret's `beginOAuth` goes through: the deployment's (`platform`) or the
 *  project's own registered for that provider (`project`). */
export type SecretOAuthClient =
  | { platform: OAuthIntegrationProvider }
  | { project: OAuthIntegrationProvider };

/** What `secrets.beginOAuth(path, options)` takes: the provider's two endpoints, the OAuth client
 *  (the project's own in the clear, or an integration's `client`), the scope, the pin, and any extra
 *  authorize parameters the provider needs (Google: `access_type=offline`, `prompt=consent`). */
export type SecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Exactly one of `clientId` and `client`. */
  clientId?: string;
  /** Absent for a public client (PKCE alone), and with `client`. The secret itself, or one
   *  placeholder naming the secret that holds it — `getSecret("/secrets/<name>")`, or
   *  `getSecret("/secrets/<name>", { field: "a.b" })` — so it never passes through your hands:
   *  collect it with `collectFromUser` into a secret pinned to the token endpoint's origin. The
   *  platform reads it from there at the code exchange and at every refresh, and stores only the
   *  placeholder, so rotating that secret takes effect at the next refresh. `beginOAuth` refuses
   *  a placeholder that names no such secret. */
  clientSecret?: string;
  client?: SecretOAuthClient;
  /** An absolute URL on the platform's origin or the Dash's. */
  next?: string;
  /** How the token endpoint wants the client credential. */
  clientAuth?: ClientAuth;
  scope?: string;
  /** The origins the tokens may be sent to; defaults to the token endpoint's, which it must include. */
  urls?: string[];
  extra?: Record<string, string>;
  /** The account the tokens must be for — an existing connection's, asked for more: the provider's
   *  id for it (a Slack team, an OpenID `sub`), read off the token response. Another account's
   *  tokens are refused before anything is stored. */
  expectAccount?: string;
};

/** How a lend to every project went, project by project: how many borrow it, the projects that
 *  keep a secret of their own at its path, and the ones whose borrow failed. */
export type EveryProjectBorrows = {
  borrowed: number;
  kept: string[];
  failed: { projectId: string; error: string }[];
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

/** A Browser Run quick-action name (`browser.quickAction`'s first argument): what to extract from
 *  the rendered page — content, screenshot, PDF, markdown, accessibility snapshot, scraped elements,
 *  structured JSON, links, or a crawl. */
export type CfBrowserQuickAction =
  | "content"
  | "screenshot"
  | "pdf"
  | "markdown"
  | "snapshot"
  | "scrape"
  | "json"
  | "links"
  | "crawl";

/** Options for a Browser Run quick action: the target page as a `url` or as inline `html`, plus the
 *  action's own pass-through options (e.g. `screenshotOptions`). */
export type CfBrowserQuickActionOptions = Record<string, unknown> &
  ({ url: string } | { html: string });

/** `itx.browser`: Cloudflare Browser Run — the raw CDP `fetch`, and `quickAction`, which answers the
 *  action's RESULT (a string, parsed JSON, or bytes for a screenshot or a PDF), not the binding's
 *  `{ success, result }` envelope; a failed action throws. */
export type CfBrowserApi = {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  quickAction(action: CfBrowserQuickAction, options: CfBrowserQuickActionOptions): Promise<unknown>;
};

/** A token for an Artifacts repo's git remote. */
export interface ArtifactToken {
  plaintext: string;
  expiresAt?: string;
}

/** `itx.cfArtifacts.get(path)`: the repo's handle — a token for its remote, and the remote's
 *  git-over-HTTPS URL. A repo that does not exist fails at these, with the binding's own error. */
export interface CfArtifactRepoApi {
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken>;
  remote(): Promise<string>;
}

/** `itx.cfArtifacts`: Cloudflare Artifacts, project-scoped and addressed BY THE REPO'S PATH — the
 *  binding's own verbs. `repos` is the friendlier surface. */
export interface CfArtifactsApi {
  /** The Artifacts repo, `main` unborn until the first commit; false when it already existed. */
  create(path: string): Promise<{ created: boolean }>;
  get(path: string): Promise<CfArtifactRepoApi>;
  /** This project's repos, as paths (one page). */
  list(options?: { limit?: number; cursor?: string }): Promise<{
    repos: { path: string }[];
    cursor?: string;
  }>;
  /** True when the repo existed; false when it was already gone. */
  delete(path: string): Promise<boolean>;
}

/** `connectToMcp`'s options: headers every request carries (`getSecret(…)` placeholders substitute
 *  at egress). */
export type McpConnectOptions = { headers?: Record<string, string> };

/** An MCP server's answer to `initialize`: its protocol version, capabilities, name and version. */
export type McpServerInfo = {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
};

/** One tool as an MCP server's `tools/list` describes it. */
export type McpTool = { name: string; description?: string; inputSchema?: unknown };

/** `itx.connectToMcp(url)`: an MCP server over Streamable HTTP. Besides these, the connection has
 *  one method per tool whose name is a legal identifier (reached by dotted spelling, untyped here);
 *  `callTool` reaches every tool. */
export interface McpConnectionApi {
  serverInfo(): McpServerInfo;
  listTools(): Promise<McpTool[]>;
  /** The result's `structuredContent`, else its text content JSON-parsed when it parses, else the
   *  text; an `isError` result throws with that text. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** `connectToOpenApi`'s options: the base URL requests go to (default: the document's first
 *  server), and headers every request carries. */
export type OpenApiConnectOptions = { baseUrl?: string; headers?: Record<string, string> };

/** An OpenAPI 3 document — only `openapi`, `servers` and `paths` are read. */
export type OpenApiDocument = {
  openapi: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
};

/** One operation an OpenAPI connection grew a method for. */
export type OpenApiOperation = {
  operationId: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; in: string; required?: boolean }>;
  hasRequestBody: boolean;
  summary?: string;
};

/** `itx.connectToOpenApi(specOrUrl)`: an OpenAPI 3 service. Besides these, one method per
 *  `operationId` (dotted spelling, untyped here), each taking one input object. */
export interface OpenApiConnectionApi {
  operations(): OpenApiOperation[];
  /** The input object's fields become path, query and header parameters, the rest the JSON body;
   *  the answer is JSON when the response says so, else its text. */
  call(operationId: string, input?: Record<string, unknown>): Promise<unknown>;
}

/** `connectToCapnweb`'s options: headers for the session's requests, and the transport — a
 *  WebSocket session (default) or one HTTP batch per chain. */
export type CapnwebConnectOptions = {
  headers?: Record<string, string>;
  transport?: "websocket" | "batch";
};

/** `itx.connectToCapnweb(url)`: a remote capnweb API's main object as a pipelinable handle (its
 *  methods are the remote's, untyped here), and `close()` for the session (the next call reopens). */
export type CapnwebConnectionApi = InvokeHandle & { close(): void };

/** A stored file as `itx.files` answers it: its path, content type and size. */
export type FileRecord = { path: string; contentType: string; size: number };

/** `itx.files.get(path)`: a file's verbs. `put`'s string data is base64 or a `data:` URL; `url` is
 *  a signed URL on the project host that downloads (`GET`, the default) or uploads (`PUT`) it. */
export type FileHandle = {
  put(input: {
    contentType?: string;
    data: Uint8Array | ArrayBuffer | string;
  }): Promise<FileRecord>;
  bytes(): Promise<Uint8Array>;
  head(): Promise<FileRecord | null>;
  delete(): Promise<void>;
  url(input?: {
    method?: "GET" | "PUT";
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }>;
};

/** `itx.email.send`: one message from the project's own address. `inReplyToOffset` names a
 *  message on the project's `/integrations/email` and answers it in its thread: its recipients,
 *  `Re:` subject and threading headers are the defaults. Each attachment is a project file
 *  (`itx.files`). */
export type EmailSendInput = {
  /** The project's own address by default (a reply's: the address the answered message reached);
   *  the project that owns the deployment's project wildcard domain may name any address there
   *  (`hello@iterate.com`). Any other address is refused. */
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  inReplyToOffset?: number;
  attachments?: { path: string; filename?: string }[];
};

/** WHICH requests a fetch route takes — every field given must hold. A fetch route matches an HTTP
 *  request: `url` is a standard `URLPattern` over the real URL (hostname and path; its init's
 *  fields, each a pattern string), `headers` exact values. `routingSlug` is a convenience, the one
 *  address component both ingress modes can express: paths routing shares one host, so it is the
 *  `/projects/<project>/<routingSlug>` segment; subdomains make it `<routingSlug>--<project>` or
 *  `<routingSlug>.<custom hostname>`. Without paths routing it could go, and a route would match
 *  its hostname directly (`url: { hostname: "here.tunnels.templestein.com" }`). `{}` takes every
 *  request. */
export type FetchRouteRequestMatcher = {
  routingSlug?: string;
  url?: {
    protocol?: string;
    username?: string;
    password?: string;
    hostname?: string;
    port?: string;
    pathname?: string;
    search?: string;
    hash?: string;
    baseURL?: string;
  };
  headers?: Record<string, string>;
};

/** A route as `itx.fetchRoutes.set(name, route)` takes it: the requests it takes, the itx
 *  expression they go to, who may use it (`project-members`: the config worker answers anyone else
 *  the sign-in challenge; absent or null: public) and its priority (higher first, then by name). */
export type FetchRouteInput = {
  requestMatcher: FetchRouteRequestMatcher;
  target: ItxExpressionInput;
  authRequirement?: { visitors: "project-members" } | null;
  priority?: number;
};

/** A live route as `list()` and `match` answer it, its target parsed, with the offset of the
 *  `itx/fetch-route-configured` fact that set it. */
export type FetchRouteEntry = {
  fetchRouteName: string;
  requestMatcher: FetchRouteRequestMatcher;
  target: ItxExpression;
  authRequirement: { visitors: "project-members" } | null;
  priority: number;
  configuredOffset: number;
};

/** One change a repo commit applies: a file's new content, or its deletion. */
export type RepoFileChange = { path: string; content: string } | { path: string; delete: true };
/** One commit as `log` lists it, newest first (`timestamp` is epoch milliseconds). */
export type RepoLogEntry = {
  oid: string;
  message: string;
  author: { name: string; email: string };
  /** who made the commit: `iterate` for every commit the platform makes, whoever wrote it */
  committer: { name: string; email: string };
  timestamp: number;
  parents: string[];
};
/** What a commit reports: the new tip (null on an unborn repo that stayed empty) and the paths it
 *  changed (none when the tree was already as asked). */
export type RepoCommitResult = { commitOid: string | null; changedPaths: string[] };
/** How a `pull` or `push` ended: `main` moved from `previousOid` to `commitOid` (`updated`), or both
 *  sides were already at `commitOid` (`up-to-date`). Pulling or pushing without `force` when neither
 *  side contains the other throws `NOT_FAST_FORWARD`, with `{ ours, theirs }` as its data. */
export type RepoSyncResult = {
  status: "updated" | "up-to-date";
  commitOid: string | null;
  previousOid: string | null;
};
/** `itx.repos.get(path)`: the repo's verbs, branch `main` only (the repo facet in core/os). A
 *  `commitOid` pins a read to that commit; without one, a read is of the tip. */
export type RepoHandle = InvokeHandle & {
  tip(): Promise<string | null>;
  readFile(path: string, options?: { commitOid: string }): Promise<string | null>;
  /** The repo as a loaded worker's source: every file, or with `dir` those under that folder. */
  modules(options?: { commitOid?: string; dir?: string }): Promise<Record<string, string>>;
  listFiles(): Promise<{ commitOid: string | null; paths: string[] }>;
  commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<RepoCommitResult>;
  writeFile(path: string, content: string): Promise<RepoCommitResult>;
  log(options?: { limit?: number }): Promise<RepoLogEntry[]>;
  /** The one remote the repo remembers, as git's `origin`: a git URL over HTTP(S) whose userinfo may
   *  hold a secret placeholder (`https://x-access-token:getSecret("/secrets/github-acme", { field:
   *  "accessToken" })@github.com/acme/config.git`, the placeholder percent-encoded or not), never a
   *  token; null when none. */
  origin(): Promise<string | null>;
  /** Remember `url` as origin, or forget it (`null`): a `repo/origin-set` fact on the repo's log. */
  setOrigin(url: string | null): Promise<{ origin: string | null }>;
  /** Bring the remote's `main` into this repo, the same commits and oids, fast-forward only unless
   *  `force` (which resets `main` to the remote's). A pull that moves `main` lands
   *  `repo/commit-completed` like a commit, so `/repos/config` publishes. `remote` defaults to origin. */
  pull(options?: { remote?: string; force?: boolean }): Promise<RepoSyncResult>;
  /** Send this repo's `main` to the remote's `main`, fast-forward only unless `force` (which
   *  overwrites the remote's). `remote` defaults to origin. */
  push(options?: { remote?: string; force?: boolean }): Promise<RepoSyncResult>;
  /** Append the repo's own events on its context; its lifecycle facts are the collection's. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
};

/** One overlay entry as a workspace's `gitStatus` reports it, against its mount at HEAD. */
export type WorkspaceChange = { path: string; change: "added" | "deleted" | "modified" };
/** One mount as `gitStatus` reports it: its path, its repo, and the overlay's changes under it. */
export type WorkspaceMountStatus = { path: string; repo: string; changes: WorkspaceChange[] };
/** `itx.workspaces.get(path)`: a private overlay over the project's repos, each repo mounted at its
 *  path (the workspace facet in core/os). Reads see the overlay, then the mounted repo's tip. */
export type WorkspaceHandle = InvokeHandle & {
  mounts(): Promise<Record<string, { repo: string }>>;
  /** The overlay's copy (a deletion reads null), else the mounted repo's file at its tip. */
  readFile(path: string): Promise<string | null>;
  /** The mounted repo's file at its tip whatever the overlay says. */
  readBase(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /** False when the path was not a file of the merged view. */
  deleteFile(path: string): Promise<boolean>;
  /** Drop the overlay's entry at `path`. */
  revert(path: string): Promise<void>;
  listAllFiles(): Promise<string[]>;
  gitStatus(): Promise<{ mounts: WorkspaceMountStatus[]; unmounted: WorkspaceChange[] }>;
  /** Commit the overlay's changes under one mount (`scope`, needed when several are dirty). */
  gitCommit(input: {
    message: string;
    scope?: string;
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string | null; mount: string; repo: string; changedPaths: string[] }>;
  gitLog(input?: { scope?: string; limit?: number }): Promise<RepoLogEntry[]>;
  /** Append the workspace's own events on its context; its lifecycle facts are the collection's. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
};

/** An entity collection root (`itx.repos`, `itx.workspaces`): `get(path)` the entity's handle,
 *  `list()` the project catalog, `create(path)` the creation saga on that path (the parent link the
 *  caller's context writes first, then the processor row, the request, the terminal fact — created,
 *  or create-failed thrown), `delete(path)` the deletion saga (the request, `deleted` cross-posted to
 *  `/`, the row disabled). A relative `path` means the caller's. `get` and `list` reach the whole
 *  project; `create` and `delete` only paths strictly beneath the caller's context (FORBIDDEN). */
export type EntityCollectionApi<Handle> = {
  get(path: string): Handle;
  list(): Promise<{ path: string; createdAt: string }[]>;
  create(path: string): Promise<{ path: string }>;
  delete(path: string): Promise<{ path: string }>;
};

/** The roots an installable app adds by rewrite rule — present only on a context whose table has
 *  the rule (a project that installed the app), so never part of `IterateContextApi` itself. An
 *  installed app publishes its root by augmenting this interface from its own package
 *  (`declare module "iterate/api" { interface InstalledAppRoots { myApp: MyAppApi } }`), so a root
 *  the platform does not ship is never named here; a caller imports that module to spell
 *  `IterateContextApiWith<"myApp">`. */
export interface InstalledAppRoots {}

/** A context whose project installed the named apps: with the app's package imported,
 *  `IterateContextApiWith<"myApp">` spells `itx.myApp`. Code that holds a plain scope asserts it
 *  (`itx as IterateContextApiWith<"myApp">`) where it knows the app is installed. */
export type IterateContextApiWith<App extends keyof InstalledAppRoots> = IterateContextApi &
  Pick<InstalledAppRoots, App>;

/** A context (a project, a user, an organization): every `itx` root, reached through `invoke`. */
export interface IterateContextApi {
  invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
  /** Another context of this project, by path (`..` and `/` allowed; the global namespace is not). */
  cd(path: string): IterateContextApi;
  /** Durable batches appended after a deadline (`afterMs`), at an instant (`at`) or on an interval
   *  (`everyMs`); a key set again is replaced, but an interval set again as it stands keeps its
   *  clock (a failed one is revived); a receipt cancels exactly the definition it names. */
  schedules: {
    set(
      input: ScheduledAppendInput,
      options?: { idempotencyKey?: string },
    ): Promise<ScheduleReceipt>;
    cancel(schedule: ScheduleKey | ScheduleReceipt): Promise<StreamEvent[]>;
    list(): ScheduledAppend[];
    get(key: ScheduleKey): ScheduledAppend | null;
  };
  whoami():
    | { projectId: string; path: string; projectSlug?: string; projectUrl?: string }
    | Promise<{ projectId: string; path: string; projectSlug?: string; projectUrl?: string }>;
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** This project's public URL over HTTP: the apex, or a routing slug's host (`blog--<project>`, or
   *  `blog.<primary hostname>` once the project has a primary hostname),
   *  at `path`. Only from a session, which carries the origin to compose it with. */
  url(target?: { routingSlug?: string; path?: string }): Promise<string>;
  /** RESET this context (Cloudflare's `ctx.abort`): its Durable Object drops everything it holds in
   *  memory and the next call starts a fresh incarnation from durable storage. Resolves with the
   *  `events.iterate.com/itx/aborted { reason?, callerPath?, app? }` event it recorded — durable
   *  and attributed to the caller before anything resets — and the reset follows the answer.
   *  SURVIVES: the log and everything derived from it (rewrite rules, subscriptions, schedules),
   *  every facet's storage, kv. GOES: in-memory state, every facet instance and its in-flight work,
   *  every socket on the context (a provider's re-dials), and every other call in flight there — it
   *  rejects with the reset's message (`itx.abort() reset the context <path>: <reason>`). A handle
   *  you kept names its target by expression, so its next call reaches the new incarnation.
   *  Another context of the project: `itx.cd(path).abort()`. A rewrite rule masks it like any name
   *  (`provide("itx.abort", null)`). */
  abort(reason?: string): Promise<StreamEvent>;
  readEvents(
    afterOffset?: number,
    limit?: number,
    options?: { includeEphemeral?: boolean },
  ): Promise<StreamPage>;
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
  fetch(request: Request): Promise<Response>;
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  /** The object store: the R2 binding's own verbs on the owner's slice of one bucket (every key
   *  prefixed, the prefix stripped from every key answered); what cannot cross the wire is answered
   *  as data — an `R2Object` as its fields, a body as its bytes. `list` is one page with its cursor.
   *  `presign` is a signed URL on the project host, a download or an upload. `files` is the
   *  friendlier surface. */
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
  /** The project's secrets, WRITE-ONLY: a secret IS its path (`/secrets/<name>`, the name
   *  `[a-zA-Z0-9._-]+`), and the path is what an outbound request's placeholder spells —
   *  `getSecret("/secrets/<name>")` in a URL or a header substitutes to the value at egress, and only
   *  towards the ORIGINS in `urls` (required: a secret is always pinned). `set` stores a string or a
   *  JSON object (`refresh` names the strategy that re-mints an expiring credential); `delete`
   *  forgets it (re-settable); `list` is the catalog — paths, pins, strategy kinds, when first set —
   *  never a value. Every change is one fact on the secret's path (`secret/set`, `secret/deleted`),
   *  attributed to the caller and cross-posted to the root, so the log says who set what and when. */
  secrets: {
    set(
      path: string,
      material: SecretMaterial,
      /** `merge`: the material's fields go over the ones already stored, whose pin must be `urls`
       *  (a strategy added to a secret someone else filled — a project's own GitHub App's). */
      options: { urls: string[]; refresh?: SecretRefresh; merge?: boolean },
    ): Promise<{ path: string }>;
    /** OAuth's first tokens: the provider's authorize URL to send a human to. The provider
     *  redirects them to the platform's callback (they must be signed in as someone who reaches the
     *  secret's owner), the secret's facet exchanges the code, `secret/set` lands, and the callback
     *  redirects to `next`. Only from a session, which carries the platform's origin. `nonce`
     *  names this attempt (the callback's signed `state` carries it); a later `beginOAuth` on the
     *  same path replaces it. */
    beginOAuth(
      path: string,
      options: SecretOAuthOptions,
    ): Promise<{ authorizationUrl: string; nonce: string }>;
    delete(path: string): Promise<{ path: string }>;
    list(): Promise<SecretCatalogEntry[]>;
    /** Build the authenticated Dash link (`/collect-secret/<slug>`, a page of its own) where a
     * person enters a value an agent must never see in chat. The link fixes the project, platform
     * instance, secret path and egress pin, and shows `description` as the requester's words. If
     * called from an agent context, a successful submission messages that same agent with the path
     * only. */
    collectFromUser(input: CollectSecretInput): Promise<CollectSecretLink>;
    /** A webhook's signature checked against a secret WITHOUT revealing it: one bit back,
     *  constant-time, run in the secret's facet. A secret never set (or a material with no key at
     *  the field) answers false, never a description. */
    verifyHmac(path: string, input: SecretHmacVerification): Promise<boolean>;
    /** A presented string compared with a secret WITHOUT revealing it, for a credential a caller can
     *  only send as it is (a webhook's static header token): one bit back, constant-time, run in the
     *  secret's facet. A secret never set (or no string at the field) answers false. A replayable
     *  token stays replayable: prefer `verifyHmac` wherever the sender signs. */
    verifyEquals(path: string, input: SecretEqualsVerification): Promise<boolean>;
    /** The operator's, on the global root (`session.global`): lend the deployment's own secret to
     *  a project, as the project's path `as`, or `to: "every-project"`: every project, one created
     *  later included, borrows it unless its path holds a secret of its own. The project's uses are
     *  forwarded to this secret, and the material never leaves it. `revokeLend` ends it; so does a
     *  project deleting its path, for that project alone. (A person's account reaches a project
     *  through `integrations.connect(provider, { account })` instead.) */
    lend(
      path: string,
      input: { to: string; as: string },
    ): Promise<{ lendId: string; everyProject?: EveryProjectBorrows }>;
    revokeLend(path: string, lendId: string): Promise<{ lendId: string }>;
  };
  /** Connect and disconnect this context's owner — a project (its root), or a person
   *  (`session.user`) — and a provider. `connect` answers where to send the human (and the
   *  connection's name; again for one that exists asks for more `scopes` on the same account):
   *  through the deployment's app, or with `client: "project"` through the project's own, whose
   *  credentials `/secrets/<provider>-<connection>` already holds (a GitHub App's also needs its
   *  `appSlug` and `clientId`). GitHub's `installationId` connects an installation the App already
   *  has, without GitHub's configure page. On a project, `account` connects one of YOUR accounts
   *  instead — the address the provider gives it, as `session.user`'s `state.integrations` lists
   *  it: with no `authorizationUrl` when it already holds what the project asks for, else one that
   *  asks the provider to add it. The project then uses it as `/secrets/<provider>-<connection>`
   *  while it stays connected and you stay a member. `disconnect` revokes the token where the
   *  provider allows and removes the connection, its secret and its webhook route; an account of
   *  yours disconnected from a project stays yours. `requestFromUser` answers a Dash link asking
   *  the signed-in person to connect the provider to this project. */
  integrations: {
    connect(
      provider: IntegrationProvider,
      options?:
        | {
            scopes?: string[];
            next?: string;
            connection?: string;
            client?: "iterate";
            installationId?: string;
            appSlug?: never;
            clientId?: never;
            account?: never;
          }
        | {
            scopes?: string[];
            next?: string;
            connection: string;
            client: "project";
            appSlug?: string;
            clientId?: string;
            installationId?: string;
            account?: never;
          }
        | {
            scopes?: string[];
            next?: string;
            account: string;
            connection?: never;
            client?: never;
            appSlug?: never;
            clientId?: never;
            installationId?: never;
          },
    ): Promise<{ authorizationUrl?: string; connection: string }>;
    disconnect(provider: IntegrationProvider, connection: string): Promise<void>;
    requestFromUser(
      provider: IntegrationProvider,
      options?: { scopes?: string[] },
    ): Promise<{ url: string }>;
  };
  /** The project's fetch routes, on its root `/`: which itx expression, the route's `target`, a
   *  request on its hosts goes to. `set` appends one `itx/fetch-route-configured` fact (`null`
   *  deletes the route); `match` answers the route a request takes. The platform serves a request a
   *  route takes from `route.target` (a WebSocket upgrade included), before the config worker's
   *  fetch; a write answers once no host is served from the routes before it. */
  fetchRoutes: {
    set(fetchRouteName: string, route: FetchRouteInput | null): Promise<{ fetchRouteName: string }>;
    list(): Promise<FetchRouteEntry[]>;
    match(request: {
      url: string;
      headers: Headers | Record<string, string> | [string, string][];
    }): Promise<FetchRouteEntry | null>;
  };
  /** The table this context resolves against, described — the tree a model reads. `list()` follows a
   *  bare hop row into the context it names (a Durable Object hop, hence async). */
  rewriteRules: {
    /** `depth`: how many bare hop rows to follow (default: all). */
    list(depth?: number): Promise<RewriteRuleListEntry[]>;
    get(match: string): Promise<RewriteRuleListEntry | null>;
    resolve(call: ItxExpressionInput): string[];
  };
  /** A facet of this context: a caller reaches only what its class lists in `static publicMethods`
   *  (sdk/index.ts `FacetDurableObject`); anything else is refused FORBIDDEN. */
  facets: {
    /** The facet `name` — addressed when it is running (a processor, a named instance), loaded and
     *  hosted from `spec` otherwise. `Facet` types its methods for the caller
     *  (`facets.get<{ snapshot(): Promise<Snapshot> }>("x").snapshot()`): an UNCHECKED assertion,
     *  like a cast — nothing verifies the hosted class has them, so name the facet's own published
     *  type where there is one. A capnweb `RpcStub` of this interface erases the type parameter:
     *  there, cast the handle instead. */
    get<Facet = unknown>(name: string, spec?: FacetSpec): InvokeHandle & Facet;
    /** RESET one facet of this context, from the context that hosts it — any facet, whether or not
     *  it extends the SDK's host, including one that would never answer a call. Its instance and
     *  in-memory state go, and every call in flight on it rejects `FACET_ABORTED`; its storage
     *  stays, and its next call starts it fresh. The context itself is not reset. Resolves with the
     *  `events.iterate.com/itx/facet-aborted { name, reason?, callerPath?, app? }` event;
     *  `NO_FACET` for a name never hosted here. */
    abort(name: string, reason?: string): Promise<StreamEvent>;
  };
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };
  /** The rpc stubs lent to this context right now, by key (a live session's `provide`): `get(key)`
   *  one, as a handle over its transport (offline ⇒ RPC_STUB_OFFLINE at call time). */
  rpcStubs: { get(rpcStubKey: string): InvokeHandle; list(): string[] };
  processors: {
    enable(
      name: string,
      spec?: (FacetSpec & { consumes?: string[] }) | { consumes?: string[] },
    ): Promise<{ name: string }>;
    disable(name: string): Promise<void>;
    list(): SubscriptionListEntry[];
    /** A hosted processor's claim on this context's alarm: "revive me by `at`" (a facet with a
     *  `runInBackground` attempt in flight), or `null` to release it. */
    claim(name: string, at: number | null): Promise<void>;
  };
  workers: {
    /** A stateless worker loaded from `spec`: `mainModule` loads that module of the source as its
     *  entry in place of package.json's `main`. `source` is as `FacetSpec`'s: an expression with no
     *  `cacheKey` is the NAME of a loaded worker (`itx.cd('/').config`), whose code each call loads,
     *  `mainModule` as the project's publication of it recorded it. */
    get(spec: {
      source: WorkerSource;
      cacheKey?: string;
      mainModule?: string;
      className?: string;
      props?: unknown;
    }): InvokeHandle;
  };
  /** HTTP WEBHOOKS, the target of a fan-out row that sends each event to another server, Stripe's
   *  way: `webhooks.get({ url, signingSecret? }).deliverEvent` POSTs the event as JSON from this
   *  context through its own `itx.fetch` (a context that may not fetch sends nothing), with
   *  `iterate-event-id: <projectId><path>@<offset>` (repeats share it) and, given a signing secret (a secret
   *  path pinned to `url`'s origin), `iterate-timestamp` and `iterate-signature: v1=<hex
   *  HMAC-SHA256 of "<timestamp>.<body>">`. A 2xx acks; any other status retries on the event's own
   *  ladder (~44 h); a 410 halts the row until a resume. `deliverEvent` is the delivery loop's call
   *  alone. A signature vouches for the PROJECT, not a context: a receiver checks the body's `path`,
   *  and loaded code names a signing secret only at the project's root. */
  webhooks: {
    get(spec: { url: string; signingSecret?: string }): InvokeHandle;
  };
  /** A subscription: a pure itx expression, or a live callback lent to the registry (what live state
   *  uses); `null` removes the row. The handle's dispose removes it too. */
  subscribe(input: {
    name?: string;
    target: ItxExpressionInput | ((events: unknown[], range: unknown) => void) | null;
    consumes?: string[];
    afterOffset?: number;
    /** `false`: FAN-OUT delivery — one event per call (`deliverEvent(event)`), in any order, each
     *  retried and dead-lettered on its own. Absent: the ordered queue, the one that may take a
     *  dead letter (`itx/subscription-delivery-failed`): alert on dead letters from an ordered row. */
    ordered?: false;
  }): Promise<{ [Symbol.dispose](): void }>;
  /** A rewrite rule of this context, session-scoped (the handle's dispose removes it): make `match`
   *  mean `target`, an expression, a live stub, or null to deny. `description` is the one line a
   *  model reads for the name. `fetchRoute` (a live stub, on the project's root) is a fetch route to
   *  `match` that lives exactly as long as the lend: set with it, set again when the platform
   *  re-attaches it, removed when it ends however it ends. A live stub's handle answers
   *  `lendEnded()` with why the lend ended — it can end while the session lives (the platform lost
   *  its pager). The durable spelling is the rule's event (`RewriteRuleConfigured`) through
   *  `itx.append`. */
  provide(
    match: ItxExpressionInput,
    // Expressions, null, or live RPC references (RpcTarget / callable), serialized by capnweb.
    target: unknown,
    options?: {
      description?: string;
      fetchRoute?: Omit<FetchRouteInput, "target"> & { fetchRouteName: string };
    },
  ): Promise<{ [Symbol.dispose](): void; lendEnded(): Promise<string> }>;
  /** A script — the text of `async (itx) => { … }` — run once against this context, on its log:
   *  `itx/run-requested` under the caller, the context's runner, `run-settled` (JSON in, JSON
   *  out); resolves with the result or rejects with the settlement's error. Never re-run. A script
   *  still running ten minutes after it started is settled failed (`failureKind: "deadline"`). */
  run(script: string): Promise<unknown>;
  /** The project's repos and workspaces as domain objects — one shape each: `get(path)` is
   *  the entity's facet on the context at `path` (its verbs, plus the typed `append` on that
   *  context), `list()` the project catalog, `create(path)` the creation saga on that path (the
   *  parent link the caller's context writes first, then the processor row, the request, the
   *  terminal fact — created, or create-failed thrown), `delete(path)` the deletion saga (the
   *  request, `deleted` cross-posted to `/`, the row disabled). A relative `path` means the caller's. */
  repos: EntityCollectionApi<RepoHandle>;
  workspaces: EntityCollectionApi<WorkspaceHandle>;
  /** Workers AI's `run(model, inputs, options?)` and `models()`, under this context's capability
   *  rules. */
  ai: Pick<Ai, "run" | "models">;
  /** Cloudflare Browser Run. */
  browser: CfBrowserApi;
  /** Cloudflare Artifacts, project-scoped (`repos` is the friendlier surface). */
  cfArtifacts: CfArtifactsApi;
  /** Files stored in the project's object store, by path (`r2` underneath). */
  files: {
    get(path: string): InvokeHandle & FileHandle;
    list(prefix?: string): Promise<FileRecord[]>;
  };
  /** The project's email, `<slug>@iterate.app` (core/os/src/email/contract.ts has its events and
   *  threads). `send` answers the `email/sent` event. */
  email: {
    send(input: EmailSendInput): Promise<StreamEvent>;
  };
  /** An MCP server over Streamable HTTP, through this context's egress. */
  connectToMcp(url: string, options?: McpConnectOptions): Promise<McpConnectionApi>;
  /** An OpenAPI 3 service from its document or the URL of one, through this context's egress. */
  connectToOpenApi(
    specOrUrl: string | OpenApiDocument,
    options?: OpenApiConnectOptions,
  ): Promise<OpenApiConnectionApi>;
  /** A remote capnweb API's main object — a WebSocket session through egress (default) or one
   *  HTTP batch per chain (`{ transport: "batch" }`). */
  connectToCapnweb(url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnectionApi>;
}

/** What a grant is: a sign-in not yet exchanged, a device's key, a personal access token, or a
 *  browser or app session. A client labels it for display. */
export type GrantKind = "pending" | "device" | "personal" | "session";

/** One grant as `grants.list()` shows it: a session or a connected app (an OAuth grant), or a
 *  personal access token or a device's key (the account's own API key, `pat_…`). */
export interface GrantRecord {
  id: string;
  clientId?: string;
  logoUri?: string;
  clientDomain?: string;
  name: string;
  kind: GrantKind;
  /** An OAuth grant's one resource: Cap'n Web at `/api` (and the projects' hosts), or `/mcp`. A
   *  personal access token has none: it works at `/api`, at `/mcp` and on its projects' hosts. */
  resource?: "api" | "mcp";
  /** A personal access token's projects, by id: all it reaches. */
  projects?: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  expired: boolean;
  /** The grant this very session rides on. */
  current?: boolean;
  /** A personal access token's: the grant of the session that minted it (listed here while it
   *  lives). */
  mintedBy?: string;
  /** A platform admin's sign-in as this person: the admin's email. */
  impersonatedBy?: string;
}

/** What the consent screen shows for an authorization request. */
export type ConsentAnswer =
  | {
      kind: "consent";
      query: string;
      clientName: string;
      email: string;
      projects: ProjectRecord[];
      orgs: OrgRecord[];
      projectBound: boolean;
      /** the scopes the request asked for, each with the page's copy (oauth-scopes.ts) */
      scopes: ConsentScope[];
      denyLocation: string;
      /** how projects are reached over HTTP (project-ingress.ts) — the page composes a project's URL */
      ingressRouting: IngressRouting;
      /** the onboarding step's first draft of an organization name, from the person's name or email */
      suggestedOrganizationName: string;
    }
  | {
      /** a client asking only who the person is (the platform's `/oauth2/userinfo` resource) */
      kind: "identify";
      clientName: string;
      clientId: string;
      email: string;
      denyLocation: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** An organization's invitation link as its owners see it (`expiresAt` ISO). */
export interface InvitationRecord {
  id: string;
  orgId: string;
  role: "owner" | "member";
  emailHint: string | null;
  expiresAt: string;
}

/** An organization as the session lists it: its minted id, its free-text name, the person's role
 *  in it, and how many projects it holds (every one of them, not only those this grant lists). */
export interface OrgRecord {
  id: string;
  name: string;
  role?: "owner" | "member";
  projects: number;
}

/** A project as the catalog lists it: addressed by `id` everywhere (`projects.get`, a grant's list,
 *  an MCP call's `project`, an app's URL); `slug` is the label of its hostnames and its name to a
 *  person. The id is the one stable identifier. */
export interface ProjectRecord {
  id: string;
  slug: string;
  orgId: string;
}

/** The session `authenticate` vends: who is calling, and the contexts they reach. */
export interface IterateSessionApi {
  whoami(): Principal;
  /** Safe bootstrap data for every app, regardless of which host serves it. */
  info(): {
    principal: Principal;
    scopes: string[];
    platformOrigin: string;
    /** how projects are reached over HTTP (project-ingress.ts `projectUrlOf`); null ⇒ no ingress */
    ingressRouting: IngressRouting;
    /** the MCP server's origin (the dash's connect page) — "" when this deployment serves none */
    mcpOrigin: string;
    /** the providers whose iterate app this deployment holds (APP_CONFIG `integrations`): a
     *  project connects through iterate's app only there, and brings its own app anywhere */
    iterateAppProviders: IntegrationProvider[];
    /** what iterate's app asks for there, by provider — what a project needs of your account before
     *  it uses it (`integrations.connect(provider, { account })`) */
    iterateAppScopes: Partial<Record<OAuthIntegrationProvider, string[]>>;
    /** the providers a person signs in with here: the ones a signed-in person can add to their
     *  account (the issuer's `/.auth/identity/<provider>?link=<userId>`) */
    signInProviders: SignInProvider[];
  };
  /** The grants this session may manage (a signed-in person's with the `account` scope): list and
   *  end its sessions and personal access tokens, and mint a personal access token — its bearer
   *  answered once, `expiresAt` null for a key that never expires. */
  grants: {
    list(cursor?: string): Promise<{
      items: GrantRecord[];
      cursor?: string;
      projects: ProjectRecord[];
      canMintToken: boolean;
    }>;
    end(grantId: string): Promise<unknown>;
    endCurrent(): Promise<unknown>;
    mint(input: {
      name: string;
      /** project ids, each one the person reaches */
      projects: string[];
      /** epoch ms; omitted, the key never expires */
      expiresAt?: number;
      /** a device's public client metadata document (Kit): the key is listed as that device */
      clientId?: string;
    }): Promise<{ id: string; token: string; expiresAt: number | null }>;
  };
  /** The consent screen's methods (the OAuth authorize flow): describe a request, approve it. */
  consent: {
    describe(query: string): Promise<ConsentAnswer>;
    approve(input: {
      query: string;
      projects: string[];
      /** a platform admin's "Sign in as someone else…": the person's user id */
      impersonate?: string;
    }): Promise<{ redirectTo: string } | { error: string }>;
  };
  projects: {
    /** oldest first (a grant bound to projects with no user: in the grant's order) */
    list(): Promise<ProjectRecord[]>;
    /** the project's root context, by its slug or its id */
    get(project: string): Promise<IterateContextApi>;
    /** Config repository presets available on this platform, besides the default config a
     *  creation that names no template gets. */
    templates(): Promise<{ label: string; reference: string }[]>;
    /** a new project: `project` is slugged into its hostname label, its id is minted — the returned
     *  context's `whoami()` says it, so does `list()` */
    create(input: {
      project: string;
      orgId?: string;
      configRepoTemplate?: string;
      /** Operator-only recovery: retain the source project identity from a project seed. */
      restoreProjectId?: string;
    }): Promise<IterateContextApi>;
    /** Delete a project, by its slug or its id — its organization's owner, or the operator; anyone
     *  else is refused (FORBIDDEN). Answers once nothing reaches the project any more (its row is
     *  gone, and its slug free); its contexts, hostnames and storage are destroyed after, by the
     *  deletion saga on its root. There is no undo. */
    delete(project: string): Promise<void>;
  };
  /** The organizations this session reaches — the person's memberships (a grant narrowed to
   *  projects sees only their organizations, unless it holds `organizations:write`): the rows, its
   *  members and open invitation links, the organization's context by membership, and the verbs
   *  (`organizations:write`; the person is the owner of what they create, and only an owner
   *  renames, deletes or changes members). The reads are the control plane's catalog, as it stands;
   *  each verb is a request it answers, a refusal a coded error (FORBIDDEN, INVALID_INPUT), and
   *  lands its facts on the organization's context (and a member's account) after. */
  organizations: {
    /** oldest first */
    list(): Promise<OrgRecord[]>;
    /** the organization's context — `session.user` for an organization — by membership: its
     *  activity, `events.iterate.com/organization/…` facts, and its own secrets */
    get(orgId: string): Promise<IterateContextApi>;
    /** the person is its owner; the operator names the owner (`ownerId`) */
    create(input: { name: string; ownerId?: string }): Promise<OrgRecord>;
    rename(orgId: string, input: { name: string }): Promise<OrgRecord>;
    /** only while it holds no project */
    delete(orgId: string): Promise<void>;
    addMember(orgId: string, input: { userId: string; role?: "owner" | "member" }): Promise<void>;
    removeMember(orgId: string, input: { userId: string }): Promise<void>;
    /** the members with their emails, by membership, in the order they joined: `createdAt` is
     *  when they joined (epoch ms) */
    members(
      orgId: string,
    ): Promise<{ userId: string; email: string; role: "owner" | "member"; createdAt: number }[]>;
    /** the invitation links still open (an expired one stays until revoked), oldest first — an
     *  owner's */
    invitations(orgId: string): Promise<InvitationRecord[]>;
    /** an owner's invitation link: whoever accepts it first joins in `role` (default member),
     *  until it expires (`expiresInDays`, default 7, 1–30). `token` is the link's secret, answered
     *  this once — the dash's `/invitations/<token>`. */
    createInvitation(
      orgId: string,
      input?: { role?: "owner" | "member"; emailHint?: string; expiresInDays?: number },
    ): Promise<InvitationRecord & { token: string }>;
    /** an owner withdraws an open link by its id */
    revokeInvitation(orgId: string, input: { invitationId: string }): Promise<void>;
    /** what a link opens, for the signed-in person holding it; null when it names nothing */
    invitation(token: string): Promise<
      | (InvitationRecord & {
          orgName: string;
          status: "pending" | "accepted" | "revoked" | "expired";
          /** the reader already belongs */
          member: boolean;
          /** the reader is the one who accepted it — accepting again answers the same and lands
           *  the membership's facts again */
          acceptedByYou: boolean;
        })
      | null
    >;
    /** join the organization a link opens, in its role — single use: the first person to accept
     *  consumes it (again by them answers the same; anyone after is refused INVALID_INPUT) */
    acceptInvitation(token: string): Promise<OrgRecord>;
  };
  user: IterateContextApi;
  /** The global namespace's root `/` — a platform admin's session (the `admin` scope) or the
   *  operator bearer's alone. Its `cd` reaches `/users/<id>…`, `/organizations/<id>…` and
   *  `/secrets/<name>…`, as a project root's reaches the project; its `secrets` are the deployment's
   *  own, which the operator lends to projects. */
  global: IterateContextApi;
  /** Every person on the platform — a platform admin's session (the `admin` scope) or the
   *  operator's alone. */
  users: {
    list(): Promise<{ id: string; email: string }[]>;
    /** by id or email */
    get(ref: string): Promise<{ id: string; email: string } | null>;
    /** find-or-create */
    create(input: { email: string }): Promise<{ id: string; email: string }>;
  };
  /** Every context Cloudflare lists, by id — the operator's alone (scripts/ci/context-sweep.ts):
   *  who each is, from its own birth record; its durable log a page at a time, as `readEvents`
   *  pages it, which the sweep backs an orphan up with; and an orphan's destruction (refused for a
   *  global context and for any project that still exists). Neither `identify` nor `readEvents`
   *  records a wake. */
  contexts: {
    identify(
      ids: string[],
    ): Promise<({ id: string; projectId: string; path: string } | { id: string; error: string })[]>;
    readEvents(id: string, afterOffset: number): Promise<StreamPage>;
    destroy(id: string): Promise<{ projectId: string; path: string }>;
  };
  /** One project secret's encrypted cell, as a project seed archives it — the operator's alone
   *  (scripts/os/project-seed.ts). */
  exportProjectSecretForSeed(project: string, path: string): Promise<unknown>;
  /** The version this edge runs and the one each named project's root context runs, at most eight
   *  — the operator's alone (scripts/os/preview-readiness.ts). */
  versions(projectIds: string[]): Promise<{ edge: string; contexts: string[] }>;
  logout(): unknown;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. */
export interface IterateApi {
  authenticate(credentials: SessionCredentials): Promise<IterateSessionApi>;
}
