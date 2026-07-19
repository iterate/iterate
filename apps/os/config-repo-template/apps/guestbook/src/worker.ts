import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { IterateDurableObject } from "iterate/sdk";
import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveState, LiveStateRpcTarget, type LiveStateRpc } from "iterate/live-state";
import { itxProjectStream } from "iterate/sdk";
import {
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import {
  guestbookCreationEvents,
  GuestbookProcessor,
  guestbookStreamPath,
  type GuestbookFoldState,
} from "./guestbook.ts";
import type { GuestbookState } from "./lib/state.ts";

// The app's worker: the default export serves the Vite-built TanStack pages
// (and their client assets, via the platform's wrapper), while GuestbookApp
// is the app's DURABLE OBJECT — hosted statefully by the project worker
// (worker.ts at the repo root routes /api here). Where the tanstack todo
// app's rows live in Durable Object SQLite, the guestbook's state is a FOLD
// of durable events on the project stream at /guestbook (the processor and
// its contract live in guestbook.ts): this object only HOSTS the fold and
// mirrors it into Cap'n Web live state, so every open tab repaints the
// moment the stream's wake spine delivers a new signature.

export default createServerEntry({
  fetch(request) {
    return handler.fetch(request);
  },
});

export class GuestbookApp extends IterateDurableObject {
  #host: { guestbook: GuestbookProcessor; registry: StreamProcessorRegistry } | undefined;
  // The live mirror of the fold. Constructed empty: every browser-facing
  // path catches the runner up and republishes before the first snapshot
  // leaves this object, so nobody ever reads this placeholder.
  readonly #live = new LiveState<GuestbookState>({
    title: "Guestbook",
    entries: [],
    lastMilestone: 0,
  });

  // Hosting is constructed lazily, not in the constructor: the registry and
  // the processor's provenance stamps need the owning project's id, which
  // arrives with the wake request or is read from the project stub on first
  // fetch — and is cached durably so an alarm fire needs no dial.
  #ensureHost(projectId: string): {
    guestbook: GuestbookProcessor;
    registry: StreamProcessorRegistry;
  } {
    if (this.#host === undefined) {
      this.ctx.storage.kv.put("guestbook:project-id", projectId);
      const stream = itxProjectStream(this.env, guestbookStreamPath);
      // this.ctx carries working durable alarms (IterateDurableObject routes
      // them through the platform Durable Object hosting this facet), so the
      // registry's keepalive can arm; its fire calls `alarm()` below.
      const registry = createStreamProcessorRegistry(this.ctx, {
        path: guestbookStreamPath,
        projectId,
        stream,
        // The worker's own build identity: a version change resets a
        // crash-looping keepalive's backoff budget, so a broken-then-fixed
        // worker recovers on its next build (the antidote deploy).
        version: this.env.ITERATE_WORKER_VERSION,
      });
      const processor = new GuestbookProcessor({ path: guestbookStreamPath, projectId, stream });
      // The realtime lane: every caught-up delivery — a wake push from the
      // stream spine or an explicit catch-up below — republishes the fold
      // into the live mirror, and Cap'n Web pushes the patch to every tab.
      processor.onAtHead = (state) => this.#publish(state);
      const guestbook = registry.register(
        processor,
        // Keepalive recovery: if an eviction kills this object while it owes
        // work, the alarm fires, the keepalive journals a revival fact, and
        // its wake delivery re-runs the at-head reconcile.
        { recovery: true },
      );
      this.#host = { guestbook, registry };
    }
    return this.#host;
  }

  #publish(state: GuestbookFoldState): void {
    this.#live.setState({
      title: state.birthCertificate?.config.title ?? "Guestbook",
      entries: state.entries,
      lastMilestone: state.lastMilestone,
    });
  }

  /** Construct the host without a wake request in hand: any prior contact
   * cached the project id durably; only the very first ever needs a dial. */
  async #freshHost(): Promise<{
    guestbook: GuestbookProcessor;
    registry: StreamProcessorRegistry;
  }> {
    let projectId = this.ctx.storage.kv.get<string>("guestbook:project-id");
    if (projectId === undefined) {
      using project = await this.env.ITX.get();
      projectId = await project.projectId;
    }
    return this.#ensureHost(projectId);
  }

  /** Read-your-writes: pull the runner to head and republish. Two passes —
   * a milestone the first pass's at-head reconcile journals lands AFTER the
   * scan that pass already finished, so only the second pass folds it. One
   * extra pass is a fixed point: folding a milestone never emits another.
   * The explicit snapshot publish covers the already-at-head case, where a
   * catch-up has no event to deliver and onAtHead never fires. */
  async #catchUpAndPublish(): Promise<void> {
    const { guestbook, registry } = await this.#freshHost();
    await registry.catchUp("guestbook");
    await registry.catchUp("guestbook");
    const { state } = await registry.reads(guestbook).snapshot();
    this.#publish(state);
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

  liveStateTarget(): LiveStateRpcTarget<GuestbookState> {
    return new LiveStateRpcTarget(this.#live);
  }

  async sign(name: string, message: string): Promise<void> {
    const trimmedName = name.trim().slice(0, 80);
    const trimmedMessage = message.trim().slice(0, 500);
    if (trimmedName.length === 0 || trimmedMessage.length === 0) return;
    // One atomic batch: the idempotency-keyed creation events (birth + wake
    // subscription — every signer offers them; the stream dedupes to one of
    // each) plus this entry. Raw appends — the app is the CREATOR here; the
    // processor only ever emits milestone facts.
    using project = await this.env.ITX.get();
    await project.streams.get(guestbookStreamPath).append(...guestbookCreationEvents(), {
      type: "events.iterate.com/guestbook/entry-signed",
      payload: { message: trimmedMessage, name: trimmedName },
      idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
    });
    // Wake delivery is asynchronous; this explicit catch-up republishes the
    // fold NOW, so the signer's own tab (and everyone else's) repaints
    // without waiting on the spine.
    await this.#catchUpAndPublish();
  }

  /** The Cap'n Web door: every /api WebSocket upgrade terminates here. The
   * guestbook is deliberately public — same as its signing lane always was —
   * so the root target needs no authenticate step. */
  async fetch(request: Request): Promise<Response> {
    // Catch up before the socket opens: the subscribe that follows leads
    // with a snapshot of the real fold, never the constructor placeholder.
    await this.#catchUpAndPublish();
    return newWorkersWebSocketRpcResponse(request, new PublicGuestbookApi(this));
  }
}

// What every browser holds: the live fold (read-only by construction) and
// one verb. Every signature refreshes the one LiveState, so every open tab
// repaints from the pushed patch — that IS the multiplayer.
class PublicGuestbookApi extends RpcTarget {
  constructor(private readonly app: GuestbookApp) {
    super();
  }

  get liveState(): LiveStateRpc<GuestbookState> {
    return this.app.liveStateTarget();
  }

  async sign(name: string, message: string): Promise<void> {
    await this.app.sign(name, message);
  }
}
