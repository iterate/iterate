/**
 * Public ITX capability contract.
 *
 * `/api` — os' one API — gives callers one unauthenticated object.
 * Authentication returns a root catalog, and every object reachable from that
 * catalog is a Cap'n Web / Workers RPC capability. Projects and agents expose
 * stable built-ins (`streams`, `repos`, `workers`, etc.) plus dynamic dotted
 * capabilities mounted on capability hosts (`itx.capabilityHost`,
 * `itx.capabilityHosts.get(path)`). Streams are the durable coordination layer
 * underneath those surfaces: processors, project bootstrap, repo bootstrap,
 * and agent loops all communicate by appending and reducing events.
 */

// -----------------------------------------------------------------------------
// The four nouns. Keeping them distinct is what makes this system legible:
//
// - a SESSION is what `os.authenticate()` returns. It is a catalog that *vends*
//   itxs; it is not itself an itx.
// - a PROJECT is the tenant / isolation boundary — a `prj_…` id, its Durable
//   Objects, its streams. You never hold a "project object"; you hold an itx
//   scoped into a project.
// - an ITX is a capability context scoped into one project at one path. "itx"
//   is a naming CONVENTION, not a class: an itx is normally an instance of
//   ProjectRpcTarget whose capability host sits at "/" — and sometimes at
//   "/agents/…", which is what "an agent context" means. It is the `itx` in
//   every `async (itx) => { … }` script and what `env.ITX.get()` returns;
//   `session.projects.get(id)` gives you the itx at the project root.
// - a CAPABILITY HOST is the durable dynamic-capability table (and script
//   journal) at one scope path. Each itx fronts exactly one host
//   (`itx.capabilityHost`; `itx.provideCapability`/`revokeCapability` are
//   shortcuts onto it); `itx.capabilityHosts.get(path)` addresses any other
//   scope's host, including the project root at `"/"`.
// -----------------------------------------------------------------------------

/**
 * Self-description of one node in the capability tree — what `__describe()`
 * returns, on EVERY node, by convention.
 *
 * This is the discovery groundwork: `instructions` and `types` are always
 * present and describe THIS node; `children` is the high-level map (one-line
 * blip per child member) so a caller can see what exists without walking;
 * `parent` says where the node sits. Deep discovery is a walk: call
 * `__describe()` on the children you care about. Nodes add structured extras
 * (a project adds `projectId`, an agent adds `whoami`, a capability host adds
 * `capabilities`), so `__describe` is also the identity query — there is no
 * separate `describe()`/`whoami()`.
 *
 * Today each node hand-writes its description (the `describeNode` helper only
 * enforces the shape); the plan is to grow this into a transitive mechanism
 * where a parent composes its children's descriptions.
 */
export type Description = {
  /** Prose: what this node is and how to use it. */
  instructions: string;
  /** TypeScript source for this node's surface ("" when not yet written). */
  types: string;
  /** Discovery map: one-line blip per child member. */
  children: Record<string, string>;
  /** Where this node sits / how you reached it. */
  parent?: string;
};

/**
 * Every node in the capability tree answers `__describe()` — see
 * {@link Description}. Interfaces below extend this instead of redeclaring;
 * nodes with structured extras (Session, Agent, CapabilityHost, the project
 * itx) declare their own narrowed signature.
 */
export interface Describable {
  __describe(): Promise<Description>;
}

/**
 * Entry point exposed before any principal or project authority is known.
 *
 * `/api` hands every caller one of these; the only thing it can do is
 * `authenticate(...)`, which on success returns a {@link Session}. This is the
 * canonical Cap'n Web pattern: authority cannot be forged, only handed back by a
 * method that already checked you.
 */
export interface UnauthenticatedOs extends Describable {
  authenticate(input: ItxAuthCredentials): Promise<Session>;
}

/**
 * What you authenticate into: a catalog that vends itxs.
 *
 * A session is NOT an itx — it is the directory you use to reach one.
 * `projects` is principal-scoped. `streams` and `repos` here are the
 * deployment-wide surfaces backed by `projectId: null`, so only admin/internal
 * auth can reach them.
 */
export interface Session {
  /** Includes `principal` — who this session is (subsumes the old whoami()). */
  __describe(): Promise<Description & { principal: string }>;
  projects: ProjectCollection;
  repos: RepoCollection;
  streams: StreamCollection;
}

/** Catalog of projects reachable from a {@link Session}. */
export interface ProjectCollection extends Describable {
  get(projectId: string): Promise<ProjectRpcTarget>;
  /**
   * Register and bootstrap a project. By default this resolves once the
   * bootstrap saga has committed `project/created` — convenient for scripts
   * and tests that use the project immediately. Pass
   * `waitUntilCreated: false` to resolve as soon as the project EXISTS
   * (identity registered, directory primed, bootstrap events appended): the
   * saga then runs behind the returned handle, and its progress is ordinary
   * live processor state (`itx.processor.onStateChange` — `state.created`
   * flips when bootstrap lands). The dashboard uses the fast path to redirect
   * into the project instantly and play creation progress from pushes.
   */
  create(args: {
    organizationSlug?: string;
    projectId?: string;
    slug: string;
    waitUntilCreated?: boolean;
  }): Promise<ProjectRpcTarget>;
  /**
   * The session's projects, enriched engine-side. Scope is explicit:
   * - "mine" (default for user principals): the caller's own claims (plus
   *   anything the live context was widened to after a create) — even when
   *   the socket also carries admin credentials.
   * - "deployment": every deployment-known project from the project
   *   directory; requires an admin principal (admin secret/cookie or an
   *   admin-role user). Default for non-user admin principals, which have
   *   no claims of their own.
   * Each entry carries the project's {@link ProjectDeploymentStatus} so
   * callers never probe per project.
   */
  list(input?: { scope?: "mine" | "deployment" }): Promise<ProjectListEntry[]>;
}

