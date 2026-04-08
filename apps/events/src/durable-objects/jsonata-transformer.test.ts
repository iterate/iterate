import { describe, expect, test, vi } from "vitest";
import {
  type Event,
  type EventInput,
  type JsonataTransformerConfiguredEvent,
  type JsonataTransformerState,
} from "@iterate-com/events-contract";
import { JsonataExpression, jsonataTransformerProcessor } from "./jsonata-transformer.ts";

describe("jsonataTransformer", () => {
  test("JsonataExpression accepts valid JSONata and rejects invalid JSONata", () => {
    expect(JsonataExpression.parse("$")).toBe("$");
    expect(() => JsonataExpression.parse(")")).toThrow(/Invalid JSONata expression:/);
  });

  test("reduce stores configured transformers by slug", () => {
    const state = structuredClone(jsonataTransformerProcessor.initialState);

    const nextState = jsonataTransformerProcessor.reduce!({
      state,
      event: createConfiguredEvent({
        slug: "slack-webhook",
        matcher: "type = 'slack.raw'",
        transform: '{"type":"slack.normalized","payload":{"original":payload}}',
      }),
    });

    expect(nextState).toEqual({
      transformersBySlug: {
        "slack-webhook": {
          matcher: "type = 'slack.raw'",
          transform: '{"type":"slack.normalized","payload":{"original":payload}}',
        },
      },
    });
  });

  test("reduce replaces an existing transformer when the same slug is configured again", () => {
    const state = structuredClone(jsonataTransformerProcessor.initialState);

    const state2 = jsonataTransformerProcessor.reduce!({
      state,
      event: createConfiguredEvent({
        slug: "normalize",
        matcher: "type = 'one'",
        transform: '{"type":"two","payload":{}}',
      }),
    });
    const state3 = jsonataTransformerProcessor.reduce!({
      state: state2,
      event: createConfiguredEvent({
        slug: "normalize",
        matcher: "type = 'three'",
        transform: '{"type":"four","payload":{}}',
      }),
    });

    expect(state3.transformersBySlug.normalize).toEqual({
      matcher: "type = 'three'",
      transform: '{"type":"four","payload":{}}',
    });
  });

  test("afterAppend appends a transformed event for matching events only", async () => {
    const appended: EventInput[] = [];
    const state: JsonataTransformerState = {
      transformersBySlug: {
        normalize: {
          matcher: "type = 'source'",
          transform: '{"type":"derived","payload":{"copied":payload.value}}',
        },
      },
    };

    await jsonataTransformerProcessor.afterAppend?.({
      append: (event) => {
        appended.push(event);
        return createEvent({
          type: event.type,
          payload: event.payload,
        });
      },
      event: createEvent({
        type: "source",
        payload: { value: 42 },
      }),
      state,
    });

    expect(appended).toEqual([
      {
        type: "derived",
        payload: { copied: 42 },
      },
    ]);
  });

  test("afterAppend skips invalid transformed payloads without failing the source event", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const append = vi.fn<(event: EventInput) => Event>();

    try {
      await jsonataTransformerProcessor.afterAppend?.({
        append,
        event: createEvent({
          type: "source",
          payload: { value: 42 },
        }),
        state: {
          transformersBySlug: {
            bad: {
              matcher: "true",
              transform: '{"payload":{"missing":"type"}}',
            },
          },
        },
      });

      expect(append).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[stream-do] jsonata transform produced an invalid event",
        expect.objectContaining({
          slug: "bad",
          eventType: "source",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("afterAppend allows recursive chains when derived events keep matching other transformers", async () => {
    const appendedTypes: string[] = [];
    const pending: Promise<void>[] = [];
    const state: JsonataTransformerState = {
      transformersBySlug: {
        first: {
          matcher: "type = 'source'",
          transform: '{"type":"mid","payload":{"step":1}}',
        },
        second: {
          matcher: "type = 'mid'",
          transform: '{"type":"final","payload":{"step":payload.step + 1}}',
        },
      },
    };

    const append = (event: EventInput) => {
      appendedTypes.push(event.type);
      const storedEvent = createEvent({
        type: event.type,
        payload: event.payload,
        offset: appendedTypes.length + 1,
      });

      pending.push(
        jsonataTransformerProcessor.afterAppend?.({
          append,
          event: storedEvent,
          state,
        }) ?? Promise.resolve(),
      );

      return storedEvent;
    };

    pending.push(
      jsonataTransformerProcessor.afterAppend?.({
        append,
        event: createEvent({
          type: "source",
          payload: { step: 0 },
        }),
        state,
      }) ?? Promise.resolve(),
    );

    while (pending.length > 0) {
      await pending.shift();
    }

    expect(appendedTypes).toEqual(["mid", "final"]);
  });
});

function createConfiguredEvent(args: {
  matcher: string;
  slug: string;
  transform: string;
}): JsonataTransformerConfiguredEvent {
  return createEvent({
    type: "https://events.iterate.com/events/stream/jsonata-transformer-configured",
    payload: {
      slug: args.slug,
      matcher: args.matcher,
      transform: args.transform,
    },
  }) as JsonataTransformerConfiguredEvent;
}

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    streamPath: "/demo",
    type: "https://events.iterate.com/manual-event-appended",
    payload: {},
    offset: 1,
    createdAt: "2026-04-02T12:00:00.000Z",
    ...overrides,
  };
}
