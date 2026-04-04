import type { Event, JSONObject } from "@iterate-com/events-contract";
import { defineProcessor } from "./define-processor.ts";

export type DynamicProcessorState = Record<string, never>;

export type DynamicWorkerAppendInput = {
  type: Event["type"];
  payload?: JSONObject;
  metadata?: JSONObject;
  idempotencyKey?: string;
  offset?: number;
};

export const dynamicWorkerPocModule = `
import { WorkerEntrypoint } from "cloudflare:workers";

async function* decodeEventStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length === 0) {
          continue;
        }

        const event = decodeEventLine(line);
        if (event) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const event = decodeEventLine(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    if (!finished) {
      await reader.cancel();
    }

    reader.releaseLock();
  }
}

function decodeEventLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function containsPing(event) {
  return /\\bping\\b/i.test(
    JSON.stringify({
      type: event.type,
      payload: event.payload,
      metadata: event.metadata ?? null,
    }),
  );
}

export default class extends WorkerEntrypoint {
  async run(stream) {
    const subscription = await stream.subscribe();

    for await (const event of decodeEventStream(subscription)) {
      if (!containsPing(event)) {
        continue;
      }

      await stream.append({ type: "pong" });
    }
  }
}
`.trim();

/**
 * POC scaffold for a processor whose behavior will eventually be provided by a
 * dynamically loaded worker rather than a statically linked builtin processor.
 *
 * This is intentionally defined as a non-builtin `Processor`: the current
 * stream durable object only executes builtin processors in-process, and a
 * dynamic worker design should preserve the ability to run out-of-process.
 */
export const dynamicProcessor = defineProcessor<DynamicProcessorState>(() => ({
  slug: "dynamic-processor",
  initialState: {},

  reduce({ state }) {
    return state;
  },

  async afterAppend({ state }) {
    void state;
  },
}));
