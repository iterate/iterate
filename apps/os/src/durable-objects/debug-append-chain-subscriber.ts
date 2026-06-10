import { DurableObject } from "cloudflare:workers";
import type { Event } from "@iterate-com/shared/streams/types.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";

export const DEBUG_APPEND_CHAIN_EVENT_TYPE = "events.iterate.com/debug/append-chain-tick";

type DebugAppendChainSubscriberEnv = {
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

type DebugAppendChainPayload = {
  chainId: string;
  count: number;
  max: number;
  mode: "alarm" | "sync";
  projectId: string;
  streamPath: string;
};

const PENDING_ALARM_APPENDS_KEY = "debug-append-chain:pending-alarm-appends";

/**
 * Temporary diagnostic target for isolating whether synchronous stream
 * subscriber fanout can consume Cloudflare's request-recursion budget.
 *
 * The shape intentionally mirrors codemode's callable subscription path:
 * StreamDurableObject.append() -> external subscriber callable afterAppend()
 * -> this Durable Object -> StreamDurableObject.append() again.
 */
export class DebugAppendChainSubscriber extends DurableObject<DebugAppendChainSubscriberEnv> {
  constructor(ctx: DurableObjectState, env: DebugAppendChainSubscriberEnv) {
    super(ctx, env);
  }

  async afterAppend(input: { event: Event }) {
    if (input.event.type !== DEBUG_APPEND_CHAIN_EVENT_TYPE) {
      return { ignored: true, eventType: input.event.type };
    }

    const payload = parseDebugAppendChainPayload(input.event.payload);
    console.log("[DEBUG-append-chain] subscriber.afterAppend", {
      chainId: payload.chainId,
      count: payload.count,
      max: payload.max,
      offset: input.event.offset,
      streamPath: payload.streamPath,
    });

    if (payload.count >= payload.max) {
      return { done: true, count: payload.count };
    }

    if (payload.mode === "alarm") {
      await this.enqueueAlarmAppend({
        ...payload,
        count: payload.count + 1,
      });
      console.log("[DEBUG-append-chain] subscriber.scheduledAlarmAppend", {
        chainId: payload.chainId,
        currentCount: payload.count,
        nextCount: payload.count + 1,
        streamPath: payload.streamPath,
      });
      return {
        count: payload.count,
        done: false,
        scheduledCount: payload.count + 1,
      };
    }

    console.log("[DEBUG-append-chain] subscriber.beforeAppendNext", {
      chainId: payload.chainId,
      currentCount: payload.count,
      nextCount: payload.count + 1,
      streamPath: payload.streamPath,
    });

    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: payload.projectId,
      path: payload.streamPath,
    });
    const appended = await stream
      .append({
        type: DEBUG_APPEND_CHAIN_EVENT_TYPE,
        payload: {
          ...payload,
          count: payload.count + 1,
        },
      })
      .catch((error: unknown) => {
        console.error("[DEBUG-append-chain] subscriber.appendNextFailed", {
          chainId: payload.chainId,
          currentCount: payload.count,
          error,
          nextCount: payload.count + 1,
          streamPath: payload.streamPath,
        });
        throw error;
      });

    console.log("[DEBUG-append-chain] subscriber.afterAppendNext", {
      appendedOffset: appended.offset,
      chainId: payload.chainId,
      currentCount: payload.count,
      nextCount: payload.count + 1,
      streamPath: payload.streamPath,
    });

    return {
      appendedOffset: appended.offset,
      count: payload.count + 1,
      done: payload.count + 1 >= payload.max,
    };
  }

  async alarm() {
    const [next, ...remaining] = await this.readPendingAlarmAppends();
    if (!next) {
      return;
    }

    await this.ctx.storage.put(PENDING_ALARM_APPENDS_KEY, remaining);
    console.log("[DEBUG-append-chain] subscriber.alarmAppend", {
      chainId: next.chainId,
      count: next.count,
      remaining: remaining.length,
      streamPath: next.streamPath,
    });

    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: next.projectId,
      path: next.streamPath,
    });
    await stream.append({
      type: DEBUG_APPEND_CHAIN_EVENT_TYPE,
      payload: next,
    });

    if (remaining.length > 0) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  private async enqueueAlarmAppend(payload: DebugAppendChainPayload) {
    const pending = await this.readPendingAlarmAppends();
    pending.push(payload);
    await this.ctx.storage.put(PENDING_ALARM_APPENDS_KEY, pending);
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async readPendingAlarmAppends() {
    const pending =
      await this.ctx.storage.get<DebugAppendChainPayload[]>(PENDING_ALARM_APPENDS_KEY);
    return pending ?? [];
  }
}

function parseDebugAppendChainPayload(payload: object): DebugAppendChainPayload {
  const candidate = payload as Partial<DebugAppendChainPayload>;
  if (
    typeof candidate.chainId !== "string" ||
    typeof candidate.count !== "number" ||
    typeof candidate.max !== "number" ||
    (candidate.mode !== "alarm" && candidate.mode !== "sync") ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.streamPath !== "string"
  ) {
    throw new Error("Invalid debug append-chain payload.");
  }

  return {
    chainId: candidate.chainId,
    count: candidate.count,
    max: candidate.max,
    mode: candidate.mode,
    projectId: candidate.projectId,
    streamPath: candidate.streamPath,
  };
}
