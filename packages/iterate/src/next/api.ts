import type { Ai } from "@cloudflare/workers-types";
// next/api.ts — THE API AN APP DIALS: the shapes of os-next's `/api` root, the session it vends and a
// context's surface, as a capnweb client sees them. DECLARED here, never generated, and never the
// platform's classes: os-next asserts that `IterateRpcTarget` satisfies `IterateApi` and that
// `IterateContextRpcTarget` satisfies `IterateContextApi` (src/session.ts, src/iterate-context.ts),
// so an app built against this package types against exactly what the deployment answers. A context
// has ONE method — `invoke(call, ...args)`, a dotted itx expression — and a capnweb stub proxies the
// dotted spelling (`itx.repos.get(path).readFile(file)`) onto it; the roots declared below are the
// ones the SDK and the first-party facets spell, with the platform's own signatures (context/built-ins.ts).
import type { FacetHandle, InvokeHandle, ItxExpressionInput } from "./expression.ts";
import type { ConsentScope } from "./oauth-scopes.ts";
import type { Principal } from "./principal.ts";
import type { IngressRouting } from "./project-ingress.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";

/** What `authenticate` accepts: the browser (its login cookie rode the upgrade), a device or script
 *  (its bearer token did — or, on a socket opened bare, presented here as `token`: a static page on
 *  another origin cannot put a header on a WebSocket), or the operator (the deployment's admin
 *  secret, verified in-band). */
export type SessionCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer"; token?: string }
  | { type: "admin-secret"; secret: string; as?: { email: string } };

/** One page of a context's durable log (`readEvents`). */
export interface StreamPage {
  events: StreamEvent[];
  scannedThroughOffset: number;
  /** True iff the scan reached the durable mark: nothing more to read until the next commit. */
  atHead: boolean;
}

/** `waitForEvent`'s filter: an event type (or one of a list), a floor, a timeout. */
export type WaitForEventFilter = {
  type?: string | string[];
  afterOffset?: number;
  timeoutMs?: number;
};

/** The `rewrite-rule-configured` event's payload — what `provide` takes, what `itx.append` writes
 *  durably: make `match` mean `target` (an expression, or `null` to deny). `description` is the one
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
  /** Set when this row hosts a facet (a processor). `restarts`: how many times the platform failed
   *  the facet at its start and the context restarted it under a fresh loaded identity (a platform
   *  defect the context works around; the count is the cheap way to ask "how often, here"). */
  hostedFacet?: { name: string; className: string; cacheKey?: string; restarts: number };
};

/** A loaded worker's source: its modules, literally, or an itx expression that produces them (then
 *  `cacheKey` names the build, and the caller owns "same key ⇒ same code"). */
export type WorkerSource = Record<string, string> | ItxExpressionInput;

/** What hosts a class as a durable facet — `facets.get(name, spec)`, `processors.enable(name, spec)`. */
export type FacetSpec = { source: WorkerSource; cacheKey?: string; className: string };

/** What `schedules.set` answers: the definition's identity, to cancel exactly it. */
export type ScheduleReceipt = { key: string; scheduledAtOffset: number };

/** A secret's material: one string (`getSecret("/secrets/<name>")` is the whole value) or a JSON
 *  object whose string fields `getSecret("/secrets/<name>", { field: "a.b" })` picks — the
 *  multidimensional shape a credential exchange needs (`{ username, password, accessToken }`,
 *  `{ clientId, clientSecret, refreshToken, accessToken }`). A JSON STRING still works as an object
 *  (`set(name, JSON.stringify({...}))`). */
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
   *  GitHub, an MCP server's authorization server, the petshop fixture. */
  | { kind: "oauth-refresh-token"; tokenEndpoint: string; clientAuth?: ClientAuth }
  /** The username/password → session-token archetype's one instance so far, Waitrose's login: POST
   *  the Android app's `NewSession` GraphQL mutation with `username`/`password` from the material →
   *  `accessToken`. Waitrose has no refresh grant — re-login IS the refresh — so one strategy covers
   *  the first-use mint and the 401 re-mint. Vendor-specific on purpose: a caller-supplied login
   *  template would put an arbitrary request body in trusted code; a second vendor of this shape
   *  earns the generalization, not before. */
  | { kind: "waitrose-session"; graphqlUrl: string };

