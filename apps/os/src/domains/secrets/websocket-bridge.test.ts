import { describe, expect, test, vi } from "vitest";
import {
  bridgeUpstreamWebSocket,
  isWebSocketUpgrade,
  maybeBridgeWebSocketResponse,
  normalizeWebSocketClose,
} from "./websocket-bridge.ts";

function mockSocket() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const socket = {
    binaryType: "blob" as BinaryType,
    accept: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    }),
    emit(type: string, event: unknown) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  return socket;
}

describe("isWebSocketUpgrade", () => {
  test("matches Upgrade: websocket case-insensitively", () => {
    expect(
      isWebSocketUpgrade(new Request("https://example.com", { headers: { Upgrade: "websocket" } })),
    ).toBe(true);
    expect(
      isWebSocketUpgrade(new Request("https://example.com", { headers: { Upgrade: "WebSocket" } })),
    ).toBe(true);
    expect(isWebSocketUpgrade(new Request("https://example.com"))).toBe(false);
  });
});

describe("maybeBridgeWebSocketResponse", () => {
  test("passes non-upgrade responses through unchanged", () => {
    const request = new Request("https://example.com");
    const response = new Response("ok", { status: 200 });
    expect(maybeBridgeWebSocketResponse(request, response)).toBe(response);
  });

  test("passes upgrade responses without webSocket through unchanged", () => {
    const request = new Request("https://example.com", { headers: { Upgrade: "websocket" } });
    const response = new Response("nope", { status: 400 });
    expect(maybeBridgeWebSocketResponse(request, response)).toBe(response);
  });
});

describe("normalizeWebSocketClose", () => {
  test("forwards normal codes and clamps reserved ones", () => {
    expect(normalizeWebSocketClose(1000, "bye")).toEqual({ code: 1000, reason: "bye" });
    expect(normalizeWebSocketClose(1005, "x")).toEqual({ code: 1000, reason: "x" });
    expect(normalizeWebSocketClose(1006, "")).toEqual({});
    expect(normalizeWebSocketClose(1015, "tls")).toEqual({ code: 1000, reason: "tls" });
    expect(normalizeWebSocketClose(1004, "bad")).toEqual({ code: 1000, reason: "bad" });
  });

  test("truncates long reasons", () => {
    const long = "a".repeat(200);
    expect(normalizeWebSocketClose(1000, long).reason?.length).toBe(123);
  });
});

describe("bridgeUpstreamWebSocket", () => {
  test("accepts both ends with half-open and returns 101 with client socket", () => {
    // In Node vitest, WebSocketPair is not defined — skip unless workerd/global provides it.
    if (typeof WebSocketPair === "undefined") {
      return;
    }

    const upstream = mockSocket() as unknown as WebSocket;
    const response = bridgeUpstreamWebSocket(upstream);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    expect(
      (upstream as unknown as { accept: ReturnType<typeof vi.fn> }).accept,
    ).toHaveBeenCalledWith({ allowHalfOpen: true });
  });
});
