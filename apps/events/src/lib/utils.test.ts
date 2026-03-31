import { describe, expect, test, vi } from "vitest";
import type { Event } from "@iterate-com/events-contract";
import { decodeEventStream } from "~/lib/utils.ts";

describe("decodeEventStream", () => {
  test("decodes newline-delimited events across chunk boundaries", async () => {
    const events = await collectEvents(
      createStream([
        `${JSON.stringify(createEvent({ offset: "1" }))}\n${JSON.stringify(createEvent({ offset: "2" })).slice(0, 40)}`,
        `${JSON.stringify(createEvent({ offset: "2" })).slice(40)}\n`,
      ]),
    );

    expect(events.map((event) => event.offset)).toEqual(["1", "2"]);
  });

  test("skips malformed lines and keeps later valid events flowing", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const events = await collectEvents(
        createStream([
          `${JSON.stringify(createEvent({ offset: "1" }))}\n`,
          `not-json\n42\n${JSON.stringify(createEvent({ offset: "2" }))}\n`,
        ]),
      );

      expect(events.map((event) => event.offset)).toEqual(["1", "2"]);
      expect(consoleWarn).toHaveBeenCalledTimes(2);
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

async function collectEvents(stream: ReadableStream<Uint8Array>) {
  const events: Event[] = [];

  for await (const event of decodeEventStream(stream)) {
    events.push(event);
  }

  return events;
}

function createStream(chunks: string[]) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });
}

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    path: "/demo",
    type: "https://events.iterate.com/manual-event-appended",
    payload: {},
    offset: "1",
    createdAt: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}
