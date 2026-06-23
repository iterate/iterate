import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  CfExecutionContext,
  RpcTargetImplementation,
  ItxCapabilityHost,
  ItxRoot,
  Projects,
  ItxAuthCredentials,
  ItxAuth,
  UnauthenticatedItx,
  Agent,
  Project,
  ProjectWorker,
  Repo,
  Streams,
  Agents,
  Repos,
  Stream,
  ProcessEventBatch,
} from "../types.ts";
import { DurableObjectNameCodec } from "./domains/durable-object-names.ts";
import {
  disposeIgnoredRpcResult,
  retainProcessEventBatch,
} from "./domains/streams/engine/workers/rpc-lifecycle.ts";
import type { Env } from "./env.ts";
import {
  FakeAuthContext,
  parseItxAuthToken,
  readCookie,
  ITX_AUTH_COOKIE,
  TRUSTED_INTERNAL_ITX_TOKEN,
} from "./auth.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor.ts";
import { AgentProcessorContract } from "./domains/agents/agent-processor.ts";
import { DynamicWorkersRpcTarget } from "./domains/dynamic-workers/dynamic-workers-rpc-target.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "./domains/repos/project-repo.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor.ts";
import { durableObjectProcessorSubscriber } from "./domains/streams/engine/shared/callable-subscriber.ts";
import { ItxContract } from "./itx/processor-contract.ts";
import { replayPath, type ItxProcessorRpc, type ProvideCapabilityInput } from "./itx/processor.ts";
import { isReservedDynamicPathSegment, withInvokeCapabilityFallback } from "./itx/path-proxy.ts";

type StreamProcessEventBatch = Parameters<Stream["subscribe"]>[0]["processEventBatch"];
type StreamProcessEventBatchInput = Parameters<StreamProcessEventBatch>[0];

const TRUSTED_INTERNAL_ITX_PROPS = {
  token: TRUSTED_INTERNAL_ITX_TOKEN,
  type: "trusted-internal",
} satisfies ItxAuthCredentials;

