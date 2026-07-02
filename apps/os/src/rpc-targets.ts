import { RpcTarget } from "cloudflare:workers";
import { Client as McpSdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppConfig } from "./config.ts";
import { createAuthWorkerServiceClient } from "./auth/auth-worker-service.ts";
import { parseConfig } from "./config.ts";
import {
  resolveItxAuth,
  resolveOrganizationSlugForCreate,
  userPrincipalOf,
  widenProjectAccess,
} from "./auth.ts";
import { itxEnv as env } from "./env.ts";
import {
  listProjectDirectory,
  primeProjectDirectory,
  readProjectById,
} from "./project-directory.ts";
import { deploymentStatusesFromProbes } from "./project-deployment-status.ts";
import type { Env } from "./env.ts";
import { DurableObjectNameCodec, normalizePath } from "./domains/durable-object-names.ts";
import { normalizeAgentPath } from "./domains/agents/utils.ts";
import {
  itxEntrypointProps,
  itxEntrypointBinding,
  itxEntrypointScopeCacheKey,
  rejectBuiltinCollision,
  withInvokeCapabilityFallback,
} from "./domains/itx/utils.ts";
import { projectStub } from "./domains/projects/egress.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor-contract.ts";
import { projectEgressFetcher } from "./domains/projects/utils.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor-contract.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "./domains/repos/utils.ts";
import { normalizeSecretPath } from "./domains/secrets/utils.ts";
import {
  completeGoogleConnect,
  completeSlackConnect,
  disconnectProvider,
  getConnectionStatus,
  routeSlackWebhook,
  startOAuthFlow,
} from "./domains/integrations/connect-flows.ts";
import { callGmailApi } from "./domains/integrations/gmail-api.ts";
import { getFreshGoogleAccessToken } from "./domains/integrations/google-tokens.ts";
import { callProjectSlackWebApi } from "./domains/integrations/slack-api.ts";
import {
  buildDurableObjectProcessorSubscriptionConfiguredEvent,
  resolveStreamPath,
} from "./domains/streams/utils.ts";
import { DynamicWorkerRef as WorkerRefSchema } from "./domains/workers/schemas.ts";
import { DynamicWorkerRunner } from "./domains/workers/worker-runner.ts";
import {
  isObjectSchema,
  listOpenApiOperations,
  operationBodySchema,
  type OpenApiOperation,
} from "./domains/itx/openapi-types.ts";
import type {
  ProcessorState,
  StreamProcessor,
  StreamProcessorContract,
} from "./domains/streams/stream-processor.ts";
import type {
  Agent,
  AgentChat,
  CapabilityProvision,
  AgentCollection,
  Ai,
  CfExecutionContext,
  ItxAuth,
  Itx,
  Session,
  McpClientCollection,
  McpClientConnectInput,
  OpenApiCollection,
  OpenApiConnectInput,
  ProjectCollection,
  ProjectListEntry,
  ProjectRepoCollection,
  ProjectStreamCollection,
  ProjectEgress,
  ProjectEgressIntercept,
  ProjectWorker,
  RevokeCapabilityInput,
  Repo,
  RepoCollection,
  Secret,
  SecretCollection,
  StatelessDynamicWorkerRef,
  Stream,
  StreamCollection,
  StreamProcessorRpc,
  StreamSubscriptionHandle,
  UnauthenticatedItx,
  DynamicWorkerCapability,
  DynamicWorkerCollection,
  DynamicWorkerRef,
  GmailCapability,
  ProjectIntegrations,
  SessionIntegrations,
  SlackCapability,
} from "./types.ts";

export class StreamRpcTarget extends RpcTarget implements Stream {
  constructor(readonly props: { auth: ItxAuth; projectId: string | null; path: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.STREAM.getByName(
      DurableObjectNameCodec.stringify(
        {
          projectId: this.props.projectId,
          path: this.props.path,
        },
        { allowNullProjectId: true },
      ),
    );
  }

  // Keep this forwarding surface pinned to the public `Stream` contract.
  // Without explicit return annotations TypeScript infers through the generated
  // DurableObjectStub<StreamDurableObject> type and can chase the DO's internal
  // core-processor/runtime-state implementation instead of the RPC API.
  append(...events: Parameters<Stream["append"]>) {
    return this.durableObjectStub.append(...events);
  }

  at(path: Parameters<Stream["at"]>[0]) {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: resolveStreamPath(this.props.path, path),
    });
  }

  getEvent(args: Parameters<Stream["getEvent"]>[0]) {
    return this.durableObjectStub.getEvent(args);
  }

  getEvents(args?: Parameters<Stream["getEvents"]>[0]) {
    return this.durableObjectStub.getEvents(args);
  }

  waitForEvent(args: Parameters<Stream["waitForEvent"]>[0]) {
    return this.durableObjectStub.waitForEvent(args);
  }

  getProcessorRuntimeState(args: Parameters<Stream["getProcessorRuntimeState"]>[0]) {
    return this.durableObjectStub.getProcessorRuntimeState(args);
  }

  runtimeState() {
    return this.durableObjectStub.runtimeState();
  }

  subscribe(args: Parameters<Stream["subscribe"]>[0]) {
    return this.durableObjectStub.subscribe(args);
  }

  subscribeConfigured(
    args: Parameters<Stream["subscribe"]>[0] & { subscriptionKey: string },
  ): Promise<StreamSubscriptionHandle> {
    if (this.props.auth.principal !== "trusted-internal") {
      throw new Error("subscribeConfigured requires trusted internal auth");
    }
    return this.durableObjectStub.subscribeConfigured(args);
  }
}

class StreamCollectionRpcTarget extends RpcTarget implements StreamCollection {
  constructor(readonly props: { auth: ItxAuth; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get(path: string) {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path,
    });
  }
}

class ProjectStreamCollectionRpcTarget
  extends StreamCollectionRpcTarget
  implements ProjectStreamCollection
{
  constructor(readonly projectProps: { auth: ItxAuth; projectId: string }) {
    super(projectProps);
  }

  list() {
    return projectProcessorState(this.projectProps.projectId).then((state) => state.streams);
  }
}

function rootStream(props: { auth: ItxAuth; projectId: string | null }) {
  return new StreamRpcTarget({
    auth: props.auth,
    projectId: props.projectId,
    path: "/",
  });
}

function streamDurableObjectName(props: { projectId: string | null; path: string }) {
  return DurableObjectNameCodec.stringify(props, { allowNullProjectId: true });
}

