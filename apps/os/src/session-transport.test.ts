import { afterEach, describe, expect, it, vi } from "vitest";
import { createItxWebSocketTransport, isItxClientDisconnectedError } from "./session-transport.ts";

class TestWebSocket extends EventTarget {
  binaryType = "";
  closeCalls: { code?: number; reason?: string }[] = [];
  readyState = 1;
  sent: string[] = [];

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  disconnectFromPeer(): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "peer gone" }));
  }

  send(message: string): void {
    this.sent.push(message);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createItxWebSocketTransport", () => {
  it("turns an outer peer close into the owned client-disconnected outcome", async () => {
    vi.stubGlobal("WebSocket", { CONNECTING: 0 });
    const socket = new TestWebSocket();
    const transport = createItxWebSocketTransport(socket as unknown as WebSocket);
    const receive = transport.receive();

    socket.disconnectFromPeer();

    await expect(receive).rejects.toSatisfy(isItxClientDisconnectedError);
  });

  it("preserves an application abort when its close event follows", async () => {
    vi.stubGlobal("WebSocket", { CONNECTING: 0 });
    const socket = new TestWebSocket();
    const transport = createItxWebSocketTransport(socket as unknown as WebSocket);
    const applicationError = new Error("application failed");

    transport.abort?.(applicationError);
    socket.disconnectFromPeer();

    await expect(transport.receive()).rejects.toBe(applicationError);
    expect(socket.closeCalls).toEqual([{ code: 3000, reason: "application failed" }]);
  });
});
