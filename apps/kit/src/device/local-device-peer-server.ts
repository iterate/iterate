import { newWebSocketRpcSession, type RpcStub } from "@iterate-com/capnweb";
import { createWebSocketResponse, WebSocketPair } from "captun";
import type { M5StickS3 } from "./m5sticks3-contract.ts";
import type { LocalDevicePeer } from "./local-device-peer.ts";
import {
  DevicePcmProxy,
  type DevicePcmInputMode,
  type DevicePcmSessionDescriptor,
  type ProviderVoiceEvent,
} from "../voice/device-pcm-proxy.ts";

interface PeerConnection {
  readonly remoteMain: RpcStub<M5StickS3>;
  readonly socket: WebSocket;
}

export interface LocalDevicePeerServerOptions {
  connectVoiceProvider?(session: DevicePcmSessionDescriptor): Promise<WebSocket>;
  onVoiceFailure?(reason: string): void;
  onPcmSessionReady?(session: DevicePcmSessionDescriptor): void;
  onVoiceProviderEvent?(event: ProviderVoiceEvent): void;
  pcmFrameBytes?: number;
  pcmInputMode?: DevicePcmInputMode;
}

export class LocalDevicePeerServer implements Disposable {
  readonly #connections = new Set<PeerConnection>();
  readonly #pcmProxy?: DevicePcmProxy;
  readonly #peer: LocalDevicePeer;
  #disposed = false;

  constructor(peer: LocalDevicePeer, options: LocalDevicePeerServerOptions = {}) {
    this.#peer = peer;
    if (options.connectVoiceProvider) {
      this.#pcmProxy = new DevicePcmProxy({
        authenticate: (projectId, token) =>
          this.#peer.acceptsProjectBearerCredentials(projectId, token),
        connectProvider: options.connectVoiceProvider,
        frameBytes: options.pcmFrameBytes ?? 640,
        onFailure: options.onVoiceFailure,
        onProviderEvent: options.onVoiceProviderEvent,
        onSessionReady: options.onPcmSessionReady,
        resolveSession: () => ({
          id: this.#peer.pcmSessionId,
          inputMode: options.pcmInputMode ?? "server-vad",
        }),
      });
    }
  }

  fetch(request: Request): Response | Promise<Response> {
    if (this.#disposed) {
      return new Response("The local device peer is shutting down.", {
        status: 503,
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return new Response("Method not allowed.", {
          headers: { allow: "GET" },
          status: 405,
        });
      }
      return Response.json({
        mounted: this.#peer.activeMount !== undefined,
        status: "ready",
      });
    }
    if (url.pathname === "/pcm") {
      if (!this.#pcmProxy) {
        return new Response("The PCM proxy is not configured.", {
          status: 503,
        });
      }
      return this.#pcmProxy.fetch(request);
    }
    if (url.pathname !== "/api") {
      return new Response("Not found.", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("This endpoint requires a WebSocket upgrade.", {
        headers: { upgrade: "websocket" },
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const serverSocket = pair[0];
    const clientSocket = pair[1];
    serverSocket.accept();
    const connection: PeerConnection = {
      remoteMain: newWebSocketRpcSession<M5StickS3>(serverSocket, this.#peer.createRpcRoot()),
      socket: serverSocket,
    };
    this.#connections.add(connection);
    serverSocket.addEventListener(
      "close",
      () => {
        this.#connections.delete(connection);
      },
      { once: true },
    );
    return createWebSocketResponse(clientSocket);
  }

  inputStarted() {
    return this.#pcmProxy?.inputStarted(this.#peer.pcmSessionId) ?? Promise.resolve(false);
  }

  inputStopped() {
    return this.#pcmProxy?.inputStopped(this.#peer.pcmSessionId) ?? Promise.resolve(false);
  }

  requestVoiceText(text: string) {
    return (
      this.#pcmProxy?.requestTextResponse(this.#peer.pcmSessionId, text) ?? Promise.resolve(false)
    );
  }

  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pcmProxy?.[Symbol.dispose]();
    for (const connection of this.#connections) {
      connection.remoteMain[Symbol.dispose]();
      connection.socket.close(1000, "Local device peer stopped.");
    }
    this.#connections.clear();
  }
}