async function requestRepoCreate(input: {
  auth: ItxAuth;
  path: string;
  projectId: string | null;
}): Promise<RepoRpcTarget> {
  const path = normalizePath(input.path);
  const stream = new StreamRpcTarget({
    auth: input.auth,
    path,
    projectId: input.projectId,
  });
  const [, createRequested] = await stream.append(
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName: streamDurableObjectName({ projectId: input.projectId, path }),
      processorSlug: RepoProcessorContract.slug,
      subscriberType: "repo",
    }),
    {
      type: "events.iterate.com/repo/create-requested",
      idempotencyKey: `repo-create-requested:${input.projectId}:${path}`,
      payload: { projectId: input.projectId, path },
    },
  );

  await stream.waitForEvent({
    afterOffset: createRequested.offset - 1,
    eventTypes: ["events.iterate.com/repo/created"],
    predicate: (event) =>
      event.payload?.projectId === input.projectId && event.payload?.path === path,
    // Generous: repo create clones/seeds a CF Artifacts repo; cold slots under
    // parallel e2e load have been seen to straggle past 60s.
    timeoutMs: 120_000,
  });

  return new RepoRpcTarget({ auth: input.auth, path, projectId: input.projectId });
}

class RepoRpcTarget extends RpcTarget implements Repo {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.REPO.getByName(
      DurableObjectNameCodec.stringify(
        {
          projectId: this.props.projectId,
          path: normalizePath(this.props.path),
        },
        { allowNullProjectId: true },
      ),
    );
  }

  create() {
    return requestRepoCreate({
      auth: this.props.auth,
      path: this.props.path,
      projectId: this.props.projectId,
    });
  }

  whoami() {
    return this.durableObjectStub.whoami();
  }

  commitFiles(input: Parameters<Repo["commitFiles"]>[0]) {
    return this.durableObjectStub.commitFiles(input);
  }

  listFiles() {
    return this.durableObjectStub.listFiles();
  }

  readFile(input: Parameters<Repo["readFile"]>[0]) {
    return this.durableObjectStub.readFile(input);
  }

  get processor() {
    return this.durableObjectStub.processor;
  }
}

class RepoCollectionRpcTarget extends RpcTarget implements RepoCollection {
  constructor(readonly props: { auth: ItxAuth; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  create(input: Parameters<RepoCollection["create"]>[0]) {
    return requestRepoCreate({
      auth: this.props.auth,
      path: input.path,
      projectId: this.props.projectId,
    });
  }

  get(path: string) {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: normalizePath(path),
      projectId: this.props.projectId,
    });
  }
}

class ProjectRepoCollectionRpcTarget
  extends RepoCollectionRpcTarget
  implements ProjectRepoCollection
{
  constructor(readonly projectProps: { auth: ItxAuth; projectId: string }) {
    super(projectProps);
  }

  list() {
    return projectProcessorState(this.projectProps.projectId).then((state) => state.repos);
  }
}

class AgentCollectionRpcTarget extends RpcTarget implements AgentCollection {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get(path: string) {
    return new AgentRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: normalizeAgentPath(path),
      projectId: this.props.projectId,
    });
  }

  list() {
    return projectProcessorState(this.props.projectId).then((state) => state.agents);
  }
}

class SecretCollectionRpcTarget extends RpcTarget implements SecretCollection {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get(path: string) {
    return new SecretRpcTarget({
      auth: this.props.auth,
      path: normalizeSecretPath(path),
      projectId: this.props.projectId,
    });
  }

  list() {
    return projectProcessorState(this.props.projectId).then((state) => state.secrets);
  }
}

class SecretRpcTarget extends RpcTarget implements Secret {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalizeSecretPath(this.props.path),
      }),
    );
  }

  describe() {
    return this.durableObjectStub.describe();
  }

  fetch(request: Parameters<Secret["fetch"]>[0]) {
    return this.durableObjectStub.fetch(request);
  }

  update(input: Parameters<Secret["update"]>[0]) {
    return this.durableObjectStub.update(input);
  }

  get processor() {
    return this.durableObjectStub.processor;
  }
}

type AiRunOptions = NonNullable<Parameters<Env["AI"]["run"]>[2]>;

class AiRpcTarget extends RpcTarget implements Ai {
  constructor(readonly props: { gateway?: AiRunOptions["gateway"] } = {}) {
    super();
  }

  models() {
    return Promise.resolve(env.AI.models());
  }

  run(...[model, body]: Parameters<Ai["run"]>) {
    const options: AiRunOptions | undefined =
      this.props.gateway === undefined ? undefined : { gateway: this.props.gateway };
    return env.AI.run(model, body as Record<string, unknown>, options);
  }
}

/**
 * The `itx.slack` built-in: a Slack Web API proxy for the project's connected
 * workspace. Dotted Web API method paths (`itx.slack.chat.postMessage({...})`)
 * resolve through the dynamic path-call fallback onto `invokeCapability`;
 * authorization uses the project's stored bot token through the secret
 * substitution egress pipeline (domains/integrations/slack-api.ts).
 */
class SlackRpcTarget extends RpcTarget implements SlackCapability {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  /** itx path-call surface: itx.slack.<Slack Web API method path>(body). */
  async invokeCapability(call: Parameters<SlackCapability["invokeCapability"]>[0]) {
    const { args = [], path } = call;
    const method = path.join(".");
    if (!method) {
      throw new Error("itx.slack expected a Slack Web API method path.");
    }
    if (args.length > 1) {
      throw new Error(`Slack calls are unary; ${method} received ${args.length} args.`);
    }
    return await this.request({
      body: args[0] as Record<string, unknown> | undefined,
      method,
    });
  }

  async request(input: Parameters<SlackCapability["request"]>[0]) {
    return await callProjectSlackWebApi({
      body: input.body ?? {},
      method: input.method,
      projectId: this.props.projectId,
    });
  }
}

/** The `itx.gmail` built-in: Gmail REST proxy for the project's Google account. */
class GmailRpcTarget extends RpcTarget implements GmailCapability {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async request(request: Parameters<GmailCapability["request"]>[0]) {
    const token = await getFreshGoogleAccessToken({
      config: parseConfig(env),
      projectId: this.props.projectId,
    });
    return await callGmailApi({ request, token });
  }
}

/**
 * The `itx.integrations` built-in: connection status, OAuth start/complete,
 * and disconnect for slack/google. The complete* methods are called by the
 * app worker's OAuth callback routes (/api/integrations/<provider>/callback);
 * their authority is the HMAC-signed OAuth state minted by startOAuthFlow,
 * verified itx-side.
 */
class IntegrationsRpcTarget extends RpcTarget implements ProjectIntegrations {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  getConnection(input: Parameters<ProjectIntegrations["getConnection"]>[0]) {
    return getConnectionStatus({ projectId: this.props.projectId, provider: input.provider });
  }