/**
 * Whether a project the directory knows about actually exists in THIS
 * deployment's engine:
 * - `ready` — the project stream's bootstrap saga ran (`state.created`).
 * - `missing` — the engine has no state for it (e.g. the deployment was reset
 *   while the auth worker kept its rows); it can be set up again.
 * - `unknown` — the probe failed (engine hiccup); don't block the list on it.
 */
export type ProjectDeploymentStatus = "ready" | "missing" | "unknown";

/** One entry of {@link ProjectCollection.list}. */
export type ProjectListEntry = {
  id: string;
  slug: string;
  organizationId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  deploymentStatus: ProjectDeploymentStatus;
};

/**
 * An **itx**: a capability context scoped into one project at one path.
 *
 * The same interface serves the project root (path `"/"`) and every nested
 * scope (`/agents/bla`, `/agents/slack/ts-124`, …). A nested scope is not a
 * different type — it exposes all the project built-ins below PLUS the dynamic
 * capabilities mounted on its own scope and inherited from every enclosing scope
 * (resolution chains child → parent → project; a nearer scope shadows a farther
 * one). `agent`/`chat` are present only when the scope sits under `/agents/`.
 *
 * DESIGN NOTE — why the built-ins are explicit members, not dynamic entries:
 * this object is an RpcTarget that sits *in front of* the capability-host
 * Durable Object. A call like `itx.streams.get("/x")` resolves against these
 * known members in the isolate and never touches the DO, so the hot path pays
 * no extra round trip to check whether `streams` was shadowed. The deliberate trade-off is that a
 * dynamic capability therefore CANNOT shadow a built-in name — the built-in
 * always wins. If shadowable built-ins turn out to be needed often, we'd move
 * resolution behind the DO and accept the round trip; today we don't.
 */
export interface ProjectRpcTarget {
  /**
   * Identity + full capability inventory (subsumes the old describe()):
   * `projectId`/`name`, every reachable capability, the children map, and the
   * full public type surface in `types`.
   */
  __describe(): Promise<ProjectDescription>;
  ai: Ai;
  agents: AgentCollection;
  /**
   * This scope's own capability host: the durable capability table behind
   * this itx (`provideCapability`, `revokeCapability`, `runScript`,
   * `__describe`). Dynamic dotted calls (`itx.foo.bar(...)`) fall back to it.
   */
  capabilityHost: CapabilityHost;
  /**
   * Capability hosts of OTHER scopes, by path. `capabilityHosts.get("/")` is
   * the project root — providing there makes a capability visible to every
   * scope in the project (child scopes inherit ancestors' mounts).
   */
  capabilityHosts: CapabilityHostCollection;
  /** Shortcut for `capabilityHost.provideCapability` (mounts on THIS scope). */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision>;
  /** Shortcut for `capabilityHost.revokeCapability`. */
  revokeCapability(input: RevokeCapabilityInput): Promise<void>;
  /** Formatted dashboard/debug info for this itx scope, suitable for Slack messages. */
  debug(): Promise<string>;
  egress: ProjectEgress;
  /** First-party outbound email from the project's own address (`email.send({ to, subject, text })`). */
  email: EmailCapability;
  /** Read-only catalogue of known-good itx script snippets (`list()`, `get({ id })`). */
  examples: ItxExampleCatalog;
  /** Slack/Google connections + the connection-scoped API proxies (`integrations.gmail`, `integrations.slack`). */
  integrations: ProjectIntegrations;
  mcp: McpClientCollection;
  openapi: OpenApiCollection;
  processor: StreamProcessorRpc<ProjectProcessorState>;
  repo: Repo;
  repos: ProjectRepoCollection;
  /** Path-addressed sandboxes (`itx.sandboxes.get(path)`) — see {@link SandboxCollection}. */
  sandboxes: SandboxCollection;
  secrets: SecretCollection;
  streams: ProjectStreamCollection;
  worker: ProjectWorker;
  workers: DynamicWorkerCollection;
  // Present only on an agent-scoped itx (path under `/agents/`). `agent` is this
  // agent's own control surface; `chat` is its web-chat door. They are getters
  // derived from the scope path, not mounted capabilities — see rpc-targets.ts.
  agent?: Agent;
  chat?: AgentChat;
  /**
   * THIS agent's own sandbox — the sandbox at the agent's path under the
   * sandbox prefix (`/agents/bla` → `/sandboxes/cloudflare/agents/bla`).
   * NOT a built-in: it is a durable itx-expression capability mounted
   * on the agent's capability host at birth
   * (`expression: ["sandboxes", ["get", "/sandboxes/cloudflare" + <agent path>]]`), so every
   * `itx.sandbox.exec(...)` re-resolves through `itx.sandboxes.get` at call
   * time and dispatches like any provided capability. Created with the agent;
   * the container boots on the first command and sleeps after idle. Prefer
   * dotted calls (`await itx.sandbox.exec("...")`) over grabbing the value.
   */
  sandbox?: CloudflareSandbox;
}

/** Agent-local web chat response tool exposed inside agent script execution. */
export interface AgentChat extends Describable {
  sendMessage(input: { message: string }): Promise<StreamEvent>;
}