export class StreamRpcTarget extends RpcTarget implements RpcTargetImplementation<Stream> {
  constructor(readonly props: { auth: ItxAuth; projectId: string | null; path: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  append(...events: Parameters<Stream["append"]>) {
    return this.durableObjectStub.append(...events);
  }

  at(path: Parameters<Stream["at"]>[0]) {
    return this.durableObjectStub.at(path) as unknown as Stream;
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

  kill() {
    return this.durableObjectStub.kill();
  }

  async subscribe(args: Parameters<Stream["subscribe"]>[0]) {
    // The target can proxy ordinary methods directly. subscribe() is the special
    // case because it receives a callback that lives beyond the RPC return; keep
    // that callback retained locally and forward a fire-and-forget callback to
    // the source stream.
    const clientProcessEventBatch = retainProcessEventBatch(args.processEventBatch);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clientProcessEventBatch[Symbol.dispose]();
    };
    const processEventBatch: StreamProcessEventBatch & Disposable = Object.assign(
      (batch: StreamProcessEventBatchInput) => {
        const pendingBatch = clientProcessEventBatch(batch as Parameters<ProcessEventBatch>[0]);
        disposeIgnoredRpcResult(pendingBatch);
      },
      { [Symbol.dispose]: dispose },
    );

    try {
      const subscription = await this.durableObjectStub.subscribe({
        subscriptionKey: args.subscriptionKey,
        replayAfterOffset: args.replayAfterOffset,
        eventTypes: args.eventTypes,
        events: args.events,
        subscriber: args.subscriber,
        processEventBatch,
      });

      clientProcessEventBatch.onRpcBroken?.(() => {
        disposeIgnoredRpcResult(subscription.unsubscribe());
        dispose();
      });

      return {
        subscriptionKey: subscription.subscriptionKey,
        streamMaxOffset: subscription.streamMaxOffset,
        unsubscribe() {
          disposeIgnoredRpcResult(subscription.unsubscribe());
          dispose();
        },
      };
    } catch (error) {
      clientProcessEventBatch[Symbol.dispose]();
      throw error;
    }
  }
}

function normalizeRepoPath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

function normalizeAgentPath(path: string): string {
  const normalized = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  if (!normalized.startsWith("/agents/")) {
    throw new Error(`agent path must start with "/agents/", got "${normalized}"`);
  }
  return normalized;
}

function projectRootStream(props: { auth: ItxAuth; projectId: string }) {
  return new StreamRpcTarget({
    auth: props.auth,
    projectId: props.projectId,
    path: "/",
  });
}

function projectProcessorSubscriptionEvent(projectId: string) {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream-subscription:${projectId}:${ProjectProcessorContract.slug}`,
    payload: {
      subscriptionKey: ProjectProcessorContract.slug,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "PROJECT",
        durableObjectName: DurableObjectNameCodec.stringify({
          projectId,
          path: "/",
        }),
        processorName: ProjectProcessorContract.slug,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}

function repoProcessorSubscriptionEvent(input: { path: string; projectId: string }) {
  const path = normalizeRepoPath(input.path);
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream-subscription:${input.projectId}:${RepoProcessorContract.slug}:${path}`,
    payload: {
      subscriptionKey: `${RepoProcessorContract.slug}:${path}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "REPO",
        durableObjectName: DurableObjectNameCodec.stringify({
          projectId: input.projectId,
          path,
        }),
        processorName: RepoProcessorContract.slug,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}

function agentProcessorSubscriptionEvent(input: { path: string; projectId: string }) {
  const path = normalizeAgentPath(input.path);
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream-subscription:${input.projectId}:${path}:${AgentProcessorContract.slug}`,
    payload: {
      subscriptionKey: AgentProcessorContract.slug,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "AGENT",
        durableObjectName: DurableObjectNameCodec.stringify({
          projectId: input.projectId,
          path,
        }),
        processorName: AgentProcessorContract.slug,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}

function agentItxProcessorSubscriptionEvent(input: { path: string; projectId: string }) {
  const path = normalizeAgentPath(input.path);
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream-subscription:${input.projectId}:${path}:${ItxContract.slug}`,
    payload: {
      subscriptionKey: ItxContract.slug,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "AGENT",
        durableObjectName: DurableObjectNameCodec.stringify({
          projectId: input.projectId,
          path,
        }),
        processorName: ItxContract.slug,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}

async function requestRepoCreate(input: {
  auth: ItxAuth;
  path: string;
  projectId: string;
}): Promise<RepoRpcTarget> {
  const path = normalizeRepoPath(input.path);
  const stream = projectRootStream({ auth: input.auth, projectId: input.projectId });
  const [, createRequested] = await stream.append(repoProcessorSubscriptionEvent(input), {
    type: "events.iterate.com/repo/create-requested",
    idempotencyKey: `repo-create-requested:${input.projectId}:${path}`,
    payload: { projectId: input.projectId, path },
  });

  await stream.waitForEvent({
    afterOffset: createRequested.offset - 1,
    eventTypes: ["events.iterate.com/repo/created"],
    predicate: (event) =>
      event.payload?.projectId === input.projectId && event.payload?.path === path,
    timeoutMs: 60_000,
  });

  return new RepoRpcTarget({ auth: input.auth, path, projectId: input.projectId });
}

class StreamsRpcTarget extends RpcTarget implements RpcTargetImplementation<Streams> {
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

export class ItxRootRpcTarget extends RpcTarget implements RpcTargetImplementation<ItxRoot> {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext }) {
    super();
  }

  get projects() {
    return new ProjectsRpcTarget({ auth: this.props.auth, ctx: this.props.ctx });
  }

  get streams() {
    return new StreamsRpcTarget({ auth: this.props.auth, projectId: null });
  }

  // get repos() {
  //   return new ReposRpcTarget({ auth: this.props.auth, projectId: null });
  // }

  whoami() {
    return this.props.auth.principal;
  }
}
class ProjectsRpcTarget extends RpcTarget implements RpcTargetImplementation<Projects> {
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
  async create(args: Parameters<Projects["create"]>[0]) {
    if (!this.props.auth.isAdmin()) {
      throw new Error(`principal "${this.props.auth.principal}" cannot create projects`);
    }

    if (args.projectId === undefined) {
      // In actual apps/os we'd
      // 1) check auth JWT for matching project id and
      // 2) if not found, go to auth.iterate.com to create new project
      args.projectId = "prj_" + crypto.randomUUID();
    }

    const stream = projectRootStream({
      auth: this.props.auth,
      projectId: args.projectId,
    });

    const [, , createRequested] = await stream.append(
      // TODO move towards ProjectProcessorContract.buildEvent() helper or similar
      projectProcessorSubscriptionEvent(args.projectId),
      repoProcessorSubscriptionEvent({ projectId: args.projectId, path: PROJECT_REPO_PATH }),
      // Kick off the "create project sequence"
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

  list(): string[] {
    return this.props.auth.listAccessibleProjects();
  }
}

abstract class ItxCapabilityHostRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<ItxCapabilityHost>
{
  protected abstract itxProcessor(): ItxProcessorRpc;

  async provideCapability(input: ProvideCapabilityInput) {
    this.#rejectBuiltinCollision(input.path);
    await this.itxProcessor().provideCapability(input);
    return {
      revoke: () => {
        return this.revokeCapability({ path: input.path });
      },
    };
  }

  revokeCapability(input: { path: string[] }) {
    return this.itxProcessor().revokeCapability(input);
  }

  runScript(code: string) {
    return this.itxProcessor().runScript(code);
  }

  invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    return this.itxProcessor().invokeCapability({ args, path });
  }

  #rejectBuiltinCollision(path: string[]) {
    const root = path[0];
    if (!root) return;
    if (isReservedDynamicPathSegment(root)) {
      throw new Error(`cannot provide capability "${root}": it is a reserved ITX path segment`);
    }
    if (root in this) {
      throw new Error(`cannot provide capability "${root}": it is already on this ITX target`);
    }
  }
}

export class RepoRpcTarget extends RpcTarget implements RpcTargetImplementation<Repo> {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalizeRepoPath(this.props.path),
      }),
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
}

class ReposRpcTarget extends RpcTarget implements RpcTargetImplementation<Repos> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  create(input: Parameters<Repos["create"]>[0]) {
    return requestRepoCreate({
      auth: this.props.auth,
      path: input.path,
      projectId: this.props.projectId,
    });
  }

  get(path: string) {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: normalizeRepoPath(path),
      projectId: this.props.projectId,
    });
  }
}

class AgentsRpcTarget extends RpcTarget implements RpcTargetImplementation<Agents> {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async create(input: Parameters<Agents["create"]>[0]) {
    return await this.get(input.path).create();
  }

  get(path: string): RpcTargetImplementation<Agent> {
    return new AgentRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: normalizeAgentPath(path),
      projectId: this.props.projectId,
    });
  }
}

export class AgentRpcTarget
  extends ItxCapabilityHostRpcTarget
  implements RpcTargetImplementation<Agent>
{
  constructor(
    readonly props: { auth: ItxAuth; ctx: CfExecutionContext; path: string; projectId: string },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    props.path = normalizeAgentPath(props.path);
    return withInvokeCapabilityFallback(this);
  }

  get durableObjectStub() {
    return env.AGENT.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  protected itxProcessor(): ItxProcessorRpc {
    return this.durableObjectStub.itxProcessor as unknown as ItxProcessorRpc;
  }

  #projectItxProcessor(): ItxProcessorRpc {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: "/",
      }),
    ).itxProcessor as unknown as ItxProcessorRpc;
  }

  get stream(): RpcTargetImplementation<Stream> {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: this.props.path,
    });
  }

  async create() {
    await this.#ensureProcessorsConfigured();
    const [requested] = await this.stream.append({
      type: "events.iterate.com/agent/create-requested",
      idempotencyKey: `agent-create-requested:${this.props.projectId}:${this.props.path}`,
      payload: {},
    });
    return await this.stream.waitForEvent({
      afterOffset: requested.offset - 1,
      eventTypes: ["events.iterate.com/agent/created"],
      timeoutMs: 30_000,
    });
  }

  async sendMessage(message: string) {
    await this.#ensureProcessorsConfigured();
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

  override async provideCapability(input: ProvideCapabilityInput) {
    await this.#ensureProcessorsConfigured();
    return await super.provideCapability(input);
  }

  override async revokeCapability(input: { path: string[] }) {
    await this.#ensureProcessorsConfigured();
    return await super.revokeCapability(input);
  }

  override async runScript(code: string) {
    await this.#ensureProcessorsConfigured();
    return await super.runScript(code);
  }

  override async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    await this.#ensureProcessorsConfigured();
    try {
      return await this.itxProcessor().invokeCapability({ args, path });
    } catch (error) {
      if (!isMissingCapabilityError(error, path)) throw error;
      return await this.#projectItxProcessor().invokeCapability({ args, path });
    }
  }

  async #ensureProcessorsConfigured() {
    // Agent streams can be addressed before the project stream has observed the
    // child-stream-created fact. Land the two processor subscriptions directly
    // so first-use operations like agent.provideCapability() have a live fold to
    // wait on without asking ProjectProcessor to append across stream Durable
    // Object boundaries.
    await this.stream.append(
      agentProcessorSubscriptionEvent({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
      agentItxProcessorSubscriptionEvent({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
  }
}

function isMissingCapabilityError(error: unknown, path: string[]): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return message.includes(`no capability "${path.join(".")}"`);
}

export class ProjectWorkerRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<ProjectWorker>
{
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  async fetch(req: Request) {
    return await (await this.defaultProjectWorker()).fetch(req);
  }

  async processEvent(input: Parameters<ProjectWorker["processEvent"]>[0]) {
    return await (await this.defaultProjectWorker()).processEvent(input);
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    return await replayPath({
      args,
      path,
      target: await this.defaultProjectWorker(),
    });
  }

  private defaultProjectWorker() {
    return new DynamicWorkersRpcTarget({
      bindings: {
        ITX: this.props.ctx.exports.ItxEntrypoint({ props: TRUSTED_INTERNAL_ITX_PROPS }),
      },
      loader: env.LOADER,
      projectId: this.props.projectId,
    }).get<ProjectWorker>({
      source: {
        repoPath: PROJECT_REPO_PATH,
        sourcePath: PROJECT_WORKER_SOURCE_PATH,
        type: "repo",
      },
      target: {
        props: {
          auth: TRUSTED_INTERNAL_ITX_PROPS,
          projectId: this.props.projectId,
        },
        type: "worker-entrypoint",
      },
    });
  }
}

export class ProjectRpcTarget
  extends ItxCapabilityHostRpcTarget
  implements RpcTargetImplementation<Project>
{
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  get durableObjectStub() {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  describe() {
    return this.durableObjectStub.describe();
  }

  protected itxProcessor(): ItxProcessorRpc {
    return this.durableObjectStub.itxProcessor as unknown as ItxProcessorRpc;
  }

  get streams(): RpcTargetImplementation<Streams> {
    return new StreamsRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get agents(): RpcTargetImplementation<Agents> {
    return new AgentsRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: this.props.projectId,
    });
  }

  get repos(): RpcTargetImplementation<Repos> {
    return new ReposRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get repo(): RpcTargetImplementation<Repo> {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: PROJECT_REPO_PATH,
      projectId: this.props.projectId,
    });
  }

  get worker(): RpcTargetImplementation<ProjectWorker> {
    return new ProjectWorkerRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      projectId: this.props.projectId,
    });
  }
}

export class UnauthenticatedItxRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<UnauthenticatedItx>
{
  // This is the root of the capability tree, so it also owns the current
  // Cloudflare execution context. We thread ctx through child targets because
  // the default project worker is loaded directly with Worker Loader, yet must
  // always receive an env.ITX binding created from ctx.exports.
  constructor(
    readonly requestHeaders: Headers,
    readonly ctx: CfExecutionContext,
  ) {
    super();
  }

  authenticate(input: ItxAuthCredentials) {
    let auth: ItxAuth | null = null;

    if (input.type === "token") {
      auth = new FakeAuthContext(input.token);
    }

    if (input.type === "from-server-cookie") {
      const cookieToken = readCookie(this.requestHeaders.get("cookie"), ITX_AUTH_COOKIE);
      if (cookieToken) auth = new FakeAuthContext(parseItxAuthToken(cookieToken));
    }

    if (input.type === "trusted-internal" && input.token === TRUSTED_INTERNAL_ITX_TOKEN)
      auth = new FakeAuthContext({ principal: "trusted-internal", type: "admin" });

    if (!auth) throw new Error("missing or invalid auth");

    return new ItxRootRpcTarget({ auth, ctx: this.ctx });
  }
}

export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxAuthCredentials>
  implements Pick<RpcTargetImplementation<UnauthenticatedItx>, "authenticate">
{
  authenticate(input: ItxAuthCredentials = this.ctx.props) {
    return new UnauthenticatedItxRpcTarget(new Headers(), this.ctx).authenticate(input);
  }
}
