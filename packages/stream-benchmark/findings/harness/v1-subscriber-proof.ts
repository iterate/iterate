import type { StreamV1 } from "../../src/stream/v1/stream.js";
import type { StreamEvent } from "../../src/stream/v1/types.js";

export type V1SubscriberProofResult = {
  ok: boolean;
  streamPath: string;
  processorSlug: string;
  runId: string;
  elapsedMs: number;
  events: Pick<StreamEvent, "offset" | "type" | "payload">[];
  pong?: Pick<StreamEvent, "offset" | "type" | "payload">;
  error?: string;
};

/**
 * End-to-end proof that v1 durable subscribers work:
 * subscription-configured → stream pushes to StreamProcessor → echo appends pong.
 */
export async function runV1SubscriberProof(args: {
  stream: DurableObjectStub<StreamV1>;
  streamPath: string;
  timeoutMs?: number;
}): Promise<V1SubscriberProofResult> {
  const startedAt = performance.now();
  const runId = crypto.randomUUID();
  const processorSlug = "echo";
  const timeoutMs = args.timeoutMs ?? 10_000;

  const events: Pick<StreamEvent, "offset" | "type" | "payload">[] = [];

  try {
    await args.stream.append({
      event: {
        type: "subscription-configured",
        idempotencyKey: `proof:subscription:${runId}`,
        payload: {
          key: "echo",
          processorSlug,
        },
      },
    });

    await args.stream.append({
      event: {
        type: "ping",
        idempotencyKey: `proof:ping:${runId}`,
        payload: { runId },
      },
    });

    const pong = await waitForPong({
      read: async () => (await args.stream.read({ after: "start" })) as StreamEvent[],
      timeoutMs,
    });

    for (const event of (await args.stream.read({ after: "start" })) as StreamEvent[]) {
      events.push({ offset: event.offset, type: event.type, payload: event.payload });
    }

    return {
      ok: true,
      streamPath: args.streamPath,
      processorSlug,
      runId,
      elapsedMs: performance.now() - startedAt,
      events,
      pong: { offset: pong.offset, type: pong.type, payload: pong.payload },
    };
  } catch (error) {
    try {
      for (const event of (await args.stream.read({ after: "start" })) as StreamEvent[]) {
        events.push({ offset: event.offset, type: event.type, payload: event.payload });
      }
    } catch {}

    return {
      ok: false,
      streamPath: args.streamPath,
      processorSlug,
      runId,
      elapsedMs: performance.now() - startedAt,
      events,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForPong(args: {
  read: () => Promise<StreamEvent[]>;
  timeoutMs: number;
}): Promise<StreamEvent> {
  const deadline = Date.now() + args.timeoutMs;

  while (Date.now() < deadline) {
    const pong = (await args.read()).find((event) => event.type === "pong");
    if (pong != null) return pong;
    await sleep(25);
  }

  throw new Error(`Timed out after ${args.timeoutMs}ms waiting for pong from echo processor.`);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