/** A secret's catalog entry — `secrets.list()` — its path, the pin, the strategy's KIND and when
 *  it was first set; never a value (the owner root's fold of the `secret/set` certificates). */
export type SecretCatalogEntry = {
  path: string;
  urls: string[];
  refresh?: SecretRefresh["kind"];
  createdAt: string;
};

/** The input an agent gives `itx.secrets.collectFromUser`: the write-only secret path, the
 * origins its material may reach, and the short explanation the authenticated collection form
 * shows its user. */
export type CollectSecretInput = {
  path: string;
  egress: { urls: string[] };
  description?: string;
};

/** A secret collection link. Sending this asks the person to authenticate to the intended
 * Iterate instance; it is not itself permission to write a secret. */
export type CollectSecretLink = { path: string; url: string };

/** A context (a project, a user, an organization): every `itx` root, reached through `invoke`. */

export interface IterateContextApi {
  invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
  /** Another context of this project, by path (`..` and `/` allowed; the global namespace is not). */
  cd(path: string): IterateContextApi;
  /** Durable batches appended after a deadline (`afterMs`), at an instant (`at`) or on an interval
   *  (`everyMs`); a key set again is replaced; a receipt cancels exactly the definition it names. */
  schedules: {
    set(
      input: {
        key: string | [string, string];
        when: { at: string } | { afterMs: number } | { everyMs: number };
        events: StreamEventInput[];
      },
      options?: { idempotencyKey?: string },
    ): Promise<ScheduleReceipt>;
    cancel(schedule: string | [string, string] | ScheduleReceipt): Promise<StreamEvent[]>;
  };
  whoami():
    | { projectId: string; path: string; projectSlug?: string; projectUrl?: string }
    | Promise<{ projectId: string; path: string; projectSlug?: string; projectUrl?: string }>;
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
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
      options: { urls: string[]; refresh?: SecretRefresh },
    ): Promise<{ path: string }>;
    delete(path: string): Promise<{ path: string }>;
    list(): Promise<SecretCatalogEntry[]>;
    /** Build the authenticated Dash link where a person enters a value an agent must never see in
     * chat. The link fixes the project, platform instance, secret path and egress pin. If called
     * from an agent context, a successful submission messages that same agent with the path only. */
    collectFromUser(input: CollectSecretInput): Promise<CollectSecretLink>;
  };
  /** The table this context resolves against, described — the tree a model reads. `list()` follows a
   *  bare hop row into the context it names (a Durable Object hop, hence async). */
  rewriteRules: {
    list(): Promise<RewriteRuleListEntry[]>;
    get(match: string): Promise<RewriteRuleListEntry | null>;
    resolve(call: ItxExpressionInput): string[];
  };
  facets: { get(name: string, spec?: FacetSpec): FacetHandle };
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };
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
    get(spec: {
      source: WorkerSource;
      cacheKey?: string;
      className?: string;
      props?: unknown;
    }): InvokeHandle;
  };
  /** A subscription: a pure itx expression, or a live callback lent to the registry (what live state
   *  uses); `null` removes the row. The handle's dispose removes it too. */
  subscribe(input: {
    name?: string;
    target: ItxExpressionInput | ((events: unknown[], range: unknown) => void) | null;
    consumes?: string[];
    afterOffset?: number;
  }): Promise<{ [Symbol.dispose](): void }>;
  /** A rewrite rule of this context, session-scoped (the handle's dispose removes it): the event's
   *  payload `{ match, target, description? }`, or the shorthand `(match, target)`. `target` is an
   *  expression, or null to deny. The durable spelling is the same payload through `itx.append`. */
  provide(input: RewriteRuleConfigured): Promise<{ [Symbol.dispose](): void }>;
  provide(
    match: ItxExpressionInput,
    // Expressions, null, or live RPC references (RpcTarget / callable), serialized by capnweb.
    target: unknown,
  ): Promise<{ [Symbol.dispose](): void }>;
  /** A script — the text of `async (itx) => { … }` — run once against this context, on its log:
   *  `context/run-requested` under the caller, the context's runner, `run-settled` (JSON in, JSON
   *  out); resolves with the result or rejects with the settlement's error. Never re-run. A script
   *  still running ten minutes after it started is settled failed (`failureKind: "deadline"`). */
  run(script: string): Promise<unknown>;
  /** The project's repos, workspaces and agents as domain objects — one shape each: `get(path)` is
   *  the entity's facet on the context at `path` (its verbs, plus the typed `append` on that
   *  context), `list()` the project catalog, `create(path)` the creation saga on that path (the
   *  parent link the caller's context writes first, then the processor row, the request, the
   *  terminal fact — created, or create-failed thrown), `delete(path)` the deletion saga (the
   *  request, `deleted` cross-posted to `/`, the row disabled). A relative `path` means the caller's. */
  repos: {
    get(path: string): InvokeHandle;
    list(): Promise<{ path: string; createdAt: string }[]>;
    create(path: string): Promise<{ path: string }>;
    delete(path: string): Promise<{ path: string }>;
  };
  workspaces: {
    get(path: string): InvokeHandle;
    list(): Promise<{ path: string; createdAt: string }[]>;
    create(path: string): Promise<{ path: string }>;
    delete(path: string): Promise<{ path: string }>;
  };
  /** Workers AI under this context's capability rules. */
  ai: Ai;
  /** Files stored in the project's object store. */
  files: {
    get(path: string): InvokeHandle & {
      put(input: {
        contentType?: string;
        data: Uint8Array | ArrayBuffer | string;
      }): Promise<{ path: string; contentType: string; size: number }>;
      bytes(): Promise<Uint8Array>;
      head(): Promise<{ path: string; contentType: string; size: number } | null>;
      delete(): Promise<void>;
      url(input?: {
        method?: "GET" | "PUT";
        expiresInSeconds?: number;
      }): Promise<{ url: string; expiresAt: string }>;
    };
    list(prefix?: string): Promise<{ path: string; contentType: string; size: number }[]>;
  };
}