  startOAuthFlow(input: Parameters<ProjectIntegrations["startOAuthFlow"]>[0]) {
    return startOAuthFlow({
      callbackUrl: input.callbackUrl,
      config: parseConfig(env),
      projectId: this.props.projectId,
      provider: input.provider,
      userId: input.userId,
    });
  }

  completeSlackConnect(input: Parameters<ProjectIntegrations["completeSlackConnect"]>[0]) {
    return completeSlackConnect({
      code: input.code,
      config: parseConfig(env),
      projectId: this.props.projectId,
      state: input.state,
      userId: input.userId,
    });
  }

  completeGoogleConnect(input: Parameters<ProjectIntegrations["completeGoogleConnect"]>[0]) {
    return completeGoogleConnect({
      code: input.code,
      config: parseConfig(env),
      projectId: this.props.projectId,
      state: input.state,
      userId: input.userId,
    });
  }

  disconnect(input: Parameters<ProjectIntegrations["disconnect"]>[0]) {
    return disconnectProvider({
      config: parseConfig(env),
      projectId: this.props.projectId,
      provider: input.provider,
    });
  }
}

/**
 * Deployment-wide integration ingress: routes validly-signed Slack webhooks to
 * the project that claimed the team. Admin/internal only — this is the door
 * the app worker's webhook route calls with the admin API secret.
 */
class SessionIntegrationsRpcTarget extends RpcTarget implements SessionIntegrations {
  constructor(readonly props: { auth: ItxAuth }) {
    super();
    if (!props.auth.isAdmin()) {
      throw new Error(`principal "${props.auth.principal}" cannot access deployment integrations`);
    }
  }

  routeSlackWebhook(input: Parameters<SessionIntegrations["routeSlackWebhook"]>[0]) {
    return routeSlackWebhook(input);
  }
}

class AgentChatRpcTarget extends RpcTarget implements AgentChat {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get stream() {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: this.props.path,
    });
  }

  async sendMessage(input: Parameters<AgentChat["sendMessage"]>[0]) {
    const message = input.message.trim();
    if (message === "") throw new Error("itx.chat.sendMessage requires a non-empty message.");
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/web-message-sent",
      payload: { message },
    });
    return event;
  }
}

class AgentRpcTarget extends RpcTarget implements Agent {
  constructor(
    readonly props: { auth: ItxAuth; ctx: CfExecutionContext; path: string; projectId: string },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    props.path = normalizeAgentPath(props.path);
    return withInvokeCapabilityFallback(this);
  }

  get #itx() {
    return env.ITX.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  get durableObjectStub() {
    return env.AGENT.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  get processor() {
    return this.durableObjectStub.processor;
  }

  get stream() {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: this.props.path,
    });
  }

  get chat() {
    return new AgentChatRpcTarget({
      auth: this.props.auth,
      path: this.props.path,
      projectId: this.props.projectId,
    });
  }

  async sendMessage(message: string) {
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { content: message, origin: "web" },
    });
    return event;
  }

  async ask(input: Parameters<Agent["ask"]>[0]) {
    const sent = await this.sendMessage(input.message);
    return await this.stream.waitForEvent({
      afterOffset: sent.offset,
      eventTypes: ["events.iterate.com/agents/web-message-sent"],
      timeoutMs: 45_000,
    });
  }

  whoami() {
    return `agent ${this.props.projectId}:${this.props.path}`;
  }

  async provideCapability(input: Parameters<Agent["provideCapability"]>[0]) {
    rejectBuiltinCollision(this, input.path);
    const provision = await this.#itx.provideCapability(input);

    // The ITX Durable Object returns the durable mount coordinates. The public
    // RPC surface returns an ownership handle that can revoke that exact mount
    // on explicit revoke or disposal.
    return new CapabilityProvisionRpcTarget({
      ctx: this.props.ctx,
      path: input.path,
      providedAtOffset: provision.providedAtOffset,
      revoke: (revokeInput) => this.#itx.revokeCapability(revokeInput),
    });
  }

  async revokeCapability(input: Parameters<Agent["revokeCapability"]>[0]) {
    await this.#itx.revokeCapability(input);
  }

  async runScript(code: string) {
    return await this.#itx.runScript(code);
  }

  async invokeCapability({ args = [], path }: Parameters<SlackCapability["invokeCapability"]>[0]) {
    return await this.#itx.invokeCapability({ args, path });
  }
}

/**
 * Public project-facing worker collection.
 *
 * `get(ref)` mirrors the desired capability-tree shape:
 * `itx.projects.get("prj").workers.get(ref).someRpcMethod()`.
 */
class DynamicWorkerCollectionRpcTarget extends RpcTarget implements DynamicWorkerCollection {
  constructor(
    readonly props: {
      auth: ItxAuth;
      ctx: CfExecutionContext;
      loader: Env["LOADER"];
      projectId: string;
    },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get<T extends object = Record<string, unknown>>(
    ref: Parameters<DynamicWorkerCollection["get"]>[0],
  ) {
    const parsed = WorkerRefSchema.parse(ref);
    return new DynamicWorkerRpcTarget({
      ctx: this.props.ctx,
      loader: this.props.loader,
      projectId: this.props.projectId,
      ref: parsed,
    }) as unknown as DynamicWorkerCapability<T>;
  }
}

/**
 * RPC wrapper around a single DynamicWorkerRef.
 *
 * The returned object is a path proxy: unknown properties become path segments
 * and eventually call `invokeCapability`. Dynamic workers do not share a fixed
 * method surface, so this wrapper deliberately exposes no method names beyond
 * the flattened capability dispatcher.
 */
class DynamicWorkerRpcTarget extends RpcTarget {
  readonly #runner: DynamicWorkerRunner;
  readonly #ref: DynamicWorkerRef;

  constructor(props: {
    ctx: CfExecutionContext;
    loader: Env["LOADER"];
    projectId: string;
    ref: DynamicWorkerRef;
  }) {
    super();
    this.#ref = props.ref;
    const itxScope = itxEntrypointProps({
      path: normalizePath(props.ref.path),
      projectId: props.projectId,
    });
    this.#runner = new DynamicWorkerRunner({
      bindings: {
        // The dynamic worker's ITX binding is supplied by the host context, not
        // by the worker ref. Props remain worker-supplied, but auth/scope stay
        // under the project/agent/ITX object that is doing the hosting.
        ITX: itxEntrypointBinding(props.ctx.exports, itxScope),
      },
      globalOutbound: projectEgressFetcher(props.ctx.exports, props.projectId),
      loader: props.loader,
      projectId: props.projectId,
      workerScopeKey: itxEntrypointScopeCacheKey(itxScope),
    });
    return withInvokeCapabilityFallback(this);
  }

  async invokeCapability({
    args = [],
    flattenNestedPath = false,
    path,
  }: {
    args?: unknown[];
    flattenNestedPath?: boolean;
    path: string[];
  }) {
    // Keep every dynamic worker invocation behind DynamicWorkerRunner. Stateless
    // entrypoints, stateful DO facets, provided worker capabilities, and
    // project.worker all then share the same loader/egress/ITX binding rules.
    // Return values pass through untouched on purpose: an RpcTarget returned by
    // the dynamic worker must remain a live object-capability so Cap'n Web can
    // serialize it as a chained/pipelined stub for the outer caller.
    return await this.#runner.invokeCapability({
      args,
      flattenNestedPath,
      path,
      ref: this.#ref,
    });
  }
}