/** Workers AI binding exposed through ITX as a project/agent capability. */
export interface Ai extends Describable {
  models(): Promise<unknown>;
  run(model: string, body: unknown): Promise<unknown>;
}

/**
 * First-party outbound email through Cloudflare Email Service. Mail is sent
 * from the project's own address — `<slug>@<project hostname base>`, e.g.
 * `acme@iterate.app` — and an explicit `from` must match it: a project can
 * never send as another project or an arbitrary address. Requires the
 * deployment's sender domain to be onboarded for Email Sending in Cloudflare.
 */
export interface EmailCapability extends Describable {
  send(input: {
    to: string | string[];
    subject: string;
    /** Plain-text body; at least one of text/html is required. */
    text?: string;
    html?: string;
    /** Optional explicit sender; must equal the project's own address. */
    from?: string;
  }): Promise<{ from: string; messageId: string | null }>;
}

// -----------------------------------------------------------------------------
// Integrations (Slack + Google) — the Phase 12 surface.
// -----------------------------------------------------------------------------

export type IntegrationProvider = "google" | "slack";

/**
 * Slack Web API proxy. `request` is the explicit form; dotted Web API method
 * paths (`itx.integrations.slack.chat.postMessage({...})`) resolve through the dynamic
 * path-call fallback onto `invokeCapability`.
 */
export interface SlackCapability extends Describable {
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  request(input: {
    body?: Record<string, unknown>;
    method: string;
  }): Promise<Record<string, unknown>>;
}

export type GmailRequestInput = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  path: string;
  query?: Record<string, boolean | number | string | null | undefined>;
};

/** Gmail REST proxy (`itx.integrations.gmail.request({ path: "/users/me/messages" })`). */
export interface GmailCapability extends Describable {
  request(input: GmailRequestInput): Promise<{
    data: unknown;
    headers: Record<string, string>;
    status: number;
    statusText: string;
  }>;
}

export type IntegrationConnectionStatus = {
  connected: boolean;
  displayName: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
};

export type CompleteConnectResult =
  | { callbackUrl: string | null; ok: true }
  | { callbackUrl: string | null; error: string; ok: false };

/**
 * Project-scoped integration management (connection status, OAuth, disconnect)
 * plus the connection-scoped API proxies: `integrations.gmail` and
 * `integrations.slack` live here because they only work through the project's
 * connected accounts.
 */
export interface ProjectIntegrations extends Describable {
  /** Gmail REST proxy for the project's connected Google account. */
  gmail: GmailCapability;
  /** Slack Web API proxy for the connected workspace (`integrations.slack.chat.postMessage(...)`). */
  slack: SlackCapability;
  completeGoogleConnect(input: {
    code: string;
    state: string;
    userId: string | null;
  }): Promise<CompleteConnectResult>;
  completeSlackConnect(input: {
    code: string;
    state: string;
    userId: string | null;
  }): Promise<CompleteConnectResult>;
  disconnect(input: { provider: IntegrationProvider }): Promise<{ success: true }>;
  getConnection(input: { provider: IntegrationProvider }): Promise<IntegrationConnectionStatus>;
  startOAuthFlow(input: {
    callbackUrl?: string;
    provider: IntegrationProvider;
    /** The user to bind the OAuth state to. Browser-supplied, not authority;
     * the callback's check against the signed state is the backstop. */
    userId: string;
  }): Promise<{ authorizationUrl: string }>;
}

export type RouteSlackWebhookResult =
  | { ok: true; projectId: string }
  | { ignored: "team-not-claimed"; ok: true };

/** Agent catalog within one project. */
export interface AgentCollection extends Describable {
  get(path: string): Agent;
  list(): Promise<StreamListItem[]>;
}

/** Agent capability surface for message loops and agent-local dynamic tools. */
export interface Agent {
  /** Includes `whoami` (`"agent <projectId>:<agentPath>"`), `projectId`, `agentPath`. */
  __describe(): Promise<Description & { agentPath: string; projectId: string; whoami: string }>;
  /** The agent scope's own capability host (provide/revoke/runScript/__describe). */
  capabilityHost: CapabilityHost;
  /** Shortcut for `capabilityHost.provideCapability` (mounts on THIS agent's scope). */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision>;
  /** Shortcut for `capabilityHost.revokeCapability`. */
  revokeCapability(input: RevokeCapabilityInput): Promise<void>;
  chat: AgentChat;
  processor: StreamProcessorRpc<AgentProcessorState>;
  stream: Stream;
  sendMessage(message: string): Promise<StreamEvent>;
  /**
   * Send-and-wait convenience: appends a user message and resolves with the
   * agent's next chat reply on this stream. Replies are matched by order, not
   * correlated per request — concurrent asks on one agent stream interleave
   * exactly like two people typing into the same chat.
   */
  ask(input: {
    message: string;
    /** Where the message came from. Defaults to "web". */
    origin?: "web" | "mcp";
    /** How long to wait for the reply. Defaults to 45s. */
    timeoutMs?: number;
  }): Promise<StreamEvent>;
}

/** Stream catalog for either a project or the deployment-wide global scope. */
export interface StreamCollection extends Describable {
  get(path: string): Stream;
}

/** Project-scoped stream catalog with reduced-state listing. */
export interface ProjectStreamCollection extends StreamCollection {
  list(): Promise<StreamListItem[]>;
}

