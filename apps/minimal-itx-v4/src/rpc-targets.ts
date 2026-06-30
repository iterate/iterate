import { env, RpcTarget } from "cloudflare:workers";
import {
  FakeAuthContext,
  ITX_AUTH_COOKIE,
  parseItxAuthToken,
  readCookie,
  TRUSTED_INTERNAL_ITX_TOKEN,
} from "./auth.ts";
import type { Env } from "./env.ts";
import { DurableObjectNameCodec, normalizePath } from "./domains/durable-object-names.ts";
import { normalizeAgentPath } from "./domains/agents/utils.ts";
import { CapabilityProvisionRpcTarget } from "./domains/itx/capability-provision.ts";
import { McpClientCollectionRpcTarget } from "./domains/itx/mcp-client-rpc-target.ts";
import { OpenApiCollectionRpcTarget } from "./domains/itx/openapi-rpc-target.ts";
import {
  itxEntrypointProps,
  itxEntrypointScopeCacheKey,
  rejectBuiltinCollision,
  withInvokeCapabilityFallback,
} from "./domains/itx/utils.ts";
import { ProjectEgressRpcTarget } from "./domains/projects/egress.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor-contract.ts";
import { projectEgressFetcher } from "./domains/projects/utils.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor-contract.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "./domains/repos/utils.ts";
import { normalizeSecretPath } from "./domains/secrets/utils.ts";
import {
  buildDurableObjectProcessorSubscriptionConfiguredEvent,
  resolveStreamPath,
} from "./domains/streams/utils.ts";
import { DynamicWorkerRef as WorkerRefSchema } from "./domains/workers/schemas.ts";
import { DynamicWorkerRunner } from "./domains/workers/worker-runner.ts";
import type {
  Agent,
  AgentCollection,
  AgentItx,
  CfExecutionContext,
  ItxAuth,
  ItxRoot,
  McpClientCollection,
  OpenApiCollection,
  Project,
  CapabilityDescription,
  ProjectDescription,
  ProjectCollection,
  ProjectRepoCollection,
  ProjectStreamCollection,
  ProjectWorker,
  Repo,
  RepoCollection,
  Secret,
  SecretCollection,
  StatelessDynamicWorkerRef,
  Stream,
  StreamCollection,
  StreamSubscriptionHandle,
  UnauthenticatedItx,
  DynamicWorkerCapability,
  DynamicWorkerCollection,
  DynamicWorkerRef,
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
    timeoutMs: 60_000,
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

  async sendMessage(message: string) {
    const [event] = await this.stream.append({
      type: "events.iterate.com/agent/user-message-received",
      payload: { content: message, origin: "web" },
    });
    return event;
  }

  async ask(input: Parameters<Agent["ask"]>[0]) {
    const sent = await this.sendMessage(input.message);
    return await this.stream.waitForEvent({
      afterOffset: sent.offset,
      eventTypes: ["events.iterate.com/agent/web-message-sent"],
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

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
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
        ITX: props.ctx.exports.ItxEntrypoint({ props: itxScope }),
      },
      globalOutbound: projectEgressFetcher(props.ctx.exports, props.projectId),
      loader: props.loader,
      projectId: props.projectId,
      workerScopeKey: itxEntrypointScopeCacheKey(itxScope),
    });
    return withInvokeCapabilityFallback(this);
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    // Keep every dynamic worker invocation behind DynamicWorkerRunner. Stateless
    // entrypoints, stateful DO facets, provided worker capabilities, and
    // project.worker all then share the same loader/egress/ITX binding rules.
    // Return values pass through untouched on purpose: an RpcTarget returned by
    // the dynamic worker must remain a live object-capability so Cap'n Web can
    // serialize it as a chained/pipelined stub for the outer caller.
    return await this.#runner.invokeCapability({
      args,
      path,
      ref: this.#ref,
    });
  }
}