export class ProjectCollectionRpcTarget extends RpcTarget implements ProjectCollection {
  constructor(readonly props: { auth: ItxAuth; config?: AppConfig; ctx: CfExecutionContext }) {
    super();
  }

  async get(projectId: string) {
    // Guard the id shape: itx state is namespaced by whatever string lands
    // here, so an unvalidated slug (e.g. `cli itx run --context <slug>`) would
    // silently manufacture a phantom project namespace instead of failing.
    if (!projectId.startsWith("prj_")) {
      throw new Error(
        `"${projectId}" is not a project id (expected "prj_..."). Resolve slugs to ids first.`,
      );
    }
    // Claims can lag right after a create; the auth context may consult the
    // project directory and widen itself before the synchronous constructor
    // assert runs. Cap'n Web pipelines through the returned promise.
    await this.props.auth.ensureCanAccessProject?.(projectId);
    return new ItxRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: projectId,
    });
  }

  async create(args: Parameters<ProjectCollection["create"]>[0]) {
    const registered = await this.#registerProject(args);
    args.projectId = registered.projectId;
    // The auth worker may normalize the slug (slugify); adopt its canonical
    // form so stream events agree with the directory and ingress hostnames.
    args.slug = registered.slug;
    // The creating session can use the project immediately; a signed-in user's
    // claims catch up on the next token refresh (directory fallback covers the
    // gap for other connections).
    widenProjectAccess(this.props.auth, registered.projectId);
    // Prime the slug->id directory cache so the post-create navigation (and
    // the first project-host request) never miss into the auth worker.
    await primeProjectDirectory(env.PROJECT_DIRECTORY, {
      id: registered.projectId,
      slug: registered.slug,
      organizationId: registered.organizationId,
      name: registered.slug,
    });

    const stream = rootStream({
      auth: this.props.auth,
      projectId: args.projectId,
    });

    const [, , createRequested] = await stream.append(
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName: streamDurableObjectName({ projectId: args.projectId, path: "/" }),
        processorSlug: ProjectProcessorContract.slug,
        subscriberType: "project",
      }),
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName: streamDurableObjectName({
          projectId: args.projectId,
          path: PROJECT_REPO_PATH,
        }),
        processorSlug: RepoProcessorContract.slug,
        subscriberType: "repo",
      }),
      {
        type: "events.iterate.com/project/create-requested",
        idempotencyKey: `project-create-requested:${args.projectId}`,
        payload: { projectId: args.projectId, slug: args.slug },
      },
    );
    await stream.waitForEvent({
      afterOffset: createRequested.offset - 1,
      eventTypes: ["events.iterate.com/project/created"],
      predicate: (event) => event.payload?.projectId === args.projectId,
      // Generous: the create saga seeds the repo, probes the project worker,
      // and births the onboarding agent; cold slots under parallel e2e load
      // have been seen to straggle past 60s.
      timeoutMs: 120_000,
    });

    return new ItxRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: args.projectId,
    });
  }

  /**
   * Register the project with the auth worker before any itx state exists.
   *
   * The auth worker is the project directory and the id authority. The user
   * lane creates the org-owned directory row (which is what later puts the
   * project into the user's claims); the admin lane only needs an id. Admin
   * callers may bring their own id (test fixtures); we never mint prj_ ids
   * locally when the directory is configured.
   */
  async #registerProject(
    args: Parameters<ProjectCollection["create"]>[0],
  ): Promise<{ organizationId: string | null; projectId: string; slug: string }> {
    const userPrincipal = userPrincipalOf(this.props.auth);

    if (userPrincipal && !this.props.auth.isAdmin()) {
      const config = this.props.config;
      if (!config?.iterateAuth?.serviceToken) {
        throw new Error("project creation requires the auth worker directory to be configured");
      }
      const organizationSlug = resolveOrganizationSlugForCreate(
        userPrincipal,
        args.organizationSlug,
      );
      const created = await createAuthWorkerServiceClient(
        { config },
        { asUserId: userPrincipal.userId },
      ).internal.project.createForOrganization({
        organizationSlug,
        name: args.slug,
        slug: args.slug,
        ...(args.projectId === undefined ? {} : { id: args.projectId }),
      });
      return { organizationId: created.organizationId, projectId: created.id, slug: created.slug };
    }

    if (!this.props.auth.isAdmin()) {
      throw new Error(`principal "${this.props.auth.principal}" cannot create projects`);
    }
    if (args.projectId !== undefined) {
      return { organizationId: null, projectId: args.projectId, slug: args.slug };
    }
    const serviceToken = this.props.config?.iterateAuth?.serviceToken;
    if (this.props.config && serviceToken) {
      const minted = await createAuthWorkerServiceClient({
        config: this.props.config,
      }).internal.project.mintProjectId();
      return { organizationId: null, projectId: minted.id, slug: args.slug };
    }
    return { organizationId: null, projectId: "prj_" + crypto.randomUUID(), slug: args.slug };
  }

  /**
   * The session's projects, enriched: identity (id/slug/org) from the auth
   * claims or the project directory, deployment status from a concurrent
   * engine probe (`state.created` on each project's processor snapshot). A
   * probe failure degrades THAT entry to "unknown" — the list always renders.
   */
  async list() {
    const bases = await this.#listEntryBases();
    const outcomes = await Promise.allSettled(
      bases.map(async (base) => {
        const state = await projectProcessorState(base.id);
        return state.created === true;
      }),
    );
    const statuses = deploymentStatusesFromProbes(
      bases.map((base) => base.id),
      outcomes,
    );
    return bases.map((base) => ({
      ...base,
      deploymentStatus: statuses.get(base.id) ?? "unknown",
    }));
  }

  /**
   * Which projects the list covers, and what we know about each before the
   * engine probe:
   * - a signed-in user (including admin-role users): the access token's
   *   project claims — org name joined from the organization claims — plus any
   *   project the live context was widened to after a create (directory-read,
   *   since claims lag until the next token refresh).
   * - admin-secret / admin-cookie principals: every deployment-known project
   *   from the PROJECT_DIRECTORY KV. The directory record's `name` is the
   *   PROJECT name, so these entries carry no organization name.
   * - impersonated users (test lane): their project scopes, directory-read.
   */
  async #listEntryBases(): Promise<Omit<ProjectListEntry, "deploymentStatus">[]> {
    const userPrincipal = userPrincipalOf(this.props.auth);
    if (userPrincipal) {
      const organizationNames = new Map(
        userPrincipal.organizations.map((organization) => [
          organization.id,
          organization.name ?? null,
        ]),
      );
      const projectIds = new Set([
        ...userPrincipal.projects.map((project) => project.id),
        ...this.props.auth.listAccessibleProjects(),
      ]);
      const claims = new Map(userPrincipal.projects.map((project) => [project.id, project]));
      return await Promise.all(
        [...projectIds].map(async (projectId) => {
          const claim = claims.get(projectId);
          if (claim) {
            return {
              id: claim.id,
              slug: claim.slug,
              organizationId: claim.organizationId,
              organizationName: organizationNames.get(claim.organizationId) ?? null,
            };
          }
          return await this.#directoryEntryBase(projectId);
        }),
      );
    }

    if (this.props.auth.isAdmin()) {
      const records = await listProjectDirectory(env.PROJECT_DIRECTORY);
      return records.map((record) => ({
        id: record.id,
        slug: record.slug,
        organizationId: record.organizationId,
        organizationName: null,
      }));
    }

    return await Promise.all(
      this.props.auth
        .listAccessibleProjects()
        .map((projectId) => this.#directoryEntryBase(projectId)),
    );
  }

  async #directoryEntryBase(
    projectId: string,
  ): Promise<Omit<ProjectListEntry, "deploymentStatus">> {
    const record = await readProjectById(env.PROJECT_DIRECTORY, projectId);
    return {
      id: projectId,
      // A scope the directory has never seen (impersonated test principals)
      // still lists — the id doubles as the slug.
      slug: record?.slug ?? projectId,
      organizationId: record?.organizationId ?? null,
      organizationName: null,
    };
  }
}