/**
 * Durable event stream capability.
 *
 * Streams are the public coordination primitive, not an internal queue hidden
 * behind domain methods. Domain helpers can construct common event shapes, but
 * callers and processors still work with explicit events.
 */
export interface Stream extends Describable {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  at(path: string): Stream;
  getEvent(
    input: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined>;
  /** Read one bounded page. Defaults to, and caps at, 500 events. */
  getEvents(input?: StreamEventReadInput): Promise<StreamEvent[]>;
  /** Create a disposable pager over a fixed read window. */
  readEvents(input?: StreamEventReadInput): StreamEventPager;
  waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent>;
  getProcessorRuntimeState(input: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null>;
  runtimeState(): Promise<{
    coreProcessorState: unknown;
    runtime: {
      connections: Record<string, unknown>;
    };
  }>;
  subscribe(input: {
    subscriptionKey?: string;
    /**
     * Open the durable configured subscription registered under
     * `subscriptionKey` (the wake-handshake response) instead of an ephemeral
     * one. Requires trusted-internal auth and an existing
     * subscription-configured fact for the key.
     */
    configured?: boolean;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    events?: boolean;
    subscriber?: unknown;
  }): Promise<StreamSubscriptionHandle>;
}

/** Window for bounded stream reads. Offsets are exclusive: `afterOffset: 10` starts at 11. */
export type StreamEventReadInput = {
  /** Exclusive lower bound. Defaults to 0. */
  afterOffset?: number;
  /** Exclusive upper bound. Omit/null to read through the current tail. */
  beforeOffset?: number | null;
  /** Event types to include. Omit or include "*" for all; [] matches none. */
  eventTypes?: readonly string[];
  /** Page size, 1-500. Defaults to 500. */
  limit?: number;
};

/**
 * Stateful page reader for one stream read window.
 *
 * This is not a live subscription; [] means "caught up for now". Dispose it
 * when finished (`using pager = stream.readEvents(...)`).
 */
export interface StreamEventPager extends Disposable {
  /** Returns [] when no newer matching page is currently available. */
  next(): Promise<StreamEvent[]>;
}

/** Repo catalog for either a project or the deployment-wide global scope. */
export interface RepoCollection extends Describable {
  create(input: { path: string }): Promise<Repo>;
  get(path: string): Repo;
}

/** Project-scoped repo catalog with reduced-state listing. */
export interface ProjectRepoCollection extends RepoCollection {
  list(): Promise<StreamListItem[]>;
}

/** Git-backed repo capability used by project workers and dynamic worker refs. */
export interface Repo extends Describable {
  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult>;
  create(): Promise<Repo>;
  /**
   * Safely replace text in one committed file and commit the result. The
   * `oldString` must match exactly once unless `replaceAll` is true.
   */
  edit(input: EditRepoFileInput): Promise<EditRepoFileResult>;
  /** All committed file paths at HEAD. */
  listFiles(): Promise<{ commitOid: string; paths: string[] }>;
  processor: StreamProcessorRpc<RepoProcessorState>;
  /** Committed file contents at HEAD; null when the path does not exist. */
  readFile(input: { path: string }): Promise<{
    commitOid: string;
    content: string;
    path: string;
  } | null>;
  whoami(): Promise<string>;
}

/**
 * Catalog of sandboxes within one project.
 *
 * A sandbox is addressed by its FULL path, which always lives under
 * `/sandboxes/` — the same domain-prefix convention as `/secrets/...` and
 * `/repos/...`: an agent's sandbox is the agent path under the Cloudflare
 * provider segment (`/sandboxes/cloudflare/agents/...`, exposed as
 * `itx.sandbox` in that agent's scope), and standalone sandboxes
 * conventionally live under `/sandboxes/cloudflare/<anything>`.
 * Getting a sandbox is cheap and does not start a container; the first
 * command does, and the sandbox sleeps again after idle.
 */
export interface SandboxCollection extends Describable {
  get(path: string): Promise<CloudflareSandbox>;
}

/**
 * One Cloudflare Sandbox: the bare `@cloudflare/sandbox` Durable Object stub,
 * nothing wrapped on top. Whatever the installed SDK exposes is callable —
 * `exec(command)`, `readFile`/`writeFile`/`listFiles`, `startProcess`,
 * `gitCheckout`, `exposePort`, `destroy()`, … — so this contract deliberately
 * does not re-declare that surface (same stance as {@link McpClientRpc}); see
 * https://developers.cloudflare.com/sandbox/ for the API. One addition: the
 * project repo is ALWAYS checked out at `/workspace/repos/project`, which is
 * also the default working directory — a bare `exec("ls")` lists the project.
 * Every command awaits that provisioning internally, so no explicit
 * `ensureProjectRepo()` is needed first (it stays available to await the
 * checkout deterministically).
 */
export type CloudflareSandbox = object;

/** Secret catalog within one project. */
export interface SecretCollection extends Describable {
  get(path: string): Secret;
  list(): Promise<StreamListItem[]>;
}

/** Path-addressed secret capability. Secret material has no public read API. */
export interface Secret extends Describable {
  describe(): Promise<SecretDescription>;
  fetch(req: Request): Promise<Response>;
  processor: StreamProcessorRpc<SecretDescription>;
  update(input: SecretUpdateInput): Promise<StreamEvent>;
}

export type SecretUpdateInput = {
  egress?: { urls: string[] };
  material?: string;
};

export type SecretDescription = {
  audit: {
    lastUsedAt?: string;
    lastUsedBy?: string;
    lastUsedUrl?: string;
    usedCount: number;
  };
  egress: { urls: string[] };
  hasMaterial: boolean;
};

export type StreamListItem = {
  createdAt: string;
  path: string;
};

export type ProjectProcessorState = {
  agents: StreamListItem[];
  createRequest: { projectId: string; slug: string } | null;
  created: boolean;
  onboardingActive: boolean;
  onboardingCompletedAt: string | null;
  repos: StreamListItem[];
  secrets: StreamListItem[];
  streams: StreamListItem[];
};

export type AgentProcessorState = {
  currentRequest:
    | { phase: "scheduled"; requestId: string; scheduledOffset: number }
    | { phase: "requested"; llmRequestId: number }
    | null;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  llmConfig: { model: string };
  llmProvider: "cloudflare-ai" | "openai-ws";
  pendingTriggerOffset: number | null;
  scriptExecutionsCompleted: string[];
  systemPrompt: string;
};

export type RepoProcessorState = {
  artifactName: string | null;
  created: boolean;
  defaultBranch: string | null;
  initialized: boolean;
  remote: string | null;
};

// NOTE: there is deliberately no public secret processor state type: a
// secret's public live state IS its SecretDescription. The internal fold
// carries the encrypted material; the DO's processor facade projects it away
// (write-only material) before anything crosses the RPC boundary.

export type ProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

/**
 * Live handle for one `onStateChange` subscription.
 *
 * `ping()` is the liveness probe: `true` while the subscription is still
 * registered on the live processor, `false` once it was dropped (delivery
 * failure, explicit unsubscribe). The call REJECTS when the hosting Durable
 * Object incarnation is gone. For a subscriber, `false` and a rejection mean
 * the same thing: re-subscribe. Pushes stop silently when a DO restarts or a
 * transport half-opens, so a periodic ping is how a client turns "silently
 * stale" into "detectably dead".
 */
export type ProcessorStateSubscriptionHandle = Disposable & {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): void;
};

export interface StreamProcessorRpc<State = unknown> {
  getRuntimeState(): Promise<ProcessorRuntimeState<State>>;
  /**
   * Server-push of the processor's reduced state. The callback receives the
   * durable checkpoint `{ offset, state }` — offset-carrying so clients can
   * commit pushes and `snapshot()` reads monotonically against each other —
   * once immediately on subscribe (current state IS the first paint) and then
   * after every checkpointed batch that changed state.
   */
  onStateChange(
    cb: (snapshot: ProcessorSnapshot<State>) => unknown,
  ): Promise<ProcessorStateSubscriptionHandle>;
  snapshot(): Promise<ProcessorSnapshot<State>>;
  waitUntilEvent(input: { offset: number; timeoutMs?: number }): Promise<void>;
}

/**
 * Per-stub dispatch options for `DynamicWorkerCollection.get`.
 *
 * `flattenNestedPaths` mirrors `provideCapability`: dotted calls on the stub
 * become ONE `invokeCapability({ path, args })` call that the worker's own
 * `invokeCapability` method dispatches in userspace (one RPC per call),
 * instead of the default member-by-member replay on the entrypoint.
 * `buildBudgetMs` bounds how long a call waits on a cold source build; past
 * it the call fails with an error whose `name` is
 * `"WorkerBuildInProgressError"` — the NAME is the contract (it survives
 * Workers RPC; class identity does not), so userspace matches
 * `error.name === "WorkerBuildInProgressError"` to render its own building
 * page (the seeded template's router does exactly this).
 */
export type DynamicWorkerDispatchOptions = {
  buildBudgetMs?: number;
  flattenNestedPaths?: boolean;
};

/** Capability-tree entry point for ad-hoc project-scoped worker refs. */
export interface DynamicWorkerCollection extends Describable {
  get<T extends object = Record<string, unknown>>(
    ref: DynamicWorkerRef,
    options?: DynamicWorkerDispatchOptions,
  ): DynamicWorkerCapability<T>;
}

/** Live replacement for project egress. It sees getSecret(...) placeholders, never material. */
export type ProjectEgressInterceptor = (req: Request) => Promise<Response>;

/** Disposable handle for one live project egress interception. */
export interface ProjectEgressIntercept extends Disposable {
  release(): Promise<void>;
}

/**
 * Project-owned egress facet.
 *
 * `fetch` is the explicit outbound door. Dynamic workers' bare `fetch()` uses
 * the same project egress path through the WorkerEntrypoint gateway.
 *
 * `intercept` installs one live runtime replacement on the Project Durable
 * Object. Last writer wins; disposing or releasing the handle clears only the
 * interceptor it installed if it is still current.
 */
export interface ProjectEgress extends Describable {
  fetch(req: Request): Promise<Response>;
  intercept(handler: ProjectEgressInterceptor): Promise<ProjectEgressIntercept>;
}

/** What a project itx's `__describe()` returns: the Description convention plus identity and the capability inventory. */
export type ProjectDescription = Description & {
  capabilities: CapabilityDescription[];
  name: string;
  projectId: string;
};

export type CapabilityDescription = {
  instructions?: string;
  path: string[];
  providedAtOffset?: number;
  /**
   * The itx scope path this capability is declared at (`"/"`, `"/agents/bla"`, …).
   * Set when a scope reports capabilities it inherited from an enclosing scope,
   * so the reader can tell a local mount from an inherited one. Absent on
   * built-ins (they exist at every scope).
   */
  scope?: string;
  type: "builtin" | "live" | "itx-expression";
  types?: string;
};

export interface OpenApiCollection extends Describable {
  connect(input: OpenApiConnectInput): Promise<OpenApiRpc>;
}

export type OpenApiConnectInput = {
  baseUrl?: string;
  headers?: Record<string, string>;
  specUrl: string;
};

export type OpenApiRpc = object;

export interface McpClientCollection extends Describable {
  connect(input: McpClientConnectInput): Promise<McpClientRpc>;
  /**
   * The public Exa MCP server (https://mcp.exa.ai/mcp), pre-connected for every
   * project: web search and page reading as flat tool calls.
   * `itx.mcp.exa.web_search_exa({ query, numResults })` searches the web;
   * `itx.mcp.exa.web_fetch_exa({ urls, maxCharacters })` reads pages as markdown.
   */
  exa: McpClientRpc;
}

export type McpClientConnectInput = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  url: string;
};

