import type { StreamEventPage, StreamEventReadInput } from "iterate/processors";
import { LLM_REPLAY_EVENT_TYPES, replayLlmRequest } from "./llm-request-replay.ts";

const PAGE_SIZE = 250;
const MAX_EVENTS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
const RESPONSE_EVENT_TYPES = [
  "events.iterate.com/agents/context-added",
  "events.iterate.com/agent/token-usage-reported",
  "events.iterate.com/agent/llm-request-settled",
];

/** Reconstruct one request within a 10,000-event / 16 MiB inspection window. */
export async function inspectLlmRequest(
  readPage: (input: StreamEventReadInput) => Promise<StreamEventPage>,
  llmRequestOffset: number,
) {
  if (!Number.isSafeInteger(llmRequestOffset) || llmRequestOffset < 1) {
    throw new Error("LLM request offset must be a positive integer");
  }
  const head = await readPage({ afterOffset: Number.MAX_SAFE_INTEGER, limit: 1 });
  if (llmRequestOffset > head.streamMaxOffset) return null;
  const rawEventJsons: string[] = [];
  let eventCount = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  // The prompt is a prefix. Later reads only need response lifecycle types;
  // unrelated requests cannot expand the prompt reconstruction work.
  for (const window of [
    { after: 0, through: llmRequestOffset, eventTypes: LLM_REPLAY_EVENT_TYPES },
    { after: llmRequestOffset, through: head.streamMaxOffset, eventTypes: RESPONSE_EVENT_TYPES },
  ]) {
    let afterOffset = window.after;
    let settled = false;
    while (afterOffset < window.through) {
      const page = await readPage({
        afterOffset,
        beforeOffset: window.through + 1,
        eventTypes: window.eventTypes,
        includeEphemeral: false,
        limit: PAGE_SIZE,
      });
      if (page.streamId !== head.streamId) {
        throw new Error("stream was recreated while reconstructing the LLM request");
      }
      for (const event of page.events) {
        const json = JSON.stringify(event);
        eventCount++;
        bytes += encoder.encode(json).byteLength;
        if (eventCount > MAX_EVENTS || bytes > MAX_BYTES) {
          throw new Error("LLM inspection window exceeded (10,000 events or 16 MiB)");
        }
        rawEventJsons.push(json);
        if (
          event.type === "events.iterate.com/agent/llm-request-settled" &&
          event.payload?.requestOffset === llmRequestOffset
        ) {
          settled = true;
          break;
        }
      }
      if (settled || page.events.length < PAGE_SIZE) break;
      const nextOffset = page.events.at(-1)!.offset;
      if (nextOffset <= afterOffset) throw new Error("LLM inspection page did not advance");
      afterOffset = nextOffset;
    }
  }
  return replayLlmRequest({ rawEventJsons, llmRequestOffset });
}
