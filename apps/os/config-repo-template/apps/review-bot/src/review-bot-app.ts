import type { StreamSubscriberWakeRequest, StreamSubscriberWakeResponse } from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { IterateDurableObject, itxProjectStream } from "iterate/sdk";
import { ReviewBotProcessor } from "./review-bot.ts";

const PROJECT_ID_STORAGE_KEY = "review-bot:project-id";
const STREAM_PATH_STORAGE_KEY = "review-bot:stream-path";

// The review bot's stateful host, one Durable Object instance per GitHub
// connection (the ref's durableWorkerKey carries the connection slug —
// review-bot-ref.ts). Unlike the guestbook, whose stream path is a constant,
// this host learns its coordinates from the first wake request and caches
// them durably so an alarm fire needs no dial. It serves no HTTP and holds no
// live state: it exists purely to put ReviewBotProcessor on the connection
// stream's delivery spine.
export class ReviewBotApp extends IterateDurableObject {
  #host: { registry: StreamProcessorRegistry } | undefined;

  #ensureHost(projectId: string, path: string): { registry: StreamProcessorRegistry } {
    if (this.#host === undefined) {
      this.ctx.storage.kv.put(PROJECT_ID_STORAGE_KEY, projectId);
      this.ctx.storage.kv.put(STREAM_PATH_STORAGE_KEY, path);
      const stream = itxProjectStream(this.env, path);
      const registry = createStreamProcessorRegistry(this.ctx, {
        path,
        projectId,
        stream,
        // The worker's own build identity: a version change resets a
        // crash-looping keepalive's backoff budget, so a broken-then-fixed
        // worker recovers on its next build (the antidote deploy).
        version: this.env.ITERATE_WORKER_VERSION,
      });
      registry.register(
        new ReviewBotProcessor({
          path,
          projectId,
          stream,
          getItx: () => this.env.ITX.get(),
        }),
        // Keepalive recovery: if an eviction kills this object while it owes
        // work (a webhook mid-route under blockProcessorWhile), the alarm
        // fires, the keepalive journals a revival fact, and its wake delivery
        // redelivers the held frame.
        { recovery: true },
      );
      this.#host = { registry };
    }
    return this.#host;
  }

  /** The hosting Durable Object's alarm fire, delivered here like a native
   * one. Route it to the registry: each keepalive self-gates on its own
   * persisted record, so a stale fire is a no-op. An alarm can only have been
   * armed by a hosted registry, which cached its coordinates first — nothing
   * cached means nothing owed. */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const projectId = this.ctx.storage.kv.get<string>(PROJECT_ID_STORAGE_KEY);
    const path = this.ctx.storage.kv.get<string>(STREAM_PATH_STORAGE_KEY);
    if (projectId === undefined || path === undefined) return;
    const { registry } = this.#ensureHost(projectId, path);
    await registry.handleAlarm(alarmInfo);
  }

  /** The wake door the stream spine dials — the subscription's persisted
   * expression is `workers.get(ref).processor.wakeStreamSubscriber`
   * (review-bot-ref.ts), which the platform's dynamic capability dispatch
   * flattens into an invokeCapability walk that lands here. The request
   * carries the stream's coordinates, so the host can construct itself before
   * answering the handshake (checkpoint + a live sink the stream then
   * delivers frames to). */
  get processor() {
    return {
      wakeStreamSubscriber: async (
        request: StreamSubscriberWakeRequest,
      ): Promise<StreamSubscriberWakeResponse> => {
        if (request.stream.projectId === null) {
          throw new Error("the review bot subscribes on project streams only");
        }
        const { registry } = this.#ensureHost(request.stream.projectId, request.stream.path);
        return await registry.wakeStreamSubscriber(request);
      },
    };
  }
}