type ItxRpcTargetProps = {
  auth: ItxAuth;
  ctx: CfExecutionContext;
  // Which scope's capability table backs runScript/provide/invoke and the dynamic
  // dotted-path fallback. `"/"` (or omitted) is the project root; `/agents/bla` is
  // an agent scope. The built-in members below are project-global regardless — only
  // the dynamic capability table is scoped by this path.
  itxPath?: string;
  projectId: string;
};
const PROJECT_BUILTIN_CAPABILITY_PATHS = [
  "ai",
  "agents",
  "egress",
  "gmail",
  "integrations",
  "mcp",
  "openapi",
  "processor",
  "repo",
  "repos",
  "secrets",
  "slack",
  "streams",
  "worker",
  "workers",
] as const;

/**
 * The server-side **itx** — the object an `async (itx) => { … }` script holds and
 * what `env.ITX.get()` returns. One class serves the project root and every nested
 * (agent) scope; `itxPath` selects which scope's dynamic capability table backs it.
 *
 * DESIGN NOTE — this RpcTarget sits *in front of* the ITX Durable Object. Its
 * built-in members (`streams`, `agents`, `repo`, …) are resolved here in the
 * isolate; only unknown roots fall through `withInvokeCapabilityFallback` to the
 * ITX DO's dynamic table (which itself chains up to enclosing scopes). So the
 * common `itx.streams.get(...)` path never makes a round trip just to check
 * whether `streams` was shadowed. The deliberate cost: a dynamic capability can
 * never shadow a built-in name — the built-in always wins (`rejectBuiltinCollision`
 * enforces this at provide time). If we end up needing shadowable built-ins a lot,
 * we'd move resolution behind the DO and pay the round trip; today we don't.
 */
export class ItxRpcTarget extends RpcTarget implements Itx {
  constructor(readonly props: ItxRpcTargetProps) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  get projectId() {
    return this.props.projectId;
  }

  get durableObjectStub() {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  async describe() {
    const [project, mountedCapabilities] = await Promise.all([
      this.durableObjectStub.describe(),
      this.#itx.describeCapabilities(),
    ]);
    return {
      ...project,
      capabilities: [
        ...PROJECT_BUILTIN_CAPABILITY_PATHS.map((path) => ({
          path: [path],
          type: "builtin" as const,
        })),
        ...mountedCapabilities,
      ],
    };
  }

  get processor() {
    return this.durableObjectStub.processor;
  }

  get ai() {
    return new AiRpcTarget();
  }

  // `agent` and `chat` exist only when this itx is scoped under `/agents/` — i.e.
  // when it IS an agent context. They are derived from the scope path rather than
  // mounted as capabilities: being an agent is a property of where the itx sits,
  // not something a caller provided, so a getter keeps zero durable state, needs
  // no bootstrap step, and means `env.ITX.get()` can return this one class at any
  // path with no per-scope branching. On a project-root itx both are undefined.
  get agent(): Agent | undefined {
    return this.props.itxPath?.startsWith("/agents/")
      ? this.agents.get(this.props.itxPath)
      : undefined;
  }

  get chat(): AgentChat | undefined {
    return this.agent?.chat;
  }

  get #itx() {
    return env.ITX.getByName(
      DurableObjectNameCodec.stringify({
        path: this.props.itxPath ?? "/",
        projectId: this.props.projectId,
      }),
    );
  }

  async provideCapability(input: Parameters<Itx["provideCapability"]>[0]) {
    rejectBuiltinCollision(this, input.path);
    const provision = await this.#itx.provideCapability(input);
    // The ITX Durable Object returns the durable mount coordinates. The public
    // RPC surface returns an ownership handle that can revoke that exact mount
    // on explicit revoke or disposal.
    return new CapabilityProvisionRpcTarget({
      ctx: this.props.ctx,
      path: input.path,
      providedAtOffset: provision.providedAtOffset,
      revoke: (revokeInput) => this.#itx.revokeCapability(revokeInput),
    });
  }

  async revokeCapability(input: Parameters<Itx["revokeCapability"]>[0]) {
    await this.#itx.revokeCapability(input);
  }

  async runScript(code: string) {
    return await this.#itx.runScript(code);
  }

  invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    return this.#itx.invokeCapability({ args, path });
  }

  get streams() {
    return new ProjectStreamCollectionRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get agents() {
    return new AgentCollectionRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: this.props.projectId,
    });
  }

  get egress() {
    return new ProjectEgressRpcTarget({ projectId: this.props.projectId });
  }

  get gmail(): GmailCapability {
    return new GmailRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get integrations(): ProjectIntegrations {
    return new IntegrationsRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get slack(): SlackCapability {
    return new SlackRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get mcp(): McpClientCollection {
    return new McpClientCollectionRpcTarget({
      egress: projectEgressFetcher(this.props.ctx.exports, this.props.projectId),
    });
  }

  get openapi(): OpenApiCollection {
    return new OpenApiCollectionRpcTarget({
      egress: projectEgressFetcher(this.props.ctx.exports, this.props.projectId),
    });
  }

  get repos() {
    return new ProjectRepoCollectionRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get secrets() {
    return new SecretCollectionRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get repo() {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: PROJECT_REPO_PATH,
      projectId: this.props.projectId,
    });
  }

  get workers() {
    return new DynamicWorkerCollectionRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      loader: env.LOADER,
      projectId: this.props.projectId,
    });
  }

  get worker() {
    // `project.worker` is only a convenience alias for the default repo-backed
    // stateless worker. The general API is `project.workers.get(ref)`.
    return this.workers.get<ProjectWorker>(defaultProjectWorkerRef());
  }
}

function defaultProjectWorkerRef(): StatelessDynamicWorkerRef {
  return {
    path: "/",
    source: {
      repoPath: PROJECT_REPO_PATH,
      sourcePath: PROJECT_WORKER_SOURCE_PATH,
      type: "repo",
    },
    type: "stateless",
  };
}

async function projectProcessorState(projectId: string) {
  const project = env.PROJECT.getByName(DurableObjectNameCodec.stringify({ path: "/", projectId }));
  const processor = await project.processor;
  const { state } = await processor.snapshot();
  return state;
}

class SessionRpcTarget extends RpcTarget implements Session {
  constructor(readonly props: { auth: ItxAuth; config?: AppConfig; ctx: CfExecutionContext }) {
    super();
  }

  get integrations() {
    return new SessionIntegrationsRpcTarget({ auth: this.props.auth });
  }

  get streams() {
    return new StreamCollectionRpcTarget({
      auth: this.props.auth,
      projectId: null,
    });
  }

  get repos() {
    return new RepoCollectionRpcTarget({
      auth: this.props.auth,
      projectId: null,
    });
  }

  get projects() {
    return new ProjectCollectionRpcTarget({
      auth: this.props.auth,
      config: this.props.config,
      ctx: this.props.ctx,
    });
  }

  whoami() {
    return this.props.auth.principal;
  }
}

export class UnauthenticatedItxRpcTarget extends RpcTarget implements UnauthenticatedItx {
  constructor(
    readonly props: {
      config: AppConfig;
      ctx: CfExecutionContext;
      headers: Headers;
      requestUrl: string;
    },
  ) {
    super();
  }

  async authenticate(input: Parameters<UnauthenticatedItx["authenticate"]>[0]) {
    const auth = await resolveItxAuth({
      config: this.props.config,
      credentials: input,
      headers: this.props.headers,
      requestUrl: this.props.requestUrl,
    });
    return new SessionRpcTarget({ auth, config: this.props.config, ctx: this.props.ctx });
  }
}

// ---------------------------------------------------------------------------
// Every RpcTarget class lives in this module (design rule): ownership handles,
// built-in capability targets, and read-only facades included. Durable Object
// and entrypoint classes stay in their domain folders.
// ---------------------------------------------------------------------------

type RevokeCapability = (input: RevokeCapabilityInput) => Promise<void>;

/**
 * Ownership handle for one `provideCapability()` call.
 *
 * Cap'n Web and Workers RPC model returned class instances as object
 * capabilities: callers hold a stub and dispose that stub when they are done.
 * See:
 * - https://github.com/cloudflare/capnweb#memory-management
 * - https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 *
 * We still keep the explicit `revoke()` method because it is a domain operation
 * callers can await and assert on. `[Symbol.dispose]` is the lifecycle fallback
 * for scopes (`using provision = ...`) and abandoned stubs. The handle is keyed
 * by the stream offset that mounted the capability, so disposing an older
 * provision after a replacement cannot revoke the newer mount at the same path.
 */
export class CapabilityProvisionRpcTarget extends RpcTarget implements CapabilityProvision {
  readonly #ctx: Pick<CfExecutionContext, "waitUntil"> | undefined;
  readonly #path: string[];
  readonly #providedAtOffset: number;
  readonly #revoke: RevokeCapability;
  #revokePromise: Promise<void> | undefined;

  constructor(args: {
    ctx?: Pick<CfExecutionContext, "waitUntil">;
    path: string[];
    providedAtOffset: number;
    revoke: RevokeCapability;
  }) {
    super();
    this.#ctx = args.ctx;
    this.#path = [...args.path];
    this.#providedAtOffset = args.providedAtOffset;
    this.#revoke = args.revoke;
  }

  get path() {
    return [...this.#path];
  }

  get providedAtOffset() {
    return this.#providedAtOffset;
  }

  async revoke() {
    await this.#startRevoke();
  }

  [Symbol.dispose](): void {
    const work = this.#startRevoke().catch((error: unknown) => {
      console.error("capability provision dispose failed", {
        error,
        path: this.#path,
        providedAtOffset: this.#providedAtOffset,
      });
    });
    this.#ctx?.waitUntil?.(work);
  }

  #startRevoke(): Promise<void> {
    this.#revokePromise ??= this.#revoke({
      path: this.#path,
      providedAtOffset: this.#providedAtOffset,
    });
    return this.#revokePromise;
  }
}

/**
 * RPC ownership handle for a live stream connection.
 *
 * This follows Cap'n Web/Workers RPC lifecycle conventions: returned class
 * instances are object capabilities, and `using`/`[Symbol.dispose]` releases
 * the caller's ownership of the live resource.
 *
 * Docs:
 * - https://github.com/cloudflare/capnweb#memory-management
 * - https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 *
 * `unsubscribe()` remains the explicit, awaitable domain operation. Disposal is
 * the scoped cleanup path and calls the same captured close function. Capturing
 * the close function matters: a later subscription can reuse the same key, and
 * an old handle must not look up by key and close the replacement.
 */
export class StreamSubscriptionRpcTarget extends RpcTarget implements StreamSubscriptionHandle {
  readonly #close: () => void;
  readonly #streamMaxOffset: number;
  readonly #subscriptionKey: string;
  #closed = false;

  constructor(args: { close: () => void; streamMaxOffset: number; subscriptionKey: string }) {
    super();
    this.#close = args.close;
    this.#streamMaxOffset = args.streamMaxOffset;
    this.#subscriptionKey = args.subscriptionKey;
  }

  get subscriptionKey() {
    return this.#subscriptionKey;
  }

