// next/api.ts — THE API AN APP DIALS: the shapes of os-next's `/api` root, the session it vends and a
// context's surface, as a capnweb client sees them. DECLARED here, never generated, and never the
// platform's classes: os-next asserts that `IterateRpcTarget` satisfies `IterateApi` and that
// `IterateContextRpcTarget` satisfies `IterateContextApi` (src/session.ts, src/iterate-context.ts),
// so an app built against this package types against exactly what the deployment answers. A context
// has ONE method — `invoke(call, ...args)`, a dotted itx expression — and a capnweb stub proxies the
// dotted spelling (`itx.repos.get(path).readFile(file)`) onto it; the roots declared below are the
// ones the SDK and the first-party facets spell, with the platform's own signatures (context/built-ins.ts).
import type { FacetHandle, InvokeHandle, ItxExpressionInput } from "./expression.ts";
import type { Principal } from "./principal.ts";
import type { ScheduleReceipt, StreamEvent, StreamEventInput } from "./stream/processor.ts";

/** What `authenticate` accepts: the browser (its login cookie rode the upgrade), a device or script
 *  (its bearer token did), or the operator (the deployment's admin secret, verified in-band). */
export type SessionCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer" }
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
  hostedFacet?: { name: string; className: string; cacheKey?: string };
};

/** A loaded worker's source: its modules, literally, or an itx expression that produces them (then
 *  `cacheKey` names the build, and the caller owns "same key ⇒ same code"). */
export type WorkerSource = Record<string, string> | ItxExpressionInput;

/** What hosts a class as a durable facet — `facets.get(name, spec)`, `processors.enable(name, spec)`. */
export type FacetSpec = { source: WorkerSource; cacheKey?: string; className: string };

/** A context (a project, a user, an organization): every `itx` root, reached through `invoke`. */
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
  /** A script — the text of `async (itx) => { … }` — run once in a confined isolate. */
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
      projects: { id: string; orgId: string }[];
      orgs: { id: string; name: string; role?: string }[];
      projectBound: boolean;
      scopes: string[];
      denyLocation: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** A project as the catalog lists it. */
export interface ProjectRecord {
  id: string;
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
  };
  /** The organizations this session reaches. */
  orgs(): Promise<{ id: string; name: string; role?: string }[]>;
  createOrg(name: string): Promise<{ id: string; name: string; role?: string }>;
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
    get(project: string): Promise<IterateContextApi>;
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
