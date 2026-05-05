import OpenAI from "openai";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import { ResponsesWSBase } from "openai/resources/responses/ws-base";
import { z } from "zod";
import { parseAppConfig } from "@iterate-com/shared/apps/config";
import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { OpenAiWsProcessorContract } from "@iterate-com/shared/stream-processors/openai-ws/contract";
import {
  createOpenAiWsProcessor,
  type OpenAiResponsesWebSocket,
  type OpenAiResponsesWebSocketStreamMessage,
} from "@iterate-com/shared/stream-processors/openai-ws/implementation";
import {
  createStreamProcessorRunnerDurableObject,
  type StreamProcessorRunnerInit,
} from "./stream-processor-runner-common.ts";
import { AppConfig } from "~/app.ts";

export type OpenAiWsStreamProcessorRunnerInit = StreamProcessorRunnerInit;

const OpenAiWsStreamProcessorRunnerBase = createStreamProcessorRunnerDurableObject({
  className: "OpenAiWsStreamProcessorRunner",
  processor(args) {
    const appConfig = parseAppConfig(AppConfig, args.env.APP_CONFIG);
    const apiKey = appConfig.openAiApiKey?.exposeSecret();

    return createOpenAiWsProcessor({
      /**
       * This intentionally goes through OpenAI's official Responses WebSocket
       * SDK base class rather than hand-encoding auth, URLs, send queues, or
       * server event parsing in the shared processor.
       *
       * The public `ResponsesWS` class from `openai/resources/responses/ws`
       * targets Node and the `ws` package. A Cloudflare Worker cannot use that
       * Node socket, and a native `new WebSocket(url)` cannot attach the
       * Authorization/OpenAI-Beta headers this endpoint needs. The small
       * adapter below gives `ResponsesWSBase` the socket shape it expects while
       * opening the actual Worker WebSocket through Cloudflare's documented
       * `fetch(..., { headers: { Upgrade: "websocket" } })` path.
       *
       * https://developers.openai.com/api/docs/guides/websocket-mode
       * https://developers.cloudflare.com/workers/examples/websockets/
       */
      async openResponsesWebSocket() {
        if (apiKey == null) {
          throw new Error("OpenAI WebSocket processor requires AppConfig.openAiApiKey.");
        }

        return createOpenAiResponsesWebSocketClient(new OpenAI({ apiKey }));
      },
    });
  },
});

export type OpenAiWsStreamProcessorRunnerState = StreamProcessorRunnerState<
  typeof OpenAiWsProcessorContract
>;

export class OpenAiWsStreamProcessorRunner extends OpenAiWsStreamProcessorRunnerBase {}

type CloudflareSocketEventName = "open" | "message" | "close" | "error" | string;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

function createOpenAiResponsesWebSocketClient(client: OpenAI): OpenAiResponsesWebSocket {
  const sdkWebSocket = new CloudflareResponsesWebSocket(client);

  return {
    get url() {
      return sdkWebSocket.url;
    },
    get socket() {
      return sdkWebSocket.socket;
    },
    send(event) {
      // The shared processor emits generic JSON so it does not depend on the
      // OpenAI package. This Worker boundary is the one place we assert that
      // the JSON is the SDK's generated `ResponsesClientEvent`; today the only
      // outbound event the shared processor builds is `response.create`.
      sdkWebSocket.send(event as unknown as ResponsesClientEvent);
    },
    stream() {
      return streamOpenAiResponsesWebSocket(sdkWebSocket);
    },
    close(props) {
      sdkWebSocket.close(props);
    },
  };
}

async function* streamOpenAiResponsesWebSocket(
  sdkWebSocket: CloudflareResponsesWebSocket,
): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
  for await (const event of sdkWebSocket.stream()) {
    switch (event.type) {
      case "connecting":
      case "open":
      case "closing":
      case "reconnected":
        yield { type: event.type };
        break;
      case "close":
        yield { type: "close", code: event.code, reason: event.reason };
        break;
      case "reconnecting":
        yield { type: "reconnecting", reconnect: toJsonValue(event.reconnect) };
        break;
      case "message":
        yield { type: "message", message: toJsonValue(event.message) };
        break;
      case "raw":
        yield { type: "raw", data: event.data };
        break;
      case "error":
        yield { type: "error", error: event.error };
        break;
      default:
        event satisfies never;
    }
  }
}

function toJsonValue(value: unknown): JsonValue {
  return z.json().parse(value);
}

class CloudflareResponsesWebSocket extends ResponsesWSBase<CloudflareFetchWebSocket> {
  constructor(client: OpenAI) {
    super(client, { reconnect: null });
    this._connectInitial();
  }

  protected _createSocket(url: URL, authHeaders: Record<string, string>): CloudflareFetchWebSocket {
    return new CloudflareFetchWebSocket(url, {
      ...authHeaders,
      "OpenAI-Beta": "responses_websockets=2026-02-06",
    });
  }
}

class CloudflareFetchWebSocket {
  #listeners = new Map<CloudflareSocketEventName, Set<unknown>>();
  #readyState = 0;
  #socket: WebSocket | undefined;

  constructor(
    private readonly url: URL,
    private readonly authHeaders: Record<string, string>,
  ) {
    void this.#connect();
  }

  get readyState(): number {
    return this.#socket?.readyState ?? this.#readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.#socket == null) throw new Error("OpenAI WebSocket is not open.");
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#readyState = 2;
    this.#socket?.close(code, reason);
  }

  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  on(event: CloudflareSocketEventName, listener: unknown): void {
    this.#listenersFor(event).add(listener);
  }

  off(event: "open", listener: () => void): void;
  off(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  off(event: "close", listener: (code: number, reason: string) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  off(event: CloudflareSocketEventName, listener: unknown): void {
    this.#listeners.get(event)?.delete(listener);
  }

  once(event: "open", listener: () => void): void;
  once(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  once(event: "close", listener: (code: number, reason: string) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  once(event: CloudflareSocketEventName, listener: unknown): void {
    const onceListener = (...args: never[]) => {
      this.off(event, onceListener);
      (listener as (...args: never[]) => void)(...args);
    };
    this.on(event, onceListener);
  }

  async #connect() {
    try {
      const response = (await fetch(this.url.toString().replace("wss://", "https://"), {
        headers: {
          ...this.authHeaders,
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
      this.#emit("open");
    } catch (error) {
      this.#readyState = 3;
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      this.#emit("close", 1006, "OpenAI WebSocket upgrade failed.");
    }
  }

  #bindSocket(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.#emit("message", event.data, event.data instanceof ArrayBuffer);
    });
    socket.addEventListener("close", (event) => {
      this.#readyState = 3;
      this.#emit("close", event.code, event.reason);
    });
    socket.addEventListener("error", () => {
      this.#emit("error", new Error("OpenAI WebSocket errored."));
    });
  }

  #listenersFor(event: CloudflareSocketEventName): Set<unknown> {
    const existing = this.#listeners.get(event);
    if (existing != null) return existing;

    const listeners = new Set<unknown>();
    this.#listeners.set(event, listeners);
    return listeners;
  }

  #emit(event: CloudflareSocketEventName, ...args: unknown[]) {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (...args: unknown[]) => void)(...args);
    }
  }
}