export class ProjectCollectionRpcTarget extends RpcTarget implements ProjectCollection {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext }) {
    super();
  }

  get(projectId: string) {
    return new ProjectRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: projectId,
    });
  }

  async create(args: Parameters<ProjectCollection["create"]>[0]) {
    if (!this.props.auth.isAdmin()) {
      throw new Error(`principal "${this.props.auth.principal}" cannot create projects`);
    }

    if (args.projectId === undefined) {
      args.projectId = "prj_" + crypto.randomUUID();
    }

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
      timeoutMs: 60_000,
    });

    return new ProjectRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: args.projectId,
    });
  }

  list() {
    return this.props.auth.listAccessibleProjects();
  }
}

type ProjectRpcTargetProps = { auth: ItxAuth; ctx: CfExecutionContext; projectId: string };
const PROJECT_BUILTIN_CAPABILITY_PATHS = [
  "agents",
  "egress",
  "mcp",
  "openapi",
  "processor",
  "repo",
  "repos",
  "secrets",
  "streams",
  "worker",
  "workers",
] as const;

export class ProjectRpcTarget extends RpcTarget implements Project {
  constructor(readonly props: ProjectRpcTargetProps) {
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
      capabilities: [...projectBuiltinCapabilities(), ...mountedCapabilities],
    };
  }

  get processor() {
    return this.durableObjectStub.processor;
  }

  get #itx() {
    return env.ITX.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  async provideCapability(input: Parameters<Project["provideCapability"]>[0]) {
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

  async revokeCapability(input: Parameters<Project["revokeCapability"]>[0]) {
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

/**
 * AgentItxRpcTarget is what `itx` is in the context of an agent. So when the LLM writes functions
 * async (itx) => {...}, itx is the same as ProjectRpcTarget, except it ALSO has this .agent getter,
 * which is an itx capability host itself and we can have things like
 * itx.agent.sendMessage({ message }) available to the agent
 *
 * But itx.streams.get("/some/stream") also works, because AgentItxRpcTarget extends ProjectRpcTarget
 *
 * This is a little bit messy but fine for now
 */
export class AgentItxRpcTarget extends ProjectRpcTarget implements AgentItx {
  constructor(props: ProjectRpcTargetProps & { agentPath: string }) {
    super(props);
  }

  get agent() {
    // Agent-scoped ITX is deliberately "project plus agent". Project-level
    // capabilities stay at the root; agent-only capabilities and message APIs
    // live behind this explicit property instead of relying on fallback magic.
    return this.agents.get((this.props as ProjectRpcTargetProps & { agentPath: string }).agentPath);
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

function projectBuiltinCapabilities(): CapabilityDescription[] {
  return PROJECT_BUILTIN_CAPABILITY_PATHS.map((path) => ({ path: [path], type: "builtin" }));
}

class ItxRootRpcTarget extends RpcTarget implements ItxRoot {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext }) {
    super();
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
    return new ProjectCollectionRpcTarget({ auth: this.props.auth, ctx: this.props.ctx });
  }

  whoami() {
    return this.props.auth.principal;
  }
}

export class UnauthenticatedItxRpcTarget extends RpcTarget implements UnauthenticatedItx {
  constructor(
    readonly requestHeaders: Headers,
    readonly ctx: CfExecutionContext,
  ) {
    super();
  }

  authenticate(input: Parameters<UnauthenticatedItx["authenticate"]>[0]) {
    let auth: ItxAuth | null = null;

    if (input.type === "token") {
      auth = new FakeAuthContext(input.token);
    }

    if (input.type === "from-server-cookie") {
      const cookieToken = readCookie(this.requestHeaders.get("cookie"), ITX_AUTH_COOKIE);
      if (cookieToken) auth = new FakeAuthContext(parseItxAuthToken(cookieToken));
    }

    if (input.type === "trusted-internal" && input.token === TRUSTED_INTERNAL_ITX_TOKEN) {
      auth = new FakeAuthContext({ principal: "trusted-internal", type: "admin" });
    }

    if (!auth) throw new Error("missing or invalid auth");

    return new ItxRootRpcTarget({ auth, ctx: this.ctx });
  }
}
