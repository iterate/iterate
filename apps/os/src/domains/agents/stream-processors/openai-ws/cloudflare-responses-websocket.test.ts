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

    const client = await createOpenAiResponsesWebSocketClient("sk-test");

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

  it("streams parsed messages and fails the iterator when the socket closes", async () => {
    const socket = new FakeCloudflareWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 101, webSocket: socket })),
    );

    const stream = (await createOpenAiResponsesWebSocketClient("sk-test")).messages();

    socket.receive(JSON.stringify({ response: { id: "resp_1" }, type: "response.completed" }));
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { response: { id: "resp_1" }, type: "response.completed" },
    });

    socket.close(1000, "done");
    await expect(stream.next()).rejects.toThrow("OpenAI WebSocket closed: 1000 done");
  });

  it("fails to connect when the upgrade returns no websocket", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 426, webSocket: null })),
    );

    await expect(createOpenAiResponsesWebSocketClient("sk-test")).rejects.toThrow(
      "OpenAI WebSocket upgrade failed with status 426.",
    );
  });

  it("fails the iterator for non-json frames", async () => {
    const socket = new FakeCloudflareWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 101, webSocket: socket })),
    );

    const stream = (await createOpenAiResponsesWebSocketClient("sk-test")).messages();
    socket.receive("not json");
    await expect(stream.next()).rejects.toThrow();
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
