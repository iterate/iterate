import { describe, expect, test, vi } from "vitest";
import type {
  Event,
  ExternalSubscriber,
  StreamSubscriptionConfiguredEvent,
} from "@iterate-com/events-contract";

const { openOutboundWebSocketMock } = vi.hoisted(() => ({
  openOutboundWebSocketMock: vi.fn<(callbackUrl: string) => Promise<WebSocket>>(),
}));
vi.mock("./outbound-websocket.ts", () => ({
  openOutboundWebSocket: openOutboundWebSocketMock,
}));

import {
  externalSubscriberProcessor,
  resetSubscriberSocketsForStream,
} from "./external-subscriber.ts";

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

  test("afterAppend sends framed event messages to websocket subscribers by default", async () => {
    const socket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-raw",
    });
    openOutboundWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);

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

      expect(openOutboundWebSocketMock).toHaveBeenCalledWith(
        "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-raw",
      );
      expect(socket.sentMessages).toEqual([
        createEventFrame(
          createEvent({
            streamPath: "/demo/ws-raw",
            type: "source",
            payload: { value: 42 },
            offset: 7,
          }),
        ),
      ]);
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-raw");
    }
  });

  test("afterAppend canonicalizes framed websocket events and ignores websocket transforms", async () => {
    const socket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-canonical",
    });
    openOutboundWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);
    const eventWithUndefinedFields = {
      ...createEvent({
        streamPath: "/demo/ws-canonical",
        type: "source",
        payload: { value: 42 },
        offset: 8,
      }),
      idempotencyKey: undefined,
      metadata: undefined,
    } satisfies Event;

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: eventWithUndefinedFields,
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl:
                "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-canonical",
              jsonataTransform: '{"kind":"transformed"}',
            },
          },
        },
      });

      expect(openOutboundWebSocketMock).toHaveBeenCalledWith(
        "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-canonical",
      );
      expect(socket.sentMessages).toEqual([
        createEventFrame(
          createEvent({
            streamPath: "/demo/ws-canonical",
            type: "source",
            payload: { value: 42 },
            offset: 8,
          }),
        ),
      ]);
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-canonical");
    }
  });

  test("afterAppend reconnects when a subscriber callbackUrl changes", async () => {
    const staleSocket = new FakeWebSocket({
      throwOnClose: true,
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
    });
    const nextSocket = new FakeWebSocket({
      url: "ws://localhost:9898/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
    });
    openOutboundWebSocketMock
      .mockResolvedValueOnce(staleSocket as unknown as WebSocket)
      .mockResolvedValueOnce(nextSocket as unknown as WebSocket);

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-reconnect",
          type: "source",
          payload: { value: 1 },
          offset: 1,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl:
                "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
            },
          },
        },
      });

      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-reconnect",
          type: "source",
          payload: { value: 2 },
          offset: 2,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl:
                "ws://localhost:9898/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
            },
          },
        },
      });

      expect(openOutboundWebSocketMock.mock.calls).toEqual([
        ["ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect"],
        ["ws://localhost:9898/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect"],
      ]);
      expect(staleSocket.sentMessages).toEqual([
        createEventFrame(
          createEvent({
            streamPath: "/demo/ws-reconnect",
            type: "source",
            payload: { value: 1 },
            offset: 1,
          }),
        ),
      ]);
      expect(nextSocket.sentMessages).toEqual([
        createEventFrame(
          createEvent({
            streamPath: "/demo/ws-reconnect",
            type: "source",
            payload: { value: 2 },
            offset: 2,
          }),
        ),
      ]);
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-reconnect");
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

  test("afterAppend does not deliver subscription-configured events to webhook subscribers by default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createConfiguredEvent({
          slug: "audit",
          type: "webhook",
          callbackUrl: "https://example.com/hook",
        }),
        state: {
          subscribersBySlug: {
            audit: {
              slug: "audit",
              type: "webhook",
              callbackUrl: "https://example.com/hook",
            },
          },
        },
      });

      expect(fetchMock).not.toHaveBeenCalled();
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

  test("websocket append frames append into the same stream", async () => {
    const socket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append",
    });
    openOutboundWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);
    const appendSpy = vi.fn((event) =>
      createEvent({
        streamPath: "/demo/ws-append",
        type: event.type,
        payload: event.payload,
      }),
    );

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: appendSpy,
        event: createEvent({
          streamPath: "/demo/ws-append",
          type: "source",
          payload: { value: 1 },
          offset: 1,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append",
            },
          },
        },
      });

      await socket.dispatchMessage(
        JSON.stringify({
          type: "append",
          event: {
            type: "peer-source",
            payload: { value: 99 },
          },
        }),
      );

      expect(appendSpy).toHaveBeenCalledWith({
        type: "peer-source",
        payload: { value: 99 },
      });
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-append");
    }
  });

  test("websocket append failures produce error frames", async () => {
    const socket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append-error",
    });
    openOutboundWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);
    const appendSpy = vi.fn(() => {
      throw new Error("append broke");
    });

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: appendSpy,
        event: createEvent({
          streamPath: "/demo/ws-append-error",
          type: "source",
          payload: { value: 1 },
          offset: 1,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl:
                "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append-error",
            },
          },
        },
      });

      await socket.dispatchMessage(
        JSON.stringify({
          type: "append",
          event: {
            type: "peer-source",
            payload: { value: 99 },
          },
        }),
      );

      expect(socket.sentMessages.at(-1)).toEqual(createErrorFrame("append broke"));
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-append-error");
    }
  });

  test("unknown websocket JSON shapes are ignored (no error frame)", async () => {
    const socket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-invalid-frame",
    });
    openOutboundWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-invalid-frame",
          type: "source",
          payload: { value: 1 },
          offset: 1,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl:
                "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-invalid-frame",
            },
          },
        },
      });

      const afterOutboundEvent = [...socket.sentMessages];
      await socket.dispatchMessage(JSON.stringify({ type: "wat" }));

      expect(socket.sentMessages).toEqual(afterOutboundEvent);
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-invalid-frame");
    }
  });

  test("resetSubscriberSocketsForStream clears cached websocket connections for the stream", async () => {
    const firstSocket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
    });
    const secondSocket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
    });
    openOutboundWebSocketMock
      .mockResolvedValueOnce(firstSocket as unknown as WebSocket)
      .mockResolvedValueOnce(secondSocket as unknown as WebSocket);

    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-reset",
          type: "source",
          payload: { value: 1 },
          offset: 1,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
            },
          },
        },
      });

      resetSubscriberSocketsForStream("/demo/ws-reset");

      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-reset",
          type: "source",
          payload: { value: 2 },
          offset: 2,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
            },
          },
        },
      });

      expect(openOutboundWebSocketMock).toHaveBeenCalledTimes(2);
      expect(firstSocket.readyState).toBe(3);
      expect(secondSocket.sentMessages).toEqual([
        createEventFrame(
          createEvent({
            streamPath: "/demo/ws-reset",
            type: "source",
            payload: { value: 2 },
            offset: 2,
          }),
        ),
      ]);
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-reset");
    }
  });

  test("resetSubscriberSocketsForStream invalidates in-flight websocket connects for the stream", async () => {
    const firstSocket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
    });
    const secondSocket = new FakeWebSocket({
      url: "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
    });
    const firstConnect = Promise.withResolvers<WebSocket>();
    openOutboundWebSocketMock
      .mockReturnValueOnce(firstConnect.promise)
      .mockResolvedValueOnce(secondSocket as unknown as WebSocket);

    try {
      const publishPromise = externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-reset-pending",
          type: "source",
          payload: { value: 1 },
          offset: 1,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl:
                "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
            },
          },
        },
      });

      while (openOutboundWebSocketMock.mock.calls.length === 0) {
        await Promise.resolve();
      }

      resetSubscriberSocketsForStream("/demo/ws-reset-pending");
      firstConnect.resolve(firstSocket as unknown as WebSocket);
      await publishPromise;

      expect(firstSocket.sentMessages).toEqual([]);

      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createEvent({
          streamPath: "/demo/ws-reset-pending",
          type: "source",
          payload: { value: 2 },
          offset: 2,
        }),
        state: {
          subscribersBySlug: {
            "processor:ping-pong": {
              slug: "processor:ping-pong",
              type: "websocket",
              callbackUrl:
                "ws://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
            },
          },
        },
      });

      expect(openOutboundWebSocketMock).toHaveBeenCalledTimes(2);
      expect(secondSocket.sentMessages).toEqual([
        createEventFrame(
          createEvent({
            streamPath: "/demo/ws-reset-pending",
            type: "source",
            payload: { value: 1 },
            offset: 1,
          }),
        ),
        createEventFrame(
          createEvent({
            streamPath: "/demo/ws-reset-pending",
            type: "source",
            payload: { value: 2 },
            offset: 2,
          }),
        ),
      ]);
    } finally {
      openOutboundWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-reset-pending");
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

function createEventFrame(event: Event) {
  return JSON.stringify({
    type: "event",
    event,
  });
}

function createErrorFrame(message: string) {
  return JSON.stringify({
    type: "error",
    message,
  });
}

class FakeWebSocket {
  sentMessages: string[] = [];
  readyState = 1;
  readonly #listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly #throwOnClose: boolean;
  readonly url: string;

  constructor(options: { throwOnClose?: boolean; url: string }) {
    this.#throwOnClose = options.throwOnClose ?? false;
    this.url = options.url;
  }

  send(message: string) {
    this.sentMessages.push(message);
  }

  close() {
    if (this.#throwOnClose) {
      throw new Error("close failed");
    }

    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? []) {
      listener();
    }
  }

  async dispatchMessage(data: unknown) {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data });
    }
    await Promise.resolve();
    await Promise.resolve();
  }

  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
}
