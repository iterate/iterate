// The streams surface as a CAPABILITY (itx-next.md §6/§8): `itx.streams` on
// a project context is an ordinary platform:project definition dialing the
// StreamsCapability loopback below — shadowable like every other default. The
// collection/stream classes here are shared with the handle's GLOBAL branch
// (the deployment-wide global stream scope stays kernel: it is gated on the
// connect-time access set, which no cap definition can express).
//
// Scope model: a StreamsScope carries the project ids this surface may
// resolve. The cap pins it to the owning project (dial-injected
// projectId — a provider can never point it elsewhere); the global kernel
// branch passes the handle's access set through. Absolute refs
// ("projectId:/path") are sugar through ONE access check either way.
//
// Chaining note: `itx.streams.get("/x").append(e)` relies on RPC promise
// pipelining (capnweb from browsers/Node, jsrpc from loaded isolates) —
// `get` returns this module's RpcTargets across the boundary and the
// follow-up call pipelines onto the result, the same shape
// itx.agents.create().doThing() already proves out.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { ItxError } from "../errors.ts";
import { replayPathCall, type PathCall } from "../itx.ts";
import type { ProjectAccess } from "../refs.ts";
import { getStreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
import type { StreamRpc } from "~/domains/streams/engine/types.ts";
import {
  formatDurableObjectName,
  normalizeDurableObjectProjectId,
  parseDurableObjectName,
} from "~/domains/durable-object-names.ts";

type StreamsClient = ReturnType<typeof getStreamsBackend>;
type StreamsExports = Parameters<typeof getStreamsBackend>[0]["exports"];

/** What a streams surface needs: where to dial, and what it may resolve. */
export type StreamsScope = {
  access: ProjectAccess;
  exports: StreamsExports;
};

export type StreamsCapabilityProps = {
  /** The owning project — dial-injected at dial time, never provider
   * props, so a `streams` cap can only ever scope to its own project. */
  projectId?: string;
  /** Attribution, injected by the dial. */
  context?: string;
  capabilityPath?: string;
};

/**
 * The platform:project `streams` default: get/project/create against a
 * project-pinned collection. Only ever reached through the one calling
 * convention (the dial), so `call` replays straight onto the collection —
 * its surface IS this capability's surface, no forwarders.
 */
export class StreamsCapability extends WorkerEntrypoint<Env, StreamsCapabilityProps> {
  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this.#collection(), input);
  }

  #collection(): ItxStreams {
    const projectId = this.ctx.props.projectId;
    if (!projectId) throw new Error("StreamsCapability needs dial-injected projectId props.");
    return new ItxStreams(
      { access: [projectId], exports: this.ctx.exports as unknown as StreamsExports },
      projectId,
    );
  }
}

/**
 * A project-pinned streams collection. Thin: every method resolves the
 * streams domain entrypoint with the project id in props and forwards. The
 * append policies are decided here (collection-level appends may target any
 * path in the project; a single stream handle is pinned to its path).
 */
export class ItxStreams extends RpcTarget {
  constructor(
    private readonly scope: StreamsScope,
    private readonly projectId: string | null,
  ) {
    super();
  }

  /**
   * Relative or absolute (itx-next.md §3). `"/path"` resolves in this
   * collection's project; `"proj_123:/path"` and `{ projectId, path }` are
   * absolute refs. Sugar rule: absolute forms construct the narrowed
   * collection and call through — ONE code path, so the access check never
   * diverges.
   */
  get(ref: string | { projectId: string | null; path: string }): ItxStream {
    const { projectId, path } = parseStreamRef(ref);
    if (projectId === undefined || projectId === this.projectId) {
      return new ItxStream(this.scope, this.projectId, path);
    }
    if (projectId === null) {
      return this.project(null).get(path);
    }
    return this.project(projectId).get(path);
  }

  project(projectId: string | null): ItxStreams {
    const normalizedProjectId = normalizeDurableObjectProjectId(projectId);
    // Resolution checks access (§3 rule 2): refs are pure names, restoring
    // them is the capability. Masked as NOT_FOUND like projects.get — a
    // caller can never probe which projects exist. A project-scoped
    // surface cannot fully-qualify its way out of its access set.
    if (
      normalizedProjectId === null
        ? this.scope.access !== "all"
        : this.scope.access !== "all" && !this.scope.access.includes(normalizedProjectId)
    ) {
      throw new ItxError({
        code: "NOT_FOUND",
        message: `No stream project ${JSON.stringify(normalizedProjectId)} for this handle.`,
      });
    }
    return new ItxStreams(this.scope, normalizedProjectId);
  }

