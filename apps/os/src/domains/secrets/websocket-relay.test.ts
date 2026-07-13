import { describe, expect, test, vi } from "vitest";
import {
  buildIdentifyFrame,
  createUpstreamMessageBuffer,
  encodeSecretWebSocketRelayRequest,
  injectTokenPlaceholder,
  isSecretWebSocketRelayRequest,
  messageDataToText,
  parseSecretWebSocketRelayRequest,
  SECRET_WS_RELAY_FETCH_URL,
  waitForJsonOp,
} from "./websocket-relay.ts";

function mockSocket() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const socket = {
    readyState: 1 as number,
    accept: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      listeners.get(type)?.delete(handler);
    }),
    emit(type: string, event: unknown) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
  };
  return socket;
}

describe("injectTokenPlaceholder", () => {
  test("replaces $token leaves deeply", () => {
    expect(
      injectTokenPlaceholder(
        { op: "identify", token: "$token", nested: { a: "$token", b: 1 } },
        "sekrit",
      ),
    ).toEqual({ op: "identify", token: "sekrit", nested: { a: "sekrit", b: 1 } });
  });

  test("leaves other strings alone", () => {
    expect(injectTokenPlaceholder({ op: "identify", token: "literal" }, "sekrit")).toEqual({
      op: "identify",
      token: "literal",
    });
  });
});

describe("buildIdentifyFrame", () => {
  test("defaults to Discord/petshop identify shape", () => {
    expect(JSON.parse(buildIdentifyFrame("tok-1"))).toEqual({
      op: "identify",
      token: "tok-1",
    });
  });

  test("honors custom frame template", () => {
    expect(
      JSON.parse(
        buildIdentifyFrame("tok-2", { op: "identify", d: { token: "$token", intents: 0 } }),
      ),
    ).toEqual({ op: "identify", d: { token: "tok-2", intents: 0 } });
  });
});

describe("messageDataToText", () => {
  test("handles string and ArrayBuffer", () => {
    expect(messageDataToText("hi")).toBe("hi");
    expect(messageDataToText(new TextEncoder().encode("ab").buffer)).toBe("ab");
  });
});

describe("encode/parse secret websocket relay request", () => {
  test("round-trips input over the internal fetch URL", async () => {
    const request = encodeSecretWebSocketRelayRequest({
      url: "wss://gateway.example/gateway",
      identify: { waitForOp: "hello", tokenField: "token" },
      timeoutMs: 5_000,
    });
    expect(isSecretWebSocketRelayRequest(request)).toBe(true);
    expect(request.url).toBe(SECRET_WS_RELAY_FETCH_URL);
    await expect(parseSecretWebSocketRelayRequest(request)).resolves.toEqual({
      url: "wss://gateway.example/gateway",
      identify: { waitForOp: "hello", tokenField: "token" },
      timeoutMs: 5_000,
    });
  });

  test("rejects ordinary secret fetch URLs", () => {
    expect(isSecretWebSocketRelayRequest(new Request("https://api.openai.com/v1/realtime"))).toBe(
      false,
    );
  });
});

describe("createUpstreamMessageBuffer + waitForJsonOp", () => {
  test("consumes hello and leaves later frames for the client flush", async () => {
    const socket = mockSocket();
    const buffer = createUpstreamMessageBuffer();
    buffer.attach(socket as unknown as WebSocket);

    // Pre-arrive hello + ready before waitForJsonOp (simulates race with audit gap).
    socket.emit("message", { data: JSON.stringify({ op: "hello", d: { heartbeat: 1 } }) });
    socket.emit("message", { data: JSON.stringify({ op: "ready", user: "u1" }) });

    const hello = await waitForJsonOp(socket as unknown as WebSocket, "hello", 1000, buffer);
    expect(hello).toEqual({ op: "hello", d: { heartbeat: 1 } });
    // Hello consumed; ready stays for pair-bridge pendingUpstreamMessages.
    expect(buffer.frames.map((f) => JSON.parse(String(f)))).toEqual([{ op: "ready", user: "u1" }]);
  });

  test("waits for hello that arrives after attach", async () => {
    const socket = mockSocket();
    const buffer = createUpstreamMessageBuffer();
    buffer.attach(socket as unknown as WebSocket);

    const pending = waitForJsonOp(socket as unknown as WebSocket, "hello", 1000, buffer);
    queueMicrotask(() => {
      socket.emit("message", { data: JSON.stringify({ op: "noise" }) });
      socket.emit("message", { data: JSON.stringify({ op: "hello" }) });
      socket.emit("message", { data: JSON.stringify({ op: "ready" }) });
    });

    await expect(pending).resolves.toEqual({ op: "hello" });
    expect(buffer.frames.map((f) => JSON.parse(String(f)))).toEqual([{ op: "ready" }]);
  });
});