export type McpClientRpc = object;

/**
 * Read-only catalogue of known-good itx script snippets — the project-context
 * entries of the REPL "Examples" panel. `list()` returns every entry without
 * its code; `get({ id })` returns one entry with the full script body. Agents
 * copy working patterns from here instead of guessing at the surface.
 * Session-level examples (whoami, projects.list) are excluded: they run
 * against the OS Session `authenticate()` returns, which an itx holder does
 * not have.
 */
export interface ItxExampleCatalog extends Describable {
  get(input: { id: string }): Promise<ItxExampleWithCode>;
  list(): Promise<ItxExampleSummary[]>;
}

export type ItxExampleSummary = {
  description: string;
  id: string;
  title: string;
};

export type ItxExampleWithCode = ItxExampleSummary & { code: string };

/**
 * The host surface for one capability scope: the durable dynamic-capability
 * table and script journal at one path inside a project (backed by one
 * CapabilityHostDurableObject). Mounting is always local to the host's own
 * scope; reads (`invokeCapability`, `__describe`) chain up through
 * enclosing scopes, so a project-root mount is visible from every scope.
 */
export interface CapabilityHost {
  /** Includes `capabilities`: everything reachable at this scope — own mounts plus inherited ones, tagged with their declaring scope. */
  __describe(): Promise<Description & { capabilities: CapabilityDescription[]; path: string }>;
  /** The scope path this host fronts: `"/"` is the project root, `/agents/bla` an agent. */
  path: string;
  /** Explicit dynamic dispatch; the dotted-path fallback (`itx.foo.bar(...)`) compiles to exactly this call. */
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision>;
  revokeCapability(input: RevokeCapabilityInput): Promise<void>;
  runScript(code: string): Promise<{
    completedEvent: StreamEvent;
    executionId: string;
    result: unknown;
  }>;
}

