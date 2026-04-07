import { describe, expect, test, vi } from "vitest";
import type {
  Event,
  ExternalSubscriber,
  StreamSubscriptionConfiguredEvent,
} from "@iterate-com/events-contract";
import { externalSubscriberProcessor } from "./external-subscriber.ts";

describe("externalSubscriber", () => {
  test("reduce stores subscribers by slug and replaces existing entries", () => {
    const state = structuredClone(externalSubscriberProcessor.initialState);

    const state2 = externalSubscriberProcessor.reduce!({
      state,
      event: createConfiguredEvent({
        slug: "processor:ping-pong",
        type: "websocket",
        callbackUrl: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo",
      }),
    });
    const state3 = externalSubscriberProcessor.reduce!({
      state: state2,
      event: createConfiguredEvent({
        slug: "audit",
        type: "webhook",
        callbackUrl: "https://example.com/hook",
        jsonataFilter: "type = 'source'",
      }),
    });
    const state4 = externalSubscriberProcessor.reduce!({
      state: state3,
      event: createConfiguredEvent({
        slug: "audit",
        type: "webhook",
        callbackUrl: "https://example.com/hook-2",
        jsonataTransform: '{"copied":payload.value}',
      }),
    });

    expect(state4).toEqual({
      subscribersBySlug: {
        "processor:ping-pong": {
          slug: "processor:ping-pong",
          type: "websocket",
          callbackUrl: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo",
        },
        audit: {
          slug: "audit",
          type: "webhook",
          callbackUrl: "https://example.com/hook-2",
          jsonataTransform: '{"copied":payload.value}',
        },
      },
    });
  });

  test("afterAppend sends raw event json to websocket subscribers by default", async () => {
    const socket = new FakeWebSocket();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createWebSocketUpgradeResponse(socket));

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-raw",
          type: "source",
          payload: { value: 42 },
          offset: 7,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-raw",
            },
          },
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(socket.sentMessages).toEqual([
        JSON.stringify(
          createEvent({
            streamPath: "/demo/ws-raw",
            type: "source",
            payload: { value: 42 },
            offset: 7,
          }),
        ),
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("afterAppend fire-and-forget posts transformed webhook payloads when filter matches", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/webhook-match",
          type: "source",
          payload: { value: 42 },
        }),
        state: {
          subscribersBySlug: {
            audit: {
              slug: "audit",
              type: "webhook",
              callbackUrl: "https://example.com/hook",
              jsonataFilter: "type = 'source'",
              jsonataTransform: '{"kind":"hook","copied":payload.value}',
            },
          },
        },
      });

      expect(fetchMock).toHaveBeenCalledWith("https://example.com/hook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "hook",
          copied: 42,
        }),
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("afterAppend skips subscribers whose filter does not match", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/webhook-skip",
          type: "other",
          payload: { value: 42 },
        }),
        state: {
          subscribersBySlug: {
            audit: {
              slug: "audit",
              type: "webhook",
              callbackUrl: "https://example.com/hook",
              jsonataFilter: "type = 'source'",
            },
          },
        },
      });

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("afterAppend logs and skips invalid transform output", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/invalid-transform",
          type: "source",
          payload: { value: 42 },
        }),
        state: {
          subscribersBySlug: {
            audit: {
              slug: "audit",
              type: "webhook",
              callbackUrl: "https://example.com/hook",
              jsonataTransform: "$nonexistent",
            },
          },
        },
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[stream-do] external subscriber transform produced invalid JSON",
        expect.objectContaining({
          subscriberSlug: "audit",
          callbackUrl: "https://example.com/hook",
        }),
      );
    } finally {
      consoleError.mockRestore();
      fetchMock.mockRestore();
    }
  });
});

function createConfiguredEvent(payload: ExternalSubscriber): StreamSubscriptionConfiguredEvent {
  return createEvent({
    type: "https://events.iterate.com/events/stream/subscription/configured",
    payload,
  }) as StreamSubscriptionConfiguredEvent;
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

function createWebSocketUpgradeResponse(socket: FakeWebSocket) {
  return {
    ok: true,
    status: 101,
    webSocket: socket as unknown as WebSocket,
  } as Response & { webSocket: WebSocket };
}

class FakeWebSocket {
  sentMessages: string[] = [];
  readyState = 1;
  readonly #listeners = new Map<string, Array<() => void>>();

  accept() {}

  send(message: string) {
    this.sentMessages.push(message);
  }

  close() {
    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? []) {
      listener();
    }
  }

  addEventListener(type: string, listener: () => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
}
