// The streams surface as a CAPABILITY (itx-next.md §6/§8): `itx.streams` on
// a project context is an ordinary platform:project definition dialing the
// StreamsCapability loopback below — shadowable like every other default. The
// collection/stream classes here are shared with the handle's GLOBAL branch
// (the deployment-wide "global" namespace stays kernel: it is gated on the
// connect-time access set, which no cap definition can express).
//
// Scope model: a StreamsScope carries the namespaces this surface may
// resolve. The cap pins it to the owning project (dial-injected
// projectId — a provider can never point it elsewhere); the global kernel
// branch passes the handle's access set through. Absolute refs
// ("ns:/path") are sugar through ONE access check either way.
//
// Chaining note: `itx.streams.get("/x").append(e)` relies on RPC promise
// pipelining (capnweb from browsers/Node, jsrpc from loaded isolates) —
// `get` returns this module's RpcTargets across the boundary and the
// follow-up call pipelines onto the result, the same shape
// itx.agents.create().doThing() already proves out.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { StreamNamespace } from "@iterate-com/shared/streams/types";
import { ItxError } from "../errors.ts";
import { replayPathCall, type PathCall } from "../itx.ts";
import type { ProjectAccess } from "../refs.ts";
import { getStreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
import type { StreamRpc } from "~/domains/streams/engine/types.ts";

type StreamsClient = ReturnType<typeof getStreamsBackend>;
type StreamsExports = Parameters<typeof getStreamsBackend>[0]["exports"];

/** What a streams surface needs: where to dial, and what it may resolve. */
export type StreamsScope = {
  access: ProjectAccess;
  exports: StreamsExports;
};

export type StreamsCapabilityProps = {
  /** The owning project — dial-injected at dial time, never provider
   * props, so a `streams` cap can only ever scope to its own namespace. */
  projectId?: string;
  /** Attribution, injected by the dial. */
  context?: string;
  capabilityPath?: string;
};

/**
 * The platform:project `streams` default: get/namespace/create against a
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
 * A namespace-pinned streams collection. Thin: every method resolves the
 * streams domain entrypoint with the namespace in props and forwards. The
 * append policies are decided here (collection-level appends may target any
 * path in the namespace; a single stream handle is pinned to its path).
 */
export class ItxStreams extends RpcTarget {
  constructor(
    private readonly scope: StreamsScope,
    private readonly namespaceId: string,
  ) {
    super();
  }

  /**
   * Relative or absolute (itx-next.md §3). `"/path"` resolves in this
   * collection's namespace; `"ns:/path"` and `{ namespace, path }` are
   * absolute refs. Sugar rule: absolute forms construct the narrowed
   * collection and call through — ONE code path, so the access check never
   * diverges.
   */
  get(ref: string | { namespace?: string; path: string }): ItxStream {
    const { namespace, path } = parseStreamRef(ref);
    if (namespace === undefined || namespace === this.namespaceId) {
      return new ItxStream(this.scope, this.namespaceId, path);
    }
    return this.namespace(namespace).get(path);
  }

  namespace(namespace: string): ItxStreams {
    const parsed = StreamNamespace.parse(namespace);
    // Resolution checks access (§3 rule 2): refs are pure names, restoring
    // them is the capability. Masked as NOT_FOUND like projects.get — a
    // caller can never probe which namespaces exist. A project-scoped
    // surface cannot fully-qualify its way out of its access set.
    if (this.scope.access !== "all" && !this.scope.access.includes(parsed)) {
      throw new ItxError({
        code: "NOT_FOUND",
        message: `No stream namespace ${JSON.stringify(parsed)} for this handle.`,
      });
    }
    return new ItxStreams(this.scope, parsed);
  }

  async create(input: { streamPath: string }) {
    return await this.client().create(input);
  }

  private client(): StreamsClient {
    return getStreamsBackend({
      exports: this.scope.exports,
      props: { appendPolicy: { mode: "any" }, projectId: this.namespaceId },
    });
  }
}

/**
 * The two absolute StreamRef spellings, plus the relative one:
 * `"/path"` (relative), `"ns:/path"` (absolute string), and
 * `{ namespace?, path }` (absolute structured). Refs are unauthenticated
 * names — authority comes from who restores them, never from their content.
 */
function parseStreamRef(ref: string | { namespace?: string; path: string }): {
  namespace?: string;
  path: string;
} {
  if (typeof ref !== "string") {
    return { namespace: ref.namespace, path: ref.path };
  }
  if (ref.startsWith("/")) return { path: ref };
  const colon = ref.indexOf(":");
  if (colon > 0 && ref[colon + 1] === "/") {
    return { namespace: ref.slice(0, colon), path: ref.slice(colon + 1) };
  }
  throw new ItxError({
    code: "BAD_REQUEST",
    message: `Stream ref ${JSON.stringify(ref)} must be "/path", "namespace:/path", or { namespace?, path }.`,
  });
}

export class ItxStream extends RpcTarget {
  constructor(
    private readonly scope: StreamsScope,
    private readonly namespaceId: string,
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
    const handle = await this.client().subscribe(input as never);
    return new ItxStreamSubscription(handle);
  }

  private client(): StreamsClient {
    return getStreamsBackend({
      exports: this.scope.exports,
      props: {
        appendPolicy: { mode: "stream" },
        projectId: this.namespaceId,
        streamPath: this.path,
      },
    });
  }
}

/** Disposer for ItxStream.subscribe — callable from any execution mode. */
export class ItxStreamSubscription extends RpcTarget {
  constructor(private readonly handle: { unsubscribe(): void }) {
    super();
  }

  unsubscribe() {
    this.handle.unsubscribe();
  }
}