/** Capability hosts by scope path within one project (`itx.capabilityHosts`). */
export interface CapabilityHostCollection extends Describable {
  get(path: string): CapabilityHost;
}

/**
 * Ownership handle for one mounted capability.
 *
 * The offset identifies the exact `capability-provided` event, which lets
 * disposal or explicit revoke remove this mount without racing a newer mount at
 * the same path.
 */
export interface CapabilityProvision extends Describable, Disposable {
  readonly path: string[];
  readonly providedAtOffset: number;
  revoke(): Promise<void>;
}

/** Append input before the stream assigns offset and timestamp. */
export type StreamEventSource = {
  processor?: {
    slug: string;
    version: string;
  };
  crossPost?: {
    ruleId: string;
    from: {
      createdAt: string;
      offset: number;
      path: string;
      projectId: string | null;
      type: string;
    };
  };
};

export type StreamEventInput = {
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
};

/** Durable stream event after commit. */
export type StreamEvent = StreamEventInput & {
  createdAt: string;
  offset: number;
};

/** Stable identity for one stream subscription connection. */
export type SubscriptionKey = string;

/**
 * Batch delivered to stream processors and live subscribers.
 *
 * Kept named because callback retention, processor hosts, and tests all depend
 * on the same cross-RPC batch envelope.
 */
export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  events: StreamEvent[];
  streamMaxOffset: number;
  state: unknown;
};

/**
 * Callback invoked by the stream pump for each delivered batch.
 *
 * It stays as a named type because Workers RPC callback lifecycle helpers need
 * to duplicate, retain, and dispose exactly this callback shape.
 */
export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

/** Serializable snapshot plus optional live runtime debug state for a processor. */
export type ProcessorRuntimeState<State = unknown> = {
  snapshot: { offset: number; state: State };
  runtime?: Record<string, unknown>;
};

/**
 * Optional runtime-state callback exposed by a hosted processor.
 *
 * It accepts sync or async implementations because local processors can return
 * immediately, while RPC-backed processors may need an async round trip.
 */
export type GetProcessorRuntimeState = () => ProcessorRuntimeState | Promise<ProcessorRuntimeState>;

/**
 * Live subscription handle returned by `Stream.subscribe`.
 *
 * `ping()` mirrors {@link ProcessorStateSubscriptionHandle.ping}: `true` while
 * the connection is still open on the live stream, `false` after it closed
 * (replaced, delivery failure, unsubscribe); it rejects when the stream's
 * Durable Object incarnation is gone. Either non-`true` outcome means the
 * subscriber should re-subscribe.
 */
export type StreamSubscriptionHandle = Disposable & {
  subscriptionKey: SubscriptionKey;
  streamMaxOffset: number;
  ping(): boolean | Promise<boolean>;
  unsubscribe(): void;
};