  get streamMaxOffset() {
    return this.#streamMaxOffset;
  }

  unsubscribe() {
    this.#closeOnce();
  }

  [Symbol.dispose](): void {
    this.#closeOnce();
  }

  #closeOnce(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#close();
  }
}

/**
 * Public project egress facet.
 *
 * The Project Durable Object is the single egress decision point: it owns the
 * live runtime interceptor slot and, when there is no interceptor, performs the
 * terminal secret-substitution fetch path.
 */
export class ProjectEgressRpcTarget extends RpcTarget implements ProjectEgress {
  constructor(readonly props: { projectId: string }) {
    super();
  }

  fetch(request: Parameters<ProjectEgress["fetch"]>[0]) {
    return projectStub(env.PROJECT, this.props.projectId).fetch(request);
  }

  intercept(handler: Parameters<ProjectEgress["intercept"]>[0]) {
    return projectStub(env.PROJECT, this.props.projectId).interceptEgress(handler);
  }
}

/**
 * Disposable ownership handle returned by `project.egress.intercept(...)`.
 *
 * The Project Durable Object owns the retained live callback. This handle only
 * releases that exact retained callback if it is still the current interceptor.
 */
export class ProjectEgressInterceptRpcTarget extends RpcTarget implements ProjectEgressIntercept {
  readonly #ctx: Pick<CfExecutionContext, "waitUntil"> | undefined;
  readonly #release: () => void | Promise<void>;
  #releasePromise: Promise<void> | undefined;

  constructor(args: {
    ctx?: Pick<CfExecutionContext, "waitUntil">;
    release: () => void | Promise<void>;
  }) {
    super();
    this.#ctx = args.ctx;
    this.#release = args.release;
  }

  async release() {
    await this.#startRelease();
  }

  [Symbol.dispose](): void {
    const work = this.#startRelease().catch((error: unknown) => {
      console.error("project egress intercept dispose failed", { error });
    });
    this.#ctx?.waitUntil?.(work);
  }

  #startRelease(): Promise<void> {
    this.#releasePromise ??= Promise.resolve(this.#release());
    return this.#releasePromise;
  }
}

/**
 * The read-only capability a host hands out for one of its processors.
 *
 * A `StreamProcessor` is itself an `RpcTarget`, so returning the instance
 * directly over RPC would expose its host-only plumbing — most dangerously
 * `ingest`, which drives the durable checkpoint. A caller could then call
 * `ingest` with a fabricated high-offset event and fast-forward the checkpoint
 * past every real event, permanently silencing the processor (and run its side
 * effects for events that were never committed). This facade forwards only the
 * four inspection methods of the public `StreamProcessorRpc` contract, so the
 * dangerous surface never crosses the RPC boundary.
 */
export class StreamProcessorRpcTarget<Contract extends StreamProcessorContract>
  extends RpcTarget
  implements StreamProcessorRpc<ProcessorState<Contract>>
{
  readonly #processor: StreamProcessor<Contract, object>;

  constructor(processor: StreamProcessor<Contract, object>) {
    super();
    this.#processor = processor;
  }

  snapshot() {
    return this.#processor.snapshot();
  }

  getRuntimeState() {
    return this.#processor.getRuntimeState();
  }

  onStateChange(cb: (state: ProcessorState<Contract>) => unknown) {
    return this.#processor.onStateChange(cb);
  }

  waitUntilEvent(input: { offset: number; timeoutMs?: number }) {
    return this.#processor.waitUntilEvent(input);
  }
}

// MCP is common enough to expose as a built-in, but the built-in stays tiny:
// it is an RpcTarget that gets a project egress Fetcher and otherwise uses the
// public MCP SDK. A dynamic worker can implement the same shape by calling
// env.ITX.get().egress.fetch through its single ITX binding.
type McpClientDeps = { egress: Fetcher };

type McpRequestOptions = { timeout?: number };

export class McpClientCollectionRpcTarget extends RpcTarget implements McpClientCollection {
  constructor(readonly props: McpClientDeps) {
    super();
  }

  connect(input: Parameters<McpClientCollection["connect"]>[0]) {
    return McpClientRpcTarget.connect(input, this.props);
  }
}

class McpClientRpcTarget extends RpcTarget {
  static async connect(input: McpClientConnectInput, deps: McpClientDeps) {
    return new McpClientRpcTarget({ config: input, egress: deps.egress });
  }

  constructor(
    readonly props: {
      config: McpClientConnectInput;
      egress: Fetcher;
    },
  ) {
    super();
    return withInvokeCapabilityFallback(this);
  }

  async invokeCapability({ args = [], path }: Parameters<SlackCapability["invokeCapability"]>[0]) {
    const options = this.props.config.timeoutMs
      ? { timeout: this.props.config.timeoutMs }
      : undefined;
    const client = await connectMcp(this.props.config, this.props.egress, options);
    try {
      return await executeMcpToolCall({ args, client, options, path });
    } finally {
      await client.close().catch(() => {});
    }
  }
}

async function connectMcp(
  input: McpClientConnectInput,
  egress: Fetcher,
  options?: McpRequestOptions,
): Promise<McpSdkClient> {
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    fetch: (fetchInput: Request | string | URL, init?: RequestInit) => {
      const request =
        fetchInput instanceof Request
          ? new Request(fetchInput, init)
          : new Request(String(fetchInput), init);
      // Streamable HTTP may probe a standalone GET SSE channel. This reference
      // client is deliberately connect -> call -> close, so answering 405 keeps
      // every invocation stateless and avoids pinning a stream through egress.
      if (request.method === "GET") {
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      // Headers may contain getSecret({ path }) placeholders. Egress owns
      // substitution and origin checks, so the MCP adapter just forwards the
      // SDK-built Request unchanged.
      return egress.fetch(request);
    },
    requestInit: input.headers ? { headers: input.headers } : undefined,
  });
  const client = new McpSdkClient({ name: "minimal-itx-v4-mcp-client", version: "1.0.0" });
  try {
    await client.connect(transport, options);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function executeMcpToolCall(input: {
  args: unknown[];
  client: McpSdkClient;
  options?: McpRequestOptions;
  path: string[];
}) {
  const [name, ...extraPath] = input.path;
  if (!name) throw new Error("MCP tool calls need a tool name path.");
  if (extraPath.length > 0) {
    throw new Error(`MCP tools are flat tool names, got "${input.path.join(".")}".`);
  }
  const [firstArg] = input.args;
  const toolArguments =
    firstArg != null && typeof firstArg === "object" && !Array.isArray(firstArg)
      ? (firstArg as Record<string, unknown>)
      : {};

  const result = await input.client.callTool(
    { name, arguments: toolArguments },
    undefined,
    input.options,
  );
  // Prefer structured content when a server provides it; otherwise fall back to
  // the text content convention used by many simple MCP servers.
  if (result.structuredContent != null) return result.structuredContent;

  if (result.isError) {
    const message = extractTextContent(result.content).join("\n") || "MCP tool call failed";
    throw new Error(message);
  }

  const textParts = extractTextContent(result.content);
  if (textParts.length > 0) {
    const text = textParts.join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return result;
}

function extractTextContent(content: unknown) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    item != null &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [item.text]
      : [],
  );
}

