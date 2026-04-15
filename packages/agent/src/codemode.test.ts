import { describe, expect, test } from "vitest";
import {
  type Event,
  Event as EventSchema,
  StreamPath,
  type EventInput,
} from "../../../apps/events-contract/src/types.ts";
import { AgentInputEvent } from "./agent.ts";
import { processor } from "./codemode.ts";

const logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  log: () => {},
  warn: () => {},
};

function makeEvent(input: EventInput, offset: number): Event {
  return EventSchema.parse({
    streamPath: StreamPath.parse("/packages/agent/tests/codemode"),
    offset,
    type: input.type,
    payload: input.payload ?? {},
    metadata: input.metadata,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date(offset * 1_000).toISOString(),
  });
}

async function runProcessor(initialEvent: EventInput) {
  const emitted: EventInput[] = [];
  const queue = [makeEvent(initialEvent, 1)];
  let nextOffset = 2;

  while (queue.length > 0) {
    const event = queue.shift()!;
    await processor.afterAppend?.({
      append: async ({ event }) => {
        emitted.push(event);
        const appendedEvent = makeEvent(event, nextOffset);
        nextOffset += 1;
        queue.push(appendedEvent);
        return appendedEvent;
      },
      event,
      logger,
      state: undefined,
    });
  }

  return emitted;
}

describe("codemode", () => {
  test("executes a js block with sendMessage and append", async () => {
    const emitted = await runProcessor(
      AgentInputEvent.parse({
        type: "agent-input-added",
        payload: {
          role: "assistant",
          content: [
            "```js",
            "async () => {",
            '  await codemode.sendMessage({ message: "Hello!" });',
            '  await codemode.append({ event: { type: "custom-event-added", payload: { ok: true } } });',
            '  console.log("finished");',
            "  return { status: 'done' };",
            "}",
            "```",
          ].join("\n"),
        },
      }),
    );

    expect(emitted).toEqual([
      {
        type: "codemode-block-added",
        payload: {
          code: [
            "async () => {",
            '  await codemode.sendMessage({ message: "Hello!" });',
            '  await codemode.append({ event: { type: "custom-event-added", payload: { ok: true } } });',
            '  console.log("finished");',
            "  return { status: 'done' };",
            "}",
          ].join("\n"),
        },
      },
      {
        type: "message-added",
        payload: {
          message: "Hello!",
        },
      },
      {
        type: "custom-event-added",
        payload: {
          ok: true,
        },
      },
      {
        type: "codemode-result-added",
        payload: {
          result: JSON.stringify({ status: "done" }, null, 2),
          error: null,
          logs: ["finished"],
        },
      },
    ]);
  });
});