/**
 * One repo file mutation.
 *
 * Kept named because public `Repo.commitFiles`, input parsing, and artifact
 * commit implementation all validate the same command shape.
 */
export type RepoFileChange =
  | {
      path: string;
      content: string;
    }
  | {
      path: string;
      delete: true;
    };

/** Command object for committing a batch of repo file mutations. */
export type CommitRepoFilesInput = {
  author?: { email: string; name: string };
  branch?: string;
  changes: RepoFileChange[];
  message: string;
};

/** Result returned after a repo commit attempt, including no-op commits. */
export type CommitRepoFilesResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  noChanges: boolean;
};

/** Command object for a coding-agent-style exact string edit. */
export type EditRepoFileInput = {
  author?: { email: string; name: string };
  branch?: string;
  message: string;
  newString: string;
  oldString: string;
  path: string;
  replaceAll?: boolean;
};

/** Result returned after an exact string edit commit attempt. */
export type EditRepoFileResult = CommitRepoFilesResult & {
  occurrenceCount: number;
  path: string;
};

/** Dynamic invocation envelope used by flattened live capabilities. */
export type FlattenedCapabilityInvocation = {
  args: unknown[];
  flattenNestedPath?: boolean;
  path: string[];
};

/** Target shape for a live capability that wants to receive flattened paths. */
export type FlattenedCapabilityTarget = {
  invokeCapability(input: FlattenedCapabilityInvocation): unknown;
};

/** Durable expression over the project ITX surface. */
export type ItxExpressionStep = string | [method: string, ...args: unknown[]];
export type ItxExpression = ItxExpressionStep[];

/** Capability recipe accepted by `provideCapability`. */
export type ProvideCapabilityInput =
  | {
      capability: unknown;
      flattenNestedPaths?: false;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      capability: FlattenedCapabilityTarget;
      flattenNestedPaths: true;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      expression: ItxExpression;
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "itx-expression";
      types?: string;
    };

/** Event payload stored when a capability is mounted on an ITX stream. */
export type CapabilityProvidedPayload =
  | {
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      expression: ItxExpression;
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "itx-expression";
      types?: string;
    };

/** Reduced capability table row: payload plus the providing event offset. */
export type CapabilityRecord = CapabilityProvidedPayload & {
  providedAtOffset: number;
};

/** Revoke command for the current mount at a path or one exact mount offset. */
export type RevokeCapabilityInput = {
  path: string[];
  providedAtOffset?: number;
};

/**
 * Credentials accepted by `UnauthenticatedOs.authenticate`.
 *
 * - `from-server-cookie` — the browser lane: the deployment's admin cookie or
 *   the signed-in user's session cookie riding the WebSocket handshake.
 * - `bearer` — an auth access token presented as RPC data.
 * - `admin-secret` — the deployment admin API secret (CLI / tooling / e2e).
 * - `impersonate` — admin-secret-gated fake principal, for test suites that
 *   exercise per-project confinement without minting real users.
 */
export type ItxAuthCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer"; token: string }
  | { type: "admin-secret"; secret: string }
  | { type: "impersonate"; secret: string; token: ItxAuthToken };

/** Principal shape for `impersonate` credentials. */
export type ItxAuthToken =
  | { type: "admin"; principal?: string }
  | { type: "user"; principal: string; projectScopes: string[] };

/** Authority object carried by server-side RPC target instances. */
export interface ItxAuth {
  readonly principal: string;
  isAdmin(): boolean;
  canAccessProject(projectId: string): boolean;
  assertCanAccessProject(projectId: string | null): void;
  listAccessibleProjects(): string[];
  /**
   * Async access check that may consult the project directory (source of
   * truth) when synchronous claims miss — see the auth adapter. Optional so
   * in-process trusted contexts stay trivially constructible.
   */
  ensureCanAccessProject?(projectId: string): Promise<void>;
}

/**
 * Where a dynamic worker's source files come from.
 *
 * `inline` supplies the file map directly — the primitive behind run-script and
 * worker-backed provided capabilities where the caller hands over a small
 * TypeScript entry file, helpers, and optionally a `package.json`. `repo` names
 * a project repo snapshot: a branch (late-bound, so future commits affect the
 * next use) or a pinned commit, narrowed by include/exclude glob masks so a
 * large repo does not become build input by default.
 */
export type WorkerFileSource =
  | {
      type: "inline";
      files: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      /**
       * Defaults to the repo's default branch when omitted. A pinned commit
       * may name the branch it lives on — clones are single-branch, so an
       * off-default-branch commit is unreachable without it.
       */
      ref?: { branch: string } | { commitOid: string; branch?: string };
      include?: string[];
      exclude?: string[];
    };

/** Loader names accepted by Cloudflare's worker bundler `loader` option. */
export type WorkerBundlerLoader =
  | "js"
  | "jsx"
  | "ts"
  | "tsx"
  | "json"
  | "css"
  | "text"
  | "binary"
  | "base64"
  | "dataurl";

/**
 * Build options for a dynamic worker.
 *
 * This mirrors Cloudflare's `CreateWorkerOptions` from
 * `@cloudflare/worker-bundler` minus `files` (OS supplies files from the
 * selected {@link WorkerFileSource}) — deliberately not a parallel option
 * language (drift fails typecheck via the assignability pin in
 * domains/workers/schemas.ts; this file stays import-free because it is
 * published verbatim as the itx types surface). `bundle: false` is allowed; the invariant is one OS
 * materialization pipeline, not one bundled output file. When the file map has
 * a `package.json` with dependencies, the bundler installs them from the npm
 * registry at build time.
 */
