import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveStateRpcTarget, type LiveStateRpc } from "iterate/live-state";
import {
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { IterateDurableObject, itxProjectStream } from "iterate/sdk";
import { guestbookCreationEvents, guestbookStreamPath } from "./guestbook-ref.ts";
import { GuestbookProcessor, type GuestbookFoldState } from "./guestbook.ts";

// The small, stateful half of the guestbook. It has its own Wrangler entry so
// a cold /api WebSocket loads only the processor host and Cap'n Web runtime,
// never the unrelated TanStack SSR bundle in worker.ts.
export class GuestbookApp extends IterateDurableObject {
  #host: { registry: StreamProcessorRegistry<GuestbookFoldState> } | undefined;

  // Hosting is constructed lazily, not in the constructor: the registry and
  // the processor's provenance stamps need the owning project's id, which
  // arrives with the wake request or is read from the project stub on first
  // fetch — and is cached durably so an alarm fire needs no dial.
  #ensureHost(projectId: string): { registry: StreamProcessorRegistry<GuestbookFoldState> } {
    if (this.#host === undefined) {
      this.ctx.storage.kv.put("guestbook:project-id", projectId);
      const stream = itxProjectStream(this.env, guestbookStreamPath);
      // getLiveState reads `reads`, which is built from this registry after
      // register — the closure runs lazily, on refreshes the registry itself
      // schedules, so the assignment below always wins the race. The
      // explicit return type makes the registry a
      // LiveState<GuestbookFoldState> (the platform's secret DO establishes
      // this exact shape).
      let reads: { currentState: GuestbookFoldState } | undefined;
      const registry = createStreamProcessorRegistry(this.ctx, {
        path: guestbookStreamPath,
        projectId,
        stream,
        // The worker's own build identity: a version change resets a
        // crash-looping keepalive's backoff budget, so a broken-then-fixed
        // worker recovers on its next build (the antidote deploy).
        version: this.env.ITERATE_WORKER_VERSION,
        // The fold IS the live state — nothing to redact, nothing to mirror.
        getLiveState: (): GuestbookFoldState => reads!.currentState,
      });
      const guestbook = registry.register(
        new GuestbookProcessor({ path: guestbookStreamPath, projectId, stream }),
        // Keepalive recovery: if an eviction kills this object while it owes
        // work (a milestone append), the alarm fires, the keepalive journals
        // a revival fact, and its wake delivery re-runs the at-head
        // reconcile.
        { recovery: true },
      );
      reads = registry.reads(guestbook);
      this.#host = { registry };
    }
    return this.#host;
  }

  /** Construct the host without a wake request in hand: any prior contact
   * cached the project id durably; only the very first ever needs a dial. */
  async #freshHost(): Promise<{ registry: StreamProcessorRegistry<GuestbookFoldState> }> {
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
   * wake subscription — every signer offers it; the stream collapses it to
   * one of each) plus this entry. The spine delivers the append back into
   * this object's runner, the fold absorbs it, and the registry republishes
   * the live state to every subscribed tab — nothing else to do here. */
  async sign(name: string, message: string): Promise<void> {
    const trimmedName = name.trim().slice(0, 80);
    const trimmedMessage = message.trim().slice(0, 500);
    if (trimmedName.length === 0 || trimmedMessage.length === 0) return;
    using project = await this.env.ITX.get();
    await project.streams.get(guestbookStreamPath).append(...guestbookCreationEvents(), {
      type: "events.iterate.com/guestbook/entry-signed",
      payload: { message: trimmedMessage, name: trimmedName },
      idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
    });
  }

  /** The Cap'n Web door: every /api WebSocket upgrade terminates here. The
   * guestbook is deliberately public — same as its signing lane always was —
   * so the root target needs no authenticate step. */
  async fetch(request: Request): Promise<Response> {
    const { registry } = await this.#freshHost();
    return newWorkersWebSocketRpcResponse(request, new PublicGuestbookApi(this, registry));
  }
}

// What every browser holds: the fold as live state (read-only by
// construction) and one verb.
class PublicGuestbookApi extends RpcTarget {
  constructor(
    private readonly app: GuestbookApp,
    private readonly registry: StreamProcessorRegistry<GuestbookFoldState>,
  ) {
    super();
  }

  get liveState(): LiveStateRpc<GuestbookFoldState> {
    // The registry is a refreshing live-state source: the target loads
    // committed runner progress before the first read, so a cold object's
    // first snapshot is the real fold, not the schema default.
    return new LiveStateRpcTarget<GuestbookFoldState>(this.registry);
  }

  async sign(name: string, message: string): Promise<void> {
    await this.app.sign(name, message);
  }
}
