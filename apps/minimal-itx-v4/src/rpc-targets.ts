import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  RpcTargetImplementation,
  ItxCapabilityHost,
  ItxRoot,
  Projects,
  ItxAuthCredentials,
  ItxAuth,
  UnauthenticatedItx,
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
import { PROJECT_REPO_PATH } from "./domains/repos/project-repo.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor.ts";
import { durableObjectProcessorSubscriber } from "./domains/streams/engine/shared/callable-subscriber.ts";
import type { ItxProcessorRpc, ProvideCapabilityInput } from "./itx/processor.ts";
import { isReservedDynamicPathSegment, withInvokeCapabilityFallback } from "./itx/path-proxy.ts";

type StreamProcessEventBatch = Parameters<Stream["subscribe"]>[0]["processEventBatch"];
type StreamProcessEventBatchInput = Parameters<StreamProcessEventBatch>[0];

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
  constructor(readonly props: { auth: ItxAuth }) {
    super();
  }

  get projects() {
    return new ProjectsRpcTarget({ auth: this.props.auth });
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
  constructor(readonly props: { auth: ItxAuth }) {
    super();
  }

  get(projectId: string) {
    return new ProjectRpcTarget({
      auth: this.props.auth,
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

    return new ProjectRpcTarget({ auth: this.props.auth, projectId: args.projectId });
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

export class ProjectWorkerRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<ProjectWorker>
{
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  get durableObjectStub() {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  fetch(req: Request) {
    return this.durableObjectStub.workerFetch(req);
  }

  processEvent(input: Parameters<ProjectWorker["processEvent"]>[0]) {
    return this.durableObjectStub.workerProcessEvent(input);
  }

  invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    return (
      this.durableObjectStub as unknown as {
        workerInvokeCapability(input: { args: unknown[]; path: string[] }): unknown;
      }
    ).workerInvokeCapability({ args, path });
  }
}

export class ProjectRpcTarget
  extends ItxCapabilityHostRpcTarget
  implements RpcTargetImplementation<Project>
{
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
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

  get agents(): Agents {
    throw new Error("project.agents is not implemented in minimal-itx-v4");
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
      projectId: this.props.projectId,
    });
  }
}

export class UnauthenticatedItxRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<UnauthenticatedItx>
{
  constructor(readonly requestHeaders: Headers = new Headers()) {
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

    return new ItxRootRpcTarget({ auth });
  }
}

export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxAuthCredentials>
  implements Pick<RpcTargetImplementation<UnauthenticatedItx>, "authenticate">
{
  authenticate(input: ItxAuthCredentials = this.ctx.props) {
    return new UnauthenticatedItxRpcTarget().authenticate(input);
  }

  projectRepo(projectId: string) {
    return this.authenticate().projects.get(projectId).repo;
  }

  projectWorker(projectId: string) {
    return this.authenticate().projects.get(projectId).worker;
  }
}