// First-party OpenAPI is just an RpcTarget hosted by Project. The only special
// power it receives is project egress, which is also the path a user-provided
// dynamic worker would use through env.ITX. That keeps the built-in and dynamic
// implementations aligned: fetch spec, derive operations, then dispatch calls.
type OpenApiDeps = { egress: Fetcher };

export class OpenApiCollectionRpcTarget extends RpcTarget implements OpenApiCollection {
  constructor(readonly props: OpenApiDeps) {
    super();
  }

  connect(input: Parameters<OpenApiCollection["connect"]>[0]) {
    return OpenApiRpcTarget.connect(input, this.props);
  }
}

class OpenApiRpcTarget extends RpcTarget {
  static async connect(input: OpenApiConnectInput, deps: OpenApiDeps) {
    const spec = await fetchSpec(input, deps.egress);
    return new OpenApiRpcTarget({
      config: input,
      egress: deps.egress,
      operations: listOpenApiOperations(spec),
      spec,
    });
  }

  constructor(
    readonly props: {
      config: OpenApiConnectInput;
      egress: Fetcher;
      operations: OpenApiOperation[];
      spec: Record<string, unknown>;
    },
  ) {
    super();
    return withInvokeCapabilityFallback(this);
  }

  async invokeCapability({ args = [], path }: Parameters<SlackCapability["invokeCapability"]>[0]) {
    const operationId = path[0];
    if (!operationId) throw new Error("OpenAPI operation calls need an operationId path.");
    if (path.length > 1) {
      throw new Error(`OpenAPI operations are flat operationIds, got "${path.join(".")}".`);
    }
    const operation = this.props.operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!operation) {
      throw new Error(`Operation "${operationId}" is not in the OpenAPI spec.`);
    }
    return await executeOperation({
      egress: this.props.egress,
      input: args[0],
      operation,
      props: this.props.config,
      spec: this.props.spec,
    });
  }
}

async function fetchSpec(
  props: OpenApiConnectInput,
  egress: Fetcher,
): Promise<Record<string, unknown>> {
  const specHost = new URL(props.specUrl).host;
  const apiHost = props.baseUrl ? new URL(props.baseUrl).host : specHost;
  // Headers can contain getSecret({ path: "/secrets/..." }) placeholders.
  // They must enter the project egress pipe, because that is the only place
  // secret material is substituted. Do not read or rewrite them here.
  const response = await egress.fetch(
    new Request(props.specUrl, { headers: specHost === apiHost ? (props.headers ?? {}) : {} }),
  );
  if (!response.ok) {
    throw new Error(`Fetching the OpenAPI spec at ${props.specUrl} returned ${response.status}.`);
  }
  const spec = (await response.json()) as Record<string, unknown>;
  if (!spec || typeof spec !== "object" || typeof spec.openapi !== "string") {
    throw new Error(`Fetching the OpenAPI spec at ${props.specUrl} did not return OpenAPI JSON.`);
  }
  return spec;
}

async function executeOperation(args: {
  egress: Fetcher;
  input: unknown;
  operation: OpenApiOperation;
  props: OpenApiConnectInput;
  spec: Record<string, unknown>;
}): Promise<unknown> {
  const { operation, props, spec } = args;
  const input =
    args.input != null && typeof args.input === "object" && !Array.isArray(args.input)
      ? { ...(args.input as Record<string, unknown>) }
      : {};

  let resolvedPath = operation.path;
  const query: Array<[string, string]> = [];
  for (const parameter of operation.parameters) {
    const value = input[parameter.name];
    if (parameter.in === "path") {
      if (value == null) {
        throw new Error(`Operation "${operation.operationId}" needs "${parameter.name}".`);
      }
      resolvedPath = resolvedPath.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(String(value)),
      );
      delete input[parameter.name];
    } else if (parameter.in === "query") {
      if (value == null && parameter.required) {
        throw new Error(
          `Operation "${operation.operationId}" needs query parameter "${parameter.name}".`,
        );
      }
      if (value != null) query.push([parameter.name, String(value)]);
      delete input[parameter.name];
    }
  }

  if (!operation.requestBody) {
    const leftover = Object.keys(input);
    if (leftover.length > 0) {
      const valid = operation.parameters
        .filter((parameter) => parameter.in === "path" || parameter.in === "query")
        .map((parameter) => parameter.name);
      throw new Error(
        `Operation "${operation.operationId}" has no request body and got unknown input ` +
          `key${leftover.length > 1 ? "s" : ""} ${leftover.map((key) => JSON.stringify(key)).join(", ")} — ` +
          (valid.length > 0 ? `valid params: ${valid.join(", ")}.` : `it takes no parameters.`),
      );
    }
  }

  const url = new URL(resolvedPath.replace(/^\//, ""), requestBase(props, spec));
  for (const [name, value] of query) url.searchParams.set(name, value);

  let body: string | undefined;
  if (operation.requestBody && Object.keys(input).length > 0) {
    // One input object is split into path/query params first; leftovers are the
    // JSON body. Non-object request bodies use `{ body }` so the convention is
    // still representable as one TypeScript parameter.
    const single =
      Object.keys(input).length === 1 &&
      "body" in input &&
      !isObjectSchema(operationBodySchema(operation, spec));
    body = JSON.stringify(single ? input.body : input);
  }
  const headers = new Headers(props.headers ?? {});
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await args.egress.fetch(
    new Request(url, { body, headers, method: operation.method.toUpperCase() }),
  );
  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `${operation.method.toUpperCase()} ${url.pathname} (${operation.operationId}) ` +
        `returned ${response.status}${snippet ? `: ${snippet}` : ""}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? await response.json() : await response.text();
}

function requestBase(props: OpenApiConnectInput, spec: Record<string, unknown>): string {
  if (props.baseUrl) return ensureTrailingSlash(props.baseUrl);
  const servers = spec.servers as Array<{ url?: string }> | undefined;
  const serverUrl = servers?.[0]?.url;
  if (serverUrl) return ensureTrailingSlash(new URL(serverUrl, props.specUrl).toString());
  return new URL("/", props.specUrl).toString();
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
