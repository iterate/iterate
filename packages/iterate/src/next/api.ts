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

/** `waitForEvent`'s filter: an event type, a floor, a timeout. */
export type WaitForEventFilter = { type?: string; afterOffset?: number; timeoutMs?: number };

/** One row of `rewriteRules.list()`: a context row (`target` a string, or `null` for a mask) or a
 *  platform row. */
export type RewriteRuleListEntry = {
  match: string;
  target: string | null;
  origin: "platform" | "context";
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

/** A context (a project, a user, an organization): every `itx` root, reached through `invoke`. */
/** What `schedules.set` answers: the definition's identity, to cancel exactly it. */
export type ScheduleReceipt = { key: string; scheduledAtOffset: number };

export interface IterateContextApi {
  invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
  /** Another context of this project, by path (`..` and `/` allowed; the global namespace is not). */
  cd(path: string): IterateContextApi;
  /** The fixed point every call rewrites TO: the physical roots, never a rule's. */
  builtins: {
    append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
    readEvents(
      afterOffset?: number,
      limit?: number,
      options?: { includeEphemeral?: boolean },
    ): Promise<StreamPage>;
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
    /** A hosted processor's claim on this context's alarm: "revive me by `at`" (a facet with a
     *  `runInBackground` attempt in flight), or `null` to release it. */
    processors: { claim(name: string, at: number | null): Promise<void> };
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
  rewriteRules: {
    list(): RewriteRuleListEntry[];
    get(match: string): RewriteRuleListEntry | null;
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
  /** A rewrite rule of this context: `match` ⇒ `target` (an expression, or null for a mask). */
  provide(
    match: ItxExpressionInput,
    target: ItxExpressionInput | null,
  ): Promise<{ [Symbol.dispose](): void }>;
  /** A script — the text of `async (itx) => { … }` — run once against this context, on its log:
   *  `context/run-requested` under the caller, the context's runner, `run-settled` (JSON in, JSON
   *  out); resolves with the result or rejects with the settlement's error. Never re-run. */
  run(script: string): Promise<unknown>;
  /** The project's repos and workspaces as domain objects: a facet on the context at `path`. */
  repos: {
    get(path: string): InvokeHandle;
    list(): Promise<{ path: string; createdAt: string }[]>;
  };
  workspaces: {
    get(path: string): InvokeHandle;
    list(): Promise<{ path: string; createdAt: string }[]>;
  };
  /** The MCP connections born under the project, by grant: each connection's context path
   *  (`/mcp/inbound/<grantId>`, its transcript) and when it was born (the grant's first run). */
  mcpConnections: {
    list(): Promise<{ grantId: string; path: string; createdAt: string }[]>;
  };
}

/** One OAuth grant as `grants.list()` shows it: a session, a connected app, a minted token. */
export interface GrantRecord {
  id: string;
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
      projectHostnameBase: string;
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
    projectHostnameBase: string;
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
    /** a new project: `project` is slugged into its hostname label, its id is minted — the returned
     *  context's `whoami()` says it, so does `list()` */
    create(input: { project: string; orgId?: string }): Promise<IterateContextApi>;
  };
  organizations: { get(orgId: string): Promise<IterateContextApi> };
  user: IterateContextApi;
  logout(): unknown;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. */
export interface IterateApi {
  authenticate(credentials: SessionCredentials): Promise<IterateSessionApi>;
}
