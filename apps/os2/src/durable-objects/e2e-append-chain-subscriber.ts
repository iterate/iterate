import { DurableObject } from "cloudflare:workers";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers.ts";
import { type Event, StreamPath } from "@iterate-com/shared/streams/types.ts";
import { z } from "zod";

export const E2E_APPEND_CHAIN_TICK_TYPE = "events.iterate.com/e2e/callable-append-chain-tick";

type E2EAppendChainSubscriberEnv = {
  STREAM: StreamDurableObjectNamespace;
};

const LAST_ERROR_KEY = "e2e-append-chain:last-error";
const LAST_EVENT_KEY = "e2e-append-chain:last-event";

const AppendChainPayload = z.strictObject({
  chainId: z.string().trim().min(1),
  count: z.number().int().min(1),
  max: z.number().int().min(1).max(300),
  mode: z.enum(["record-error", "timeout"]),
  namespace: z.literal("public"),
  streamPath: StreamPath,
});
type AppendChainPayload = z.infer<typeof AppendChainPayload>;

type StoredSubscriberError = {
  count: number;
  message: string;
  name: string;
};

/**
 * Test-only callable subscriber used by Events preview e2e tests when Events
 * binds STREAM to OS2's deployed Stream Durable Object script. Callable
 * subscriber env bindings are resolved by the worker owning the stream DO, so
 * OS2 preview must expose this binding alongside Events preview.
 */
export class E2EAppendChainSubscriber extends DurableObject<E2EAppendChainSubscriberEnv> {
  async afterAppend(input: { event: Event }) {
    if (input.event.type !== E2E_APPEND_CHAIN_TICK_TYPE) {
      return { ignored: true };
    }

    const payload = AppendChainPayload.parse(input.event.payload);
    await this.ctx.storage.put(LAST_EVENT_KEY, payload);
    if (payload.count >= payload.max) {
      return { done: true, count: payload.count };
    }

    if (payload.mode === "record-error") {
      try {
        return await this.appendNext(payload);
      } catch (error) {
        const storedError = serializeSubscriberError(error, payload.count);
        await this.ctx.storage.put(LAST_ERROR_KEY, storedError);
        return {
          done: false,
          error: storedError,
        };
      }
    }

    return await this.appendNext(payload);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname !== "/status") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json({
      lastError: (await this.ctx.storage.get<StoredSubscriberError>(LAST_ERROR_KEY)) ?? null,
      lastEvent: (await this.ctx.storage.get<AppendChainPayload>(LAST_EVENT_KEY)) ?? null,
    });
  }

  private async appendNext(payload: AppendChainPayload) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM,
      namespace: payload.namespace,
      path: StreamPath.parse(payload.streamPath),
    });
    const nextCount = payload.count + 1;
    const appended = await stream.append({
      type: E2E_APPEND_CHAIN_TICK_TYPE,
      idempotencyKey: `e2e-callable-append-chain:${payload.chainId}:${nextCount}`,
      payload: {
        ...payload,
        count: nextCount,
      },
    });

    return {
      appendedOffset: appended.offset,
      count: nextCount,
      done: nextCount >= payload.max,
    };
  }
}

function serializeSubscriberError(error: unknown, count: number): StoredSubscriberError {
  return {
    count,
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
}
