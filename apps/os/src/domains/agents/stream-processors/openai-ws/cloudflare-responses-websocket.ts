import { z } from "zod";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import type { OpenAiResponsesWebSocket } from "./implementation.ts";

const OpenAiResponsesWebSocketUrl = "wss://api.openai.com/v1/responses";
const WebSocketOpenReadyState = 1;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

export async function createOpenAiResponsesWebSocketClient(
  apiKey: string,
): Promise<OpenAiResponsesWebSocket> {
  const response = (await fetch(OpenAiResponsesWebSocketUrl.replace("wss://", "https://"), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "responses_websockets=2026-02-06",
      Upgrade: "websocket",
    },
  })) as Response & { webSocket?: WebSocket | null };

  if (response.webSocket == null) {
    throw new Error(`OpenAI WebSocket upgrade failed with status ${response.status}.`);
  }

  response.webSocket.accept();
  return new CloudflareResponsesWebSocket(response.webSocket);
}

class CloudflareResponsesWebSocket implements OpenAiResponsesWebSocket {
  readonly url = new URL(OpenAiResponsesWebSocketUrl);
  #done = false;
  #messages: JsonValue[] = [];
  #terminalError: unknown;
  #waiters: Array<{
    reject(error: unknown): void;
    resolve(result: IteratorResult<JsonValue>): void;
  }> = [];

  constructor(private readonly socket: WebSocket) {
    this.#bindSocket();
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  sendResponseCreate(event: ResponsesClientEvent): void {
    if (this.socket.readyState !== WebSocketOpenReadyState) {
      throw new Error("OpenAI WebSocket is not open.");
    }
    this.socket.send(JSON.stringify(event));
  }

  messages(): AsyncIterableIterator<JsonValue> {
    return this;
  }

  close(props?: { code: number; reason: string }): void {
    this.socket.close(props?.code, props?.reason);
  }

  #bindSocket() {
    this.socket.addEventListener("message", (event) => {
      this.#handleSocketMessage(event.data);
    });
    this.socket.addEventListener("close", (event) => {
      this.#fail(new Error(`OpenAI WebSocket closed: ${event.code} ${event.reason}`));
    });
    this.socket.addEventListener("error", () => {
      this.#fail(new Error("OpenAI WebSocket errored."));
    });
  }

  #handleSocketMessage(data: unknown) {
    if (typeof data !== "string") {
      this.#fail(new Error("OpenAI WebSocket sent a non-text frame."));
      this.close({ code: 1002, reason: "non-text-frame" });
      return;
    }

    try {
      this.#push(z.json().parse(JSON.parse(data)));
    } catch (error) {
      this.#fail(error);
      this.close({ code: 1002, reason: "invalid-json-frame" });
    }
  }

  async next(): Promise<IteratorResult<JsonValue>> {
    const message = this.#messages.shift();
    if (message != null) return { value: message, done: false };
    if (this.#terminalError != null) throw this.#terminalError;
    if (this.#done) return { value: undefined, done: true };

    return await new Promise((resolve, reject) => {
      this.#waiters.push({ reject, resolve });
    });
  }

  async return(): Promise<IteratorReturnResult<undefined>> {
    this.#done = true;
    this.close({ code: 1000, reason: "iterator-returned" });
    this.#flushWaiters();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<JsonValue> {
    return this;
  }

  #push(message: JsonValue) {
    const waiter = this.#waiters.shift();
    if (waiter != null) {
      waiter.resolve({ value: message, done: false });
      return;
    }

    this.#messages.push(message);
  }

  #fail(error: unknown) {
    if (this.#done) return;
    if (this.#terminalError == null) this.#terminalError = error;
    this.#done = true;
    for (let waiter = this.#waiters.shift(); waiter != null; waiter = this.#waiters.shift()) {
      waiter.reject(this.#terminalError);
    }
  }

  #flushWaiters() {
    for (let waiter = this.#waiters.shift(); waiter != null; waiter = this.#waiters.shift()) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}
