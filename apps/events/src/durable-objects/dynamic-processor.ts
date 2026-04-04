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

export default class extends WorkerEntrypoint {
  async run(stream) {
    await stream.append({ type: "pong" });
  }
}
`.trim();

export function shouldRunDynamicWorkerPoc(event: Event) {
  return event.type === "ping";
}

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