/** One OAuth grant as `grants.list()` shows it: a session, a connected app, a minted token. */
export interface GrantRecord {
  id: string;
  clientId?: string;
  logoUri?: string;
  clientDomain?: string;
  name: string;
  kind: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  cleanupPending: boolean;
  expired: boolean;
  /** The grant this very session rides on. */
  current?: boolean;
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
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** An organization as the session lists it: its minted id, its free-text name, the person's role
 *  in it, and how many projects it holds (every one of them, not only those this grant lists). */
export interface OrgRecord {
  id: string;
  name: string;
  role?: string;
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
  };
  /** The organizations this session reaches. */
  orgs(): Promise<OrgRecord[]>;
  /** A new organization — `organizations:write`; the person is its owner. */
  createOrg(name: string): Promise<OrgRecord>;
  /** Rename an organization the person owns — `organizations:write`. */
  updateOrg(orgId: string, input: { name: string }): Promise<OrgRecord>;
  /** Delete an organization the person owns, while it holds no project — `organizations:write`. */
  deleteOrg(orgId: string): Promise<void>;
  /** OAuth grants this session may manage (a signed-in person's): list, end, mint one for a device. */
  grants: {
    list(cursor?: string): Promise<{
      items: GrantRecord[];
      cursor?: string;
      projects: ProjectRecord[];
      canMintToken: boolean;
    }>;
    end(grantId: string): Promise<unknown>;
    endCurrent(): Promise<unknown>;
    mint(input: unknown): Promise<{ token: string; expiresAt: number }>;
  };
  /** The consent screen's methods (the OAuth authorize flow): describe a request, approve it. */
  consent: {
    describe(query: string): Promise<ConsentAnswer>;
    approve(input: {
      query: string;
      projects: string[];
    }): Promise<{ redirectTo: string } | { error: string }>;
  };
  projects: {
    list(): Promise<ProjectRecord[]>;
    /** the project's root context, by its slug or its id */
    get(project: string): Promise<IterateContextApi>;
    /** Config repository presets available on this platform. */
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
  };
  organizations: { get(orgId: string): Promise<IterateContextApi> };
  user: IterateContextApi;
  logout(): unknown;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. */
export interface IterateApi {
  authenticate(credentials: SessionCredentials): Promise<IterateSessionApi>;
}
