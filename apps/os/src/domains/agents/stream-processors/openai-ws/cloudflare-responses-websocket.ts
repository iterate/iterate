import { z } from "zod";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import type {
  OpenAiResponsesWebSocket,
  OpenAiResponsesWebSocketStreamMessage,
} from "./implementation.ts";

const OpenAiResponsesWebSocketUrl = "wss://api.openai.com/v1/responses";

export function createOpenAiResponsesWebSocketClient(apiKey: string): OpenAiResponsesWebSocket {
  return new CloudflareResponsesWebSocket(apiKey);
}

class CloudflareResponsesWebSocket implements OpenAiResponsesWebSocket {
  readonly url = new URL(OpenAiResponsesWebSocketUrl);
  #done = false;
  #messages: OpenAiResponsesWebSocketStreamMessage[] = [{ type: "connecting" }];
  #waiters: Array<(result: IteratorResult<OpenAiResponsesWebSocketStreamMessage>) => void> = [];
  #readyState = 0;
  #socket: WebSocket | undefined;

  constructor(private readonly apiKey: string) {
    void this.#connect();
  }

  get socket(): { readonly readyState: number } {
    return { readyState: this.#socket?.readyState ?? this.#readyState };
  }

  sendResponseCreate(event: ResponsesClientEvent): void {
    if (this.#socket == null) throw new Error("OpenAI WebSocket is not open.");
    this.#socket.send(JSON.stringify(event));
  }

  stream(): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
    return this;
  }

  close(props?: { code: number; reason: string }): void {
    this.#readyState = 2;
    this.#socket?.close(props?.code, props?.reason);
  }

  async #connect() {
    try {
      const response = (await fetch(this.url.toString().replace("wss://", "https://"), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "responses_websockets=2026-02-06",
          Upgrade: "websocket",
        },
      })) as Response & { webSocket?: WebSocket | null };

      if (response.webSocket == null) {
        throw new Error(`OpenAI WebSocket upgrade failed with status ${response.status}.`);
      }

      this.#socket = response.webSocket;
      this.#socket.accept();
      this.#bindSocket(this.#socket);
      this.#readyState = this.#socket.readyState;
      this.#push({ type: "open" });
    } catch (error) {
      this.#readyState = 3;
      this.#push({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.#push({ type: "close", code: 1006, reason: "OpenAI WebSocket upgrade failed." });
      this.#done = true;
    }
  }

  #bindSocket(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.#handleSocketMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      this.#readyState = 3;
      this.#push({ type: "close", code: event.code, reason: event.reason });
      this.#done = true;
    });
    socket.addEventListener("error", () => {
      this.#push({ type: "error", error: new Error("OpenAI WebSocket errored.") });
    });
  }

  #handleSocketMessage(data: unknown) {
    if (typeof data !== "string") {
      this.#push({ type: "raw", data });
      return;
    }

    try {
      this.#push({ type: "message", message: z.json().parse(JSON.parse(data)) });
    } catch {
      this.#push({ type: "raw", data });
    }
  }

  async next(): Promise<IteratorResult<OpenAiResponsesWebSocketStreamMessage>> {
    const message = this.#messages.shift();
    if (message != null) return { value: message, done: false };
    if (this.#done) return { value: undefined, done: true };

    return await new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  async return(): Promise<IteratorReturnResult<undefined>> {
    this.#done = true;
    this.#flushWaiters();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
    return this;
  }

  #push(message: OpenAiResponsesWebSocketStreamMessage) {
    const waiter = this.#waiters.shift();
    if (waiter != null) {
      waiter({ value: message, done: false });
      return;
    }

    this.#messages.push(message);
  }

  #flushWaiters() {
    for (let waiter = this.#waiters.shift(); waiter != null; waiter = this.#waiters.shift()) {
      waiter({ value: undefined, done: true });
    }
  }
}
