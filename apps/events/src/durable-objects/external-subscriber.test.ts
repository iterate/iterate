import { describe, expect, test, vi } from "vitest";
import type {
  Event,
  ExternalSubscriber,
  StreamSubscriptionConfiguredEvent,
} from "@iterate-com/events-contract";
import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";

const { connectCallableWebSocketMock, dispatchCallableMock } = vi.hoisted(() => ({
  connectCallableWebSocketMock:
    vi.fn<(options: { callable: unknown; ctx: unknown }) => Promise<WebSocket>>(),
  dispatchCallableMock:
    vi.fn<(options: { callable: unknown; payload: unknown; ctx: unknown }) => Promise<unknown>>(),
}));
vi.mock("@iterate-com/shared/callable/runtime.ts", () => ({
  connectCallableWebSocket: connectCallableWebSocketMock,
  dispatchCallable: dispatchCallableMock,
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
        callable: fetchCallable("http://localhost:8788/after-event-handler?streamPath=%2Fdemo"),
      }),
    });
    const state3 = externalSubscriberProcessor.reduce!({
      state: state2,
      event: createConfiguredEvent({
        slug: "audit",
        type: "webhook",
        callable: fetchCallable("https://example.com/hook"),
        jsonataFilter: "type = 'source'",
      }),
    });
    const state4 = externalSubscriberProcessor.reduce!({
      state: state3,
      event: createConfiguredEvent({
        slug: "audit",
        type: "webhook",
        callable: fetchCallable("https://example.com/hook-2"),
        jsonataTransform: '{"copied":payload.value}',
      }),
    });

    expect(state4).toEqual({
      subscribersBySlug: {
        "processor:ping-pong": {
          slug: "processor:ping-pong",
          type: "websocket",
          callable: fetchCallable("http://localhost:8788/after-event-handler?streamPath=%2Fdemo"),
        },
        audit: {
          slug: "audit",
          type: "webhook",
          callable: fetchCallable("https://example.com/hook-2"),
          jsonataTransform: '{"copied":payload.value}',
        },
      },
    });
  });

  test("afterAppend sends framed event messages to websocket subscribers by default", async () => {
    const socket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-raw",
    });
    connectCallableWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);

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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-raw",
              ),
            },
          },
        },
      });

      expect(connectCallableWebSocketMock).toHaveBeenCalledWith({
        callable: fetchCallable(
          "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-raw",
        ),
        ctx: expect.objectContaining({ fetch: expect.any(Function) }),
      });
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
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-raw");
    }
  });

  test("afterAppend canonicalizes framed websocket events and ignores websocket transforms", async () => {
    const socket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-canonical",
    });
    connectCallableWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-canonical",
              ),
              jsonataTransform: '{"kind":"transformed"}',
            },
          },
        },
      });

      expect(connectCallableWebSocketMock).toHaveBeenCalledWith({
        callable: fetchCallable(
          "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-canonical",
        ),
        ctx: expect.objectContaining({ fetch: expect.any(Function) }),
      });
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
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-canonical");
    }
  });

  test("afterAppend reconnects when a subscriber callable changes", async () => {
    const staleSocket = new FakeWebSocket({
      throwOnClose: true,
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
    });
    const nextSocket = new FakeWebSocket({
      url: "http://localhost:9898/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
    });
    connectCallableWebSocketMock
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
              ),
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
              callable: fetchCallable(
                "http://localhost:9898/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
              ),
            },
          },
        },
      });

      expect(connectCallableWebSocketMock.mock.calls.map(([options]) => options.callable)).toEqual([
        fetchCallable(
          "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
        ),
        fetchCallable(
          "http://localhost:9898/after-event-handler?streamPath=%2Fdemo%2Fws-reconnect",
        ),
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
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-reconnect");
    }
  });

  test("afterAppend fire-and-forget posts transformed webhook payloads when filter matches", async () => {
    dispatchCallableMock.mockResolvedValueOnce(null);

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
              callable: fetchCallable("https://example.com/hook"),
              jsonataFilter: "type = 'source'",
              jsonataTransform: '{"kind":"hook","copied":payload.value}',
            },
          },
        },
      });

      expect(dispatchCallableMock).toHaveBeenCalledWith({
        callable: fetchCallable("https://example.com/hook"),
        payload: {
          kind: "hook",
          copied: 42,
        },
        ctx: expect.objectContaining({ fetch: expect.any(Function) }),
      });
    } finally {
      dispatchCallableMock.mockReset();
    }
  });

  test("afterAppend does not deliver subscription-configured events to webhook subscribers by default", async () => {
    try {
      await externalSubscriberProcessor.afterAppend?.({
        append: () => createEvent(),
        event: createConfiguredEvent({
          slug: "audit",
          type: "webhook",
          callable: fetchCallable("https://example.com/hook"),
        }),
        state: {
          subscribersBySlug: {
            audit: {
              slug: "audit",
              type: "webhook",
              callable: fetchCallable("https://example.com/hook"),
            },
          },
        },
      });

      expect(dispatchCallableMock).not.toHaveBeenCalled();
    } finally {
      dispatchCallableMock.mockReset();
    }
  });

  test("afterAppend skips subscribers whose filter does not match", async () => {
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
              callable: fetchCallable("https://example.com/hook"),
              jsonataFilter: "type = 'source'",
            },
          },
        },
      });

      expect(dispatchCallableMock).not.toHaveBeenCalled();
    } finally {
      dispatchCallableMock.mockReset();
    }
  });

  test("afterAppend logs and skips invalid transform output", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

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
              callable: fetchCallable("https://example.com/hook"),
              jsonataTransform: "$nonexistent",
            },
          },
        },
      });

      expect(dispatchCallableMock).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[stream-do] external subscriber transform produced invalid JSON",
        expect.objectContaining({
          subscriberSlug: "audit",
          subscriberCallable: JSON.stringify(fetchCallable("https://example.com/hook")),
        }),
      );
    } finally {
      consoleError.mockRestore();
      dispatchCallableMock.mockReset();
    }
  });

  test("websocket append frames append into the same stream", async () => {
    const socket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append",
    });
    connectCallableWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append",
              ),
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
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-append");
    }
  });

  test("websocket append failures produce error frames", async () => {
    const socket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append-error",
    });
    connectCallableWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-append-error",
              ),
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
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-append-error");
    }
  });

  test("unknown websocket JSON shapes are ignored (no error frame)", async () => {
    const socket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-invalid-frame",
    });
    connectCallableWebSocketMock.mockResolvedValueOnce(socket as unknown as WebSocket);

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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-invalid-frame",
              ),
            },
          },
        },
      });

      const afterOutboundEvent = [...socket.sentMessages];
      await socket.dispatchMessage(JSON.stringify({ type: "wat" }));

      expect(socket.sentMessages).toEqual(afterOutboundEvent);
    } finally {
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-invalid-frame");
    }
  });

  test("resetSubscriberSocketsForStream clears cached websocket connections for the stream", async () => {
    const firstSocket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
    });
    const secondSocket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
    });
    connectCallableWebSocketMock
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
              ),
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset",
              ),
            },
          },
        },
      });

      expect(connectCallableWebSocketMock).toHaveBeenCalledTimes(2);
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
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-reset");
    }
  });

  test("resetSubscriberSocketsForStream invalidates in-flight websocket connects for the stream", async () => {
    const firstSocket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
    });
    const secondSocket = new FakeWebSocket({
      url: "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
    });
    const firstConnect = Promise.withResolvers<WebSocket>();
    connectCallableWebSocketMock
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
              ),
            },
          },
        },
      });

      while (connectCallableWebSocketMock.mock.calls.length === 0) {
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
              callable: fetchCallable(
                "http://localhost:8788/after-event-handler?streamPath=%2Fdemo%2Fws-reset-pending",
              ),
            },
          },
        },
      });

      expect(connectCallableWebSocketMock).toHaveBeenCalledTimes(2);
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
      connectCallableWebSocketMock.mockReset();
      resetSubscriberSocketsForStream("/demo/ws-reset-pending");
    }
  });
});

function createConfiguredEvent(payload: ExternalSubscriber): StreamSubscriptionConfiguredEvent {
  return createEvent({
    type: "events.iterate.com/core/subscription-configured",
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

function fetchCallable(url: string): FetchCallable {
  return {
    type: "fetch",
    via: { type: "url", url },
  };
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