  async create(input: { streamPath: string }) {
    return await this.client().create(input);
  }

  private client(): StreamsClient {
    return getStreamsBackend({
      exports: this.scope.exports,
      props: { appendPolicy: { mode: "any" }, projectId: this.projectId },
    });
  }
}

/**
 * The two absolute StreamRef spellings, plus the relative one:
 * `"/path"` (relative), `"proj_123:/path"` (absolute string), and
 * `{ projectId, path }` (absolute structured). Refs are unauthenticated
 * names — authority comes from who restores them, never from their content.
 */
function parseStreamRef(ref: string | { projectId: string | null; path: string }): {
  projectId?: string | null;
  path: string;
} {
  if (typeof ref !== "string") {
    return parseDurableObjectName(formatDurableObjectName(ref));
  }
  if (ref.startsWith("/")) return { path: ref };
  try {
    return parseDurableObjectName(ref);
  } catch {
    // Fall through to the user-facing error below.
  }
  throw new ItxError({
    code: "BAD_REQUEST",
    message: `Stream ref ${JSON.stringify(ref)} must be "/path", "projectId:/path", or { projectId, path }.`,
  });
}

export class ItxStream extends RpcTarget {
  constructor(
    private readonly scope: StreamsScope,
    private readonly projectId: string | null,
    private readonly path: string,
  ) {
    super();
  }

  async append(input: Parameters<StreamRpc["append"]>[0]) {
    return await this.client().append(input as never);
  }

  async appendBatch(input: Parameters<StreamRpc["appendBatch"]>[0]) {
    return await this.client().appendBatch(input as never);
  }

  async getEvent(input: Parameters<StreamRpc["getEvent"]>[0]) {
    return await this.client().getEvent(input as never);
  }

  async getEvents(input: Parameters<StreamRpc["getEvents"]>[0] = {}) {
    return await this.client().getEvents(input as never);
  }

  async runtimeState() {
    return await this.client().runtimeState({} as never);
  }

  async getProcessorRuntimeState(input: Parameters<StreamRpc["getProcessorRuntimeState"]>[0]) {
    return await this.client().getProcessorRuntimeState(input as never);
  }

  async waitForEvent(input: Parameters<StreamRpc["waitForEvent"]>[0]) {
    return await this.client().waitForEvent(input as never);
  }

  async kill() {
    return await this.client().kill({} as never);
  }

  async reset() {
    return await this.client().reset({} as never);
  }

  async reduce(input: Parameters<StreamRpc["reduce"]>[0]) {
    return await this.client().reduce(input as never);
  }

  async subscribe(input: Parameters<StreamRpc["subscribe"]>[0]): Promise<ItxStreamSubscription> {
    const processEventBatch = input.processEventBatch;
    const retainedProcessEventBatch =
      (processEventBatch as { dup?(): typeof processEventBatch }).dup?.() ?? processEventBatch;
    try {
      const handle = await this.client().subscribe({
        ...input,
        processEventBatch: retainedProcessEventBatch,
      } as never);
      return new ItxStreamSubscription(handle, () => {
        (retainedProcessEventBatch as Partial<Disposable>)[Symbol.dispose]?.();
      });
    } catch (error) {
      (retainedProcessEventBatch as Partial<Disposable>)[Symbol.dispose]?.();
      throw error;
    }
  }

  private client(): StreamsClient {
    return getStreamsBackend({
      exports: this.scope.exports,
      props: {
        appendPolicy: { mode: "stream" },
        projectId: this.projectId,
        streamPath: this.path,
      },
    });
  }
}

/** Disposer for ItxStream.subscribe — callable from any execution mode. */
export class ItxStreamSubscription extends RpcTarget {
  constructor(
    private readonly handle: { unsubscribe(): void },
    private readonly release: () => void = () => {},
  ) {
    super();
  }

  async unsubscribe() {
    try {
      await Promise.resolve((this.handle.unsubscribe as () => unknown)());
    } finally {
      this.release();
    }
  }
}
