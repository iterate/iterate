import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveStateRpcTarget, type LiveStateRpc } from "iterate/live-state";
import {
  type StreamEventInput,
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { IterateDurableObject, itxProjectStream } from "iterate/sdk";
import {
  guestbookCreationEvents,
  guestbookStreamPath,
  guestbookSubscriptionConfigVersion,
} from "./guestbook-ref.ts";
import { GuestbookProcessor, type GuestbookState } from "./guestbook.ts";

const SUBSCRIPTION_VERSION_STORAGE_KEY = "guestbook:subscription-config-version";

// The small, stateful half of the guestbook. It has its own Wrangler entry so
// a cold /api WebSocket loads only the processor host and Cap'n Web runtime,
// never the unrelated TanStack SSR bundle in worker.ts.
export class GuestbookApp extends IterateDurableObject {
  #host: { registry: StreamProcessorRegistry<GuestbookState> } | undefined;
  #configurationInFlight: Promise<void> | undefined;

  // Hosting is constructed lazily, not in the constructor: the registry and
  // the processor's provenance stamps need the owning project's id, which
  // arrives with the wake request or is read from the project stub on first
  // fetch — and is cached durably so an alarm fire needs no dial.
  #ensureHost(projectId: string): { registry: StreamProcessorRegistry<GuestbookState> } {
    if (this.#host === undefined) {
      this.ctx.storage.kv.put("guestbook:project-id", projectId);
      const stream = itxProjectStream(this.env, guestbookStreamPath);
      // getLiveState reads `reads`, which is built from this registry after
      // register — the closure runs lazily, on refreshes the registry itself
      // schedules, so the assignment below always wins the race. The
      // explicit return type makes the registry a
      // LiveState<GuestbookState> (the platform's secret DO establishes
      // this exact shape).
      let reads: { currentState: GuestbookState } | undefined;
      const registry = createStreamProcessorRegistry(this.ctx, {
        path: guestbookStreamPath,
        projectId,
        stream,
        // The worker's own build identity: a version change resets a
        // crash-looping keepalive's backoff budget, so a broken-then-fixed
        // worker recovers on its next build (the antidote deploy).
        version: this.env.ITERATE_WORKER_VERSION,
        // The reduced state IS the live state — nothing to redact, nothing
        // to mirror.
        getLiveState: (): GuestbookState => reads!.currentState,
      });
      const guestbook = registry.register(
        new GuestbookProcessor({ path: guestbookStreamPath, projectId, stream }),
        // Keepalive recovery: if an eviction kills this object while it owes
        // work (a milestone append), the alarm fires, the keepalive appends
        // a revival fact, and its wake delivery re-runs the at-head pass.
        { recovery: true },
      );
      reads = registry.reads(guestbook);
      this.#host = { registry };
    }
    return this.#host;
  }

  /** Construct the host without a wake request in hand: any prior contact
   * cached the project id durably; only the very first ever needs a dial. */
  async #freshHost(): Promise<{ registry: StreamProcessorRegistry<GuestbookState> }> {
    let projectId = this.ctx.storage.kv.get<string>("guestbook:project-id");
    if (projectId === undefined) {
      using project = await this.env.ITX.get();
      projectId = await project.projectId;
    }
    return this.#ensureHost(projectId);
  }

  /** The hosting Durable Object's alarm fire, delivered here like a native
   * one. Route it to the registry: each keepalive self-gates on its own
   * persisted record, so a stale fire is a no-op. */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const { registry } = await this.#freshHost();
    await registry.handleAlarm(alarmInfo);
  }

  /** Append through the one stream lane and record only a successful current
   * subscription offer. The creation/config events are idempotent; entries
   * supplied by a caller retain their own keys. */
  async #appendWithCurrentSubscription(...events: StreamEventInput[]): Promise<void> {
    using project = await this.env.ITX.get();
    await project.streams.get(guestbookStreamPath).append(...guestbookCreationEvents(), ...events);
    this.ctx.storage.kv.put(SUBSCRIPTION_VERSION_STORAGE_KEY, guestbookSubscriptionConfigVersion);
  }

  /** A read-only visit must migrate the persisted wake target too. Waiting
   * here is bounded by the ordinary append call; delivery itself starts in
   * the stream's native alarm turn, so this cannot form an app↔stream actor
   * cycle. The durable version makes the extra RPC once per config revision. */
  async #ensureCurrentSubscription(): Promise<void> {
    if (
      this.ctx.storage.kv.get<number>(SUBSCRIPTION_VERSION_STORAGE_KEY) ===
      guestbookSubscriptionConfigVersion
    ) {
      return;
    }
    if (this.#configurationInFlight === undefined) {
      this.#configurationInFlight = this.#appendWithCurrentSubscription();
    }
    const pending = this.#configurationInFlight;
    try {
      await pending;
    } finally {
      if (this.#configurationInFlight === pending) this.#configurationInFlight = undefined;
    }
  }

  /** The wake door the stream spine dials — the subscription's persisted
   * expression is `workers.get(ref).processor.wakeStreamSubscriber`, which
   * the platform's dynamic capability dispatch flattens into an
   * invokeCapability walk that lands here. The request carries the stream's
   * coordinates, so the host can construct itself before answering the
   * handshake (checkpoint + a live sink the stream then delivers frames to). */
  get processor() {
    return {
      wakeStreamSubscriber: async (
        request: StreamSubscriberWakeRequest,
      ): Promise<StreamSubscriberWakeResponse> => {
        if (request.stream.projectId === null) {
          throw new Error("the guestbook subscribes on project streams only");
        }
        const { registry } = this.#ensureHost(request.stream.projectId);
        return await registry.wakeStreamSubscriber(request);
      },
    };
  }

  /** Signing IS appending: the idempotency-keyed creation batch (birth +
   * current wake-subscription config — every signer offers it; the stream
   * collapses each version and replaces older config at the same subscription
   * key) plus this entry. The spine delivers the append back into this
   * object's runner, reduce absorbs it, and the registry republishes the
   * live state to every subscribed tab — nothing else to do here. */
  async sign(name: string, message: string): Promise<void> {
    const trimmedName = name.trim().slice(0, 80);
    const trimmedMessage = message.trim().slice(0, 500);
    if (trimmedName.length === 0 || trimmedMessage.length === 0) return;
    await this.#appendWithCurrentSubscription({
      type: "events.iterate.com/guestbook/entry-signed",
      payload: { message: trimmedMessage, name: trimmedName },
      idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
    });
  }

  /** The Cap'n Web door: every /api WebSocket upgrade terminates here. The
   * guestbook is deliberately public — same as its signing lane always was —
   * so the root target needs no authenticate step. */
  async fetch(request: Request): Promise<Response> {
    await this.#ensureCurrentSubscription();
    const { registry } = await this.#freshHost();
    return newWorkersWebSocketRpcResponse(request, new PublicGuestbookApi(this, registry));
  }
}

// What every browser holds: the reduced state as live state (read-only by
// construction) and one verb.
class PublicGuestbookApi extends RpcTarget {
  constructor(
    private readonly app: GuestbookApp,
    private readonly registry: StreamProcessorRegistry<GuestbookState>,
  ) {
    super();
  }

  get liveState(): LiveStateRpc<GuestbookState> {
    // The registry is a refreshing live-state source: the target loads
    // committed runner progress before the first read, so a cold object's
    // first snapshot is the real reduced state, not the schema default.
    return new LiveStateRpcTarget<GuestbookState>(this.registry);
  }

  async sign(name: string, message: string): Promise<void> {
    await this.app.sign(name, message);
  }
}
