import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiResponsesWebSocketClient } from "./cloudflare-responses-websocket.ts";

describe("createOpenAiResponsesWebSocketClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the Responses WebSocket with auth headers and sends JSON frames", async () => {
    const socket = new FakeCloudflareWebSocket();
    const fetch = vi.fn(async () => ({ status: 101, webSocket: socket }));
    vi.stubGlobal("fetch", fetch);

    const client = createOpenAiResponsesWebSocketClient("sk-test");
    const stream = client.stream();

    await expect(stream.next()).resolves.toEqual({ done: false, value: { type: "connecting" } });
    await expect(stream.next()).resolves.toEqual({ done: false, value: { type: "open" } });

    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/responses", {
      headers: {
        Authorization: "Bearer sk-test",
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        Upgrade: "websocket",
      },
    });

    client.sendResponseCreate({ type: "response.create", model: "gpt-5.5" });

    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "response.create", model: "gpt-5.5" },
    ]);
  });

  it("streams parsed messages, raw frames, and close events", async () => {
    const socket = new FakeCloudflareWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 101, webSocket: socket })),
    );

    const stream = createOpenAiResponsesWebSocketClient("sk-test").stream();
    await stream.next();
    await stream.next();

    socket.receive(JSON.stringify({ response: { id: "resp_1" }, type: "response.completed" }));
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: {
        message: { response: { id: "resp_1" }, type: "response.completed" },
        type: "message",
      },
    });

    socket.receive("not json");
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { data: "not json", type: "raw" },
    });

    socket.close(1000, "done");
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { code: 1000, reason: "done", type: "close" },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });
});

class FakeCloudflareWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  #listeners = new Map<
    string,
    Set<(event: { code: number; data: unknown; reason: string }) => void>
  >();

  accept(): void {
    this.readyState = 1;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.#emit("close", { code, data: undefined, reason });
  }

  receive(data: unknown): void {
    this.#emit("message", { code: 0, data, reason: "" });
  }

  addEventListener(
    type: string,
    listener: (event: { code: number; data: unknown; reason: string }) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  #emit(type: string, event: { code: number; data: unknown; reason: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
