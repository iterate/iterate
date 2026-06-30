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
import { CapabilityProvisionRpcTarget } from "./domains/itx/capability-provision.ts";
import { itxEntrypointProps, itxEntrypointScopeCacheKey } from "./domains/itx/entrypoint-props.ts";
import { type ProvideCapabilityInput } from "./domains/itx/itx-processor-implementation.ts";
import { rejectBuiltinCollision, withInvokeCapabilityFallback } from "./domains/itx/path-proxy.ts";
import { ProjectEgressRpcTarget, projectEgressFetcher } from "./domains/projects/egress.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor-contract.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "./domains/repos/project-repo.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor-contract.ts";
import { subscriptionConfiguredEvent } from "./domains/streams/subscription-event.ts";
import { WorkerRef as WorkerRefSchema } from "./domains/workers/schemas.ts";
import { WorkerRunner } from "./domains/workers/worker-runner.ts";
import type {
  Agent,
  AgentCollection,
  AgentItx,
  CfExecutionContext,
  ItxAuth,
  ItxAuthCredentials,
  ItxRoot,
  Project,
  ProjectCollection,
  ProjectWorker,
  Repo,
  RepoCollection,
  RevokeCapabilityInput,
  StatelessWorkerRef,
  Stream,
  StreamCollection,
  UnauthenticatedItx,
  WorkerCapability,
  WorkerCollection,
  WorkerRef,
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
    return this.durableObjectStub.subscribe(
      // [[ Why is this needed? some type invocation depth or circles? ]]
      args as Parameters<typeof this.durableObjectStub.subscribe>[0],
    );
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

// [[ This helper method should not be in here - it should be in domains/streams in some utility module ]]
function resolveStreamPath(basePath: string, streamPath: string): string {
  const segments = streamPath.startsWith("/") ? [] : basePath.split("/").filter(Boolean);
  for (const segment of streamPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `stream path "${streamPath}" escapes the stream root (resolved from "${basePath}")`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function projectRootStream(props: { auth: ItxAuth; projectId: string }) {
  return new StreamRpcTarget({
    auth: props.auth,
    projectId: props.projectId,
    path: "/",
  });
}

async function requestRepoCreate(input: {
  auth: ItxAuth;
  path: string;
  projectId: string;
}): Promise<RepoRpcTarget> {
  const path = normalizePath(input.path);
  const stream = projectRootStream({ auth: input.auth, projectId: input.projectId });
  const [, createRequested] = await stream.append(
    subscriptionConfiguredEvent({
      projectId: input.projectId,
      path,
      bindingName: "REPO",
      processorName: RepoProcessorContract.slug,
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
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalizePath(this.props.path),
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

class RepoCollectionRpcTarget extends RpcTarget implements RepoCollection {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
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

function normalizeAgentPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/agents/")) {
    throw new Error(`agent path must start with "/agents/", got "${normalized}"`);
  }
  return normalized;
}

class AgentCollectionRpcTarget extends RpcTarget implements AgentCollection {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async create(input: Parameters<AgentCollection["create"]>[0]) {
    return await this.get(input.path).create();
  }

  get(path: string) {
    return new AgentRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: normalizeAgentPath(path),
      projectId: this.props.projectId,
    });
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

  get stream() {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: this.props.path,
    });
  }

  async create() {
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

  async provideCapability(input: ProvideCapabilityInput) {
    rejectBuiltinCollision(this, input.path);
    const provision = await this.#itx.provideCapability(input);
    // [[ Why can we not just write return this.itx.provideCapability(input) ]]

    return new CapabilityProvisionRpcTarget({
      ctx: this.props.ctx,
      path: input.path,
      providedAtOffset: provision.providedAtOffset,
      revoke: (revokeInput) => this.#itx.revokeCapability(revokeInput),
    });
  }

  async revokeCapability(input: RevokeCapabilityInput) {
    // [[ This line is v suspicious - should delete and turn into one-liner]]
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
class WorkerCollectionRpcTarget extends RpcTarget implements WorkerCollection {
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

  get<T extends object = Record<string, unknown>>(ref: WorkerRef): WorkerCapability<T> {
    const parsed = WorkerRefSchema.parse(ref);
    return new WorkerRpcTarget({
      ctx: this.props.ctx,
      loader: this.props.loader,
      projectId: this.props.projectId,
      ref: parsed,
    }) as unknown as WorkerCapability<T>;
  }
}

/**
 * RPC wrapper around a single WorkerRef.
 *
 * The returned object is a path proxy: unknown properties become path segments
 * and eventually call `invokeCapability`. Dynamic workers do not share a fixed
 * method surface, so this wrapper deliberately exposes no method names beyond
 * the flattened capability dispatcher.
 */
class WorkerRpcTarget extends RpcTarget {
  readonly #runner: WorkerRunner;
  readonly #ref: WorkerRef;

  constructor(props: {
    ctx: CfExecutionContext;
    loader: Env["LOADER"];
    projectId: string;
    ref: WorkerRef;
  }) {
    super();
    this.#ref = props.ref;
    const itxScope = itxEntrypointProps({
      path: normalizePath(props.ref.path),
      projectId: props.projectId,
    });
    this.#runner = new WorkerRunner({
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
    // Keep every dynamic worker invocation behind WorkerRunner. Stateless
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

    const stream = projectRootStream({
      auth: this.props.auth,
      projectId: args.projectId,
    });

    const [, , createRequested] = await stream.append(
      subscriptionConfiguredEvent({
        projectId: args.projectId,
        path: "/",
        bindingName: "PROJECT",
        processorName: ProjectProcessorContract.slug,
      }),
      subscriptionConfiguredEvent({
        projectId: args.projectId,
        path: PROJECT_REPO_PATH,
        bindingName: "REPO",
        processorName: RepoProcessorContract.slug,
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

  list(): string[] {
    return this.props.auth.listAccessibleProjects();
  }
}

// [[ Why is there a random type here? ]]
type ProjectRpcTargetProps = { auth: ItxAuth; ctx: CfExecutionContext; projectId: string };

export const ProjectRpcTargetInternals = Symbol("ProjectRpcTargetInternals");

// [[ Do we really need this to be parameterised by props type? this seems unnecessarily messy - can we simplify ]]
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

  describe() {
    return this.durableObjectStub.describe();
  }

  get #itx() {
    return env.ITX.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  async provideCapability(input: ProvideCapabilityInput) {
    rejectBuiltinCollision(this, input.path);
    const provision = await this.#itx.provideCapability(input);
    // [[ why is this not returned from #itx.provideCapability? ]]
    return new CapabilityProvisionRpcTarget({
      ctx: this.props.ctx,
      path: input.path,
      providedAtOffset: provision.providedAtOffset,
      revoke: (revokeInput) => this.#itx.revokeCapability(revokeInput),
    });
  }

  async revokeCapability(input: RevokeCapabilityInput) {
    await this.#itx.revokeCapability(input);
  }

  async runScript(code: string) {
    return await this.#itx.runScript(code);
  }

  invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    return this.#itx.invokeCapability({ args, path });
  }

  get streams() {
    return new StreamCollectionRpcTarget({
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

  get repos() {
    return new RepoCollectionRpcTarget({
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
    return new WorkerCollectionRpcTarget({
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

  get [ProjectRpcTargetInternals]() {
    return {
      ensureDefaultWorkerLoaded: async () => {
        const worker = await this.#defaultProjectWorker();
        if (typeof worker.fetch !== "function") {
          throw new Error("Default project worker does not expose fetch().");
        }
      },
    };
  }

  #defaultProjectWorker() {
    const itxScope = itxEntrypointProps({
      path: "/",
      projectId: this.props.projectId,
    });
    return new WorkerRunner({
      bindings: {
        ITX: this.props.ctx.exports.ItxEntrypoint({ props: itxScope }),
      },
      globalOutbound: projectEgressFetcher(this.props.ctx.exports, this.props.projectId),
      loader: env.LOADER,
      projectId: this.props.projectId,
      workerScopeKey: itxEntrypointScopeCacheKey(itxScope),
    }).getStatelessEntrypoint<ProjectWorker>(defaultProjectWorkerRef());
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

function defaultProjectWorkerRef(): StatelessWorkerRef {
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

class ItxRootRpcTarget extends RpcTarget implements ItxRoot {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext }) {
    super();
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

  authenticate(input: ItxAuthCredentials) {
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