export type WorkerBuildOptions = {
  /** Entry point file path relative to the source root (e.g. "worker.ts"). */
  entryPoint?: string;
  /** Bundle all dependencies into a single output file. Default: true. */
  bundle?: boolean;
  /** Modules kept external ("cloudflare:*" always is). */
  externals?: string[];
  /** Target environment. Default: "es2022". */
  target?: string;
  minify?: boolean;
  sourcemap?: boolean;
  /** npm registry URL for dependency installs. */
  registry?: string;
  jsx?: "transform" | "preserve" | "automatic";
  jsxImportSource?: string;
  define?: Record<string, string>;
  loader?: Record<string, WorkerBundlerLoader>;
  conditions?: string[];
  virtualModules?: Record<string, string>;
};

/**
 * Declarative source for a dynamic worker: an orthogonal file source plus
 * Cloudflare-compatible build options.
 *
 * Materialization resolves `files` to a file map and builds it through
 * Cloudflare's worker bundler; the loader-ready output is cached by a
 * deterministic build key, so the same source+options never builds twice.
 */
export type DynamicWorkerSource = {
  files: WorkerFileSource;
  options?: WorkerBuildOptions;
};

type DynamicWorkerRefBase = {
  /**
   * ITX scope path for the worker's `env.ITX` binding and for stateful worker
   * Durable Object names. This is intentionally not the mounted capability path:
   * one worker can be mounted at `db`, `counter`, etc. while all events still
   * belong to the host stream path.
   */
  path: string;
  source: DynamicWorkerSource;
};

/**
 * Stateless workers are WorkerEntrypoint exports loaded directly from source.
 *
 * `props` are passed to `worker.getEntrypoint(name, { props })` and appear as
 * `this.ctx.props` inside the exported WorkerEntrypoint. They deliberately live
 * only on stateless refs: Durable Object facets are started with
 * `ctx.facets.get(name, () => ({ class, id? }))`, which does not accept
 * WorkerEntrypoint-style props.
 */
export type StatelessDynamicWorkerRef = DynamicWorkerRefBase & {
  type: "stateless";
  entrypoint?: string;
  props?: Record<string, JsonValue>;
};

/**
 * Stateful workers are Durable Object class exports hosted by
 * `StatefulWorkerDurableObject`.
 *
 * `durableWorkerKey` is the durable identity under `{ projectId, path }`. It is
 * not a source cache key: source changes deliberately affect the next use of the
 * same durable worker identity.
 */
export type StatefulDynamicWorkerRef = DynamicWorkerRefBase & {
  type: "stateful";
  className: string;
  durableWorkerKey: string;
  /**
   * What a call does when the worker's source changed since the running
   * version. `"block"` (default) waits for the rebuild — commit-then-call
   * sees the new code. `"stale-while-rebuild"` keeps answering with the
   * running version and swaps to the new build in the background: better
   * availability, but the next few calls after a commit may see old code.
   * The policy rides the REF, not the durable identity — callers sharing one
   * `durableWorkerKey` should agree on it (and on `source`), or each call
   * flips the facet to its own version.
   */
  updatePolicy?: "block" | "stale-while-rebuild";
};

/** Worker recipe accepted by `workers.get` and worker-backed capabilities. */
export type DynamicWorkerRef = StatelessDynamicWorkerRef | StatefulDynamicWorkerRef;

/** Dynamic worker RPC stub plus the disposal operation owned by the caller. */
export type DynamicWorkerCapability<T extends object = Record<string, unknown>> = T & Disposable;

/**
 * Slack Web API surface exposed by the seeded project worker
 * (`itx.worker.slack.chat.postMessage({...})`).
 *
 * The seeded repo implements this in userland with the real `@slack/web-api`
 * package (installed by the worker build pipeline from its `package.json`), so
 * any nested Web API method family resolves — the index signature reflects
 * that this tree is as wide as the SDK's.
 */
export interface ProjectWorkerSlack {
  chat: {
    postMessage(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  } & Record<string, unknown>;
  [family: string]: unknown;
}

/**
 * Default seeded project worker contract.
 *
 * This documents the reference repo's `worker.ts` only. Arbitrary dynamic
 * workers should be typed by callers through `workers.get<T>(ref)`. The
 * platform dispatches to it with flattened paths, so the worker implements
 * `invokeCapability` in userspace and every dotted call — including any
 * nested `slack.*` Web API family — is one RPC.
 */
export interface ProjectWorker {
  fetch(req: Request): Promise<Response>;
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  processEvent(input: { event: StreamEvent }): Promise<void>;
  slack: ProjectWorkerSlack;
}

/** JSON subset accepted by WorkerEntrypoint props and script results. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Minimal ExecutionContext shape the RPC adapter layer needs.
 *
 * This stays at the bottom because it is server-side plumbing, not part of the
 * client-facing ITX contract. It is exported only so domain hosts can inject
 * project/agent capability targets without importing the full worker module.
 */
export type CfExecutionContext = {
  exports: ExecutionContext["exports"];
  /** Required, not optional: budget-expired dynamic worker builds are handed
   * to it (worker-loader.ts withBuildBudget) — a silent no-op here would
   * strand every cold build the caller gave up on. Hosts without a real
   * runtime hook must still supply an explicit function. */
  waitUntil: ExecutionContext["waitUntil"];
};
