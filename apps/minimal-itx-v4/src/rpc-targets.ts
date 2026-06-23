import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  RpcTargetImplementation,
  ItxRoot,
  Projects,
  ItxAuthCredentials,
  ItxAuth,
  UnauthenticatedItx,
  Project,
  Streams,
  Agents,
  Repos,
  Stream,
} from "../types.ts";
import type { ProcessEventBatch } from "./domains/streams/engine/types.ts";
import { formatDurableObjectName, PLATFORM_PROJECT_ID } from "./domains/durable-object-names.ts";
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

type StreamProcessEventBatch = Parameters<Stream["subscribe"]>[0]["processEventBatch"];
type StreamProcessEventBatchInput = Parameters<StreamProcessEventBatch>[0];

export class StreamRpcTarget extends RpcTarget implements RpcTargetImplementation<Stream> {
  constructor(readonly props: { auth: ItxAuth; projectId: string | null; path: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.STREAM.getByName(
      formatDurableObjectName({
        projectId: this.props.projectId ?? PLATFORM_PROJECT_ID,
        path: this.props.path,
      }),
    );
  }

  append(args: Parameters<Stream["append"]>[0]) {
    return this.durableObjectStub.append(args);
  }

  appendBatch(args: Parameters<Stream["appendBatch"]>[0]) {
    return this.durableObjectStub.appendBatch(args);
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

  get projects(): RpcTargetImplementation<Projects> {
    return new ProjectsRpcTarget({ auth: this.props.auth });
  }

  whoami(): string {
    return this.props.auth.principal;
  }
}

class ProjectsRpcTarget extends RpcTarget implements RpcTargetImplementation<Projects> {
  constructor(readonly props: { auth: ItxAuth }) {
    super();
  }

  get(projectId: string): RpcTargetImplementation<Project> {
    return new ProjectRpcTarget({
      auth: this.props.auth,
      projectId: projectId,
    });
  }

  async create(args: {
    projectId: string;
    slug: string;
  }): Promise<RpcTargetImplementation<Project>> {
    if (!this.props.auth.isAdmin()) {
      throw new Error(`principal "${this.props.auth.principal}" cannot create projects`);
    }
    const _event = await env.PROJECT.getByName(
      formatDurableObjectName({ path: "/", projectId: args.projectId }),
    ).create(args);
    return this.get(args.projectId);
  }

  list(): string[] {
    return this.props.auth.listAccessibleProjects();
  }
}

export class ProjectRpcTarget extends RpcTarget implements RpcTargetImplementation<Project> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  create(): Promise<never> {
    throw new Error("project.create is not implemented in minimal-itx-v4");
  }

  runScript(): Promise<never> {
    throw new Error("project.runScript is not implemented in minimal-itx-v4");
  }

  provideCapability(): Promise<never> {
    throw new Error("project.provideCapability is not implemented in minimal-itx-v4");
  }

  revokeCapability(): Promise<never> {
    throw new Error("project.revokeCapability is not implemented in minimal-itx-v4");
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

  get repos(): Repos {
    throw new Error("project.repos is not implemented in minimal-itx-v4");
  }
}

export class UnauthenticatedItxRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<UnauthenticatedItx>
{
  constructor(readonly requestHeaders: Headers = new Headers()) {
    super();
  }

  authenticate(input: ItxAuthCredentials): ItxRootRpcTarget {
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

  whoami(): string {
    return "Unauthenticated";
  }
}

export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxAuthCredentials>
  implements RpcTargetImplementation<UnauthenticatedItx>
{
  authenticate(input: ItxAuthCredentials = this.ctx.props) {
    return new UnauthenticatedItxRpcTarget().authenticate(input);
  }

  whoami(): string {
    return new UnauthenticatedItxRpcTarget().whoami();
  }
}
