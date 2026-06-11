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
import type {
  StreamCursor,
  Event as StreamEvent,
  StreamState,
} from "@iterate-com/shared/streams/types";
import { StreamNamespace } from "@iterate-com/shared/streams/types";
import { ItxError } from "../errors.ts";
import { replayPathCall, type PathCall } from "../itx.ts";
import type { ProjectAccess } from "../refs.ts";
import { getStreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";

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
 * project-pinned collection, reached through the one calling convention via
 * the self-replaying `call` below.
 */
export class StreamsCapability extends WorkerEntrypoint<Env, StreamsCapabilityProps> {
  /** The kernel's one calling convention; replay walks this entrypoint's own members. */
  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this, input);
  }

  get(ref: string | { namespace?: string; path: string }): ItxStream {
    return this.#collection().get(ref);
  }

  namespace(namespace: string): ItxStreams {
    return this.#collection().namespace(namespace);
  }

  async create(input: { streamPath: string }) {
    return await this.#collection().create(input);
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

  describe() {
    return { namespace: this.namespaceId, path: this.path };
  }

  async append(event: unknown) {
    return await this.client().append({ event } as never);
  }

  async appendBatch(events: unknown[]) {
    return await this.client().appendBatch({ events } as never);
  }

  async read(input: Record<string, unknown> = {}) {
    return await this.client().read(input as never);
  }

  async getState() {
    return await this.client().getState({} as never);
  }

  async listChildren() {
    return await this.client().listChildren({} as never);
  }

  /**
   * Live tail: catch-up from `afterOffset` ("start" replays everything,
   * "end" is live-only), then every committed batch, pushed to `onEventBatch`
   * until unsubscribed. The callback crosses whatever boundary the caller
   * came in over (capnweb from a browser/Node session, Workers RPC from a cap
   * isolate); the streams capability holds the actual DO subscription, so the
   * same append-policy props gate it. If the callback's far end goes away,
   * the subscription is torn down on the next failed delivery — offline means
   * offline; durability is the stream itself, re-subscribe from the last
   * offset you saw.
   *
   * The ONE reactive primitive: every batch also carries `state` — the same
   * public shape `getState()` returns, as of `streamMaxOffset` — and every
   * subscription gets an immediate first batch (current state plus any
   * replayed events), so a subscriber paints its first render from the
   * subscription alone. `events: false` is state-only mode: batches arrive
   * with `events: []` on every state change, implicitly live-from-now
   * (`afterOffset` is ignored — replay without events is meaningless).
   */
  async subscribe(
    onEventBatch: (batch: {
      events: StreamEvent[];
      state: StreamState;
      streamMaxOffset: number;
    }) => unknown,
    opts: { afterOffset: StreamCursor; events?: boolean },
  ): Promise<ItxStreamSubscription> {
    // Callback retention lives in StreamsBackend.subscribe: RPC layers
    // implicitly dispose stubs received as parameters when the call
    // completes, so the capability dup()s the callback its wrapper outlives
    // — without that, replay (delivered in-call) works but the first LIVE
    // batch hits a disposed stub. Verified both ways by
    // itx-subscribe.e2e.test.ts against a live deployment.
    const handle = await this.client().subscribe(
      { afterOffset: opts.afterOffset, events: opts.events },
      onEventBatch,
    );
    return new ItxStreamSubscription(handle);
  }

  /**
   * Reactive sugar over {@link subscribe}: a state-only subscription that
   * calls `onState` with the stream's public state (the `getState()` shape)
   * once immediately on open — the first render — and again after every
   * append. `stream.onStateChange(setState)` is the whole browser story.
   */
  async onStateChange(onState: (state: StreamState) => unknown): Promise<ItxStreamSubscription> {
    // `onState` is an RPC parameter stub disposed when THIS call returns, but
    // deliveries (including the initial push) arrive later through the local
    // wrapper below. dup() it (no-op for plain functions) and hand the
    // wrapper a Symbol.dispose so the capability's unsubscribe/teardown
    // releases the retained stub with everything else.
    const retained = (onState as { dup?(): typeof onState }).dup?.() ?? onState;
    const forwardState = Object.assign((batch: { state: StreamState }) => retained(batch.state), {
      [Symbol.dispose]: () => (retained as Partial<Disposable>)[Symbol.dispose]?.(),
    });
    return await this.subscribe(forwardState, { afterOffset: "end", events: false });
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
