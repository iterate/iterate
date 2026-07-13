import { describe, expect, test, vi } from "vitest";
import {
  bridgeUpstreamWebSocket,
  computeSecWebSocketAccept,
  isWebSocketUpgrade,
  maybeBridgeWebSocketResponse,
  normalizeWebSocketClose,
  withWebSocketHandshakeHeaders,
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
  test("passes non-upgrade responses through unchanged", async () => {
    const request = new Request("https://example.com");
    const response = new Response("ok", { status: 200 });
    expect(await maybeBridgeWebSocketResponse(request, response)).toBe(response);
  });

  test("passes upgrade responses without webSocket through unchanged", async () => {
    const request = new Request("https://example.com", { headers: { Upgrade: "websocket" } });
    const response = new Response("nope", { status: 400 });
    expect(await maybeBridgeWebSocketResponse(request, response)).toBe(response);
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

describe("computeSecWebSocketAccept", () => {
  test("matches RFC 6455 example key", async () => {
    // RFC 6455 §1.3 / §4.2.2 example.
    await expect(computeSecWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).resolves.toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });
});

describe("withWebSocketHandshakeHeaders", () => {
  test("stamps Accept for the caller key and strips hop-by-hop duplicates", async () => {
    if (typeof WebSocketPair === "undefined") return;

    const pair = new WebSocketPair();
    const request = new Request("https://example.com/ws", {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    // Upstream Accept is for a different key — must be replaced; Upgrade/
    // Connection are stripped so intercept can inject them once.
    const source = new Response(null, {
      status: 101,
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Accept": "wrong-accept-for-upstream-key",
      },
      webSocket: pair[0],
    });

    const stamped = await withWebSocketHandshakeHeaders(request, source);
    expect(stamped.status).toBe(101);
    expect(stamped.headers.get("Upgrade")).toBeNull();
    expect(stamped.headers.get("Connection")).toBeNull();
    expect(stamped.headers.get("Sec-WebSocket-Accept")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(stamped.webSocket).toBeTruthy();
  });

  test("leaves non-websocket responses alone", async () => {
    const request = new Request("https://example.com");
    const response = new Response("ok");
    expect(await withWebSocketHandshakeHeaders(request, response)).toBe(response);
  });
});

describe("bridgeUpstreamWebSocket", () => {
  test("accepts both ends with half-open and returns 101 with client socket", async () => {
    // In Node vitest, WebSocketPair is not defined — skip unless workerd/global provides it.
    if (typeof WebSocketPair === "undefined") {
      return;
    }

    const upstream = mockSocket() as unknown as WebSocket;
    const response = await bridgeUpstreamWebSocket(upstream, undefined, {
      clientRequest: new Request("https://example.com", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      }),
    });
    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    // Hop-by-hop Upgrade/Connection left for intercept to inject once.
    expect(response.headers.get("Upgrade")).toBeNull();
    expect(response.headers.get("Connection")).toBeNull();
    expect(response.headers.get("Sec-WebSocket-Accept")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(
      (upstream as unknown as { accept: ReturnType<typeof vi.fn> }).accept,
    ).toHaveBeenCalledWith({ allowHalfOpen: true });
  });

  test("skips upstream accept when already accepted (relay path)", async () => {
    if (typeof WebSocketPair === "undefined") {
      return;
    }

    const upstream = mockSocket() as unknown as WebSocket;
    const response = await bridgeUpstreamWebSocket(upstream, undefined, {
      upstreamAlreadyAccepted: true,
    });
    expect(response.status).toBe(101);
    expect(
      (upstream as unknown as { accept: ReturnType<typeof vi.fn> }).accept,
    ).not.toHaveBeenCalled();
  });
});
