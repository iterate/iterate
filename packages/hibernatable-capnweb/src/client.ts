import { newWebSocketRpcSession, type RpcStub, type RpcTarget } from "capnweb";
import { globalWebSocket, type SocketOpener, type WebSocketLike } from "./adapters.ts";
import * as P from "./protocol.ts";
import { disposeStub, dupStub } from "./stub.ts";

const WEB_SOCKET_OPEN = 1;

export interface HibernatableCapnwebClientOptions<Local extends RpcTarget = RpcTarget> {
  path?: string;
  main: () => Local;
  id?: string;
  meta?: Record<string, unknown>;
  open?: SocketOpener;
  idleMs?: number;
  heartbeatMs?: number;
  reconnectBaseMs?: number;
}

export class HibernatableCapnwebClient<
  Remote extends RpcTarget = RpcTarget,
  Local extends RpcTarget = RpcTarget,
> {
  #control: WebSocketLike | undefined;
  #rpc: WebSocketLike | undefined;
  #remote: RpcStub<Remote> | undefined;
  #connecting: Promise<RpcStub<Remote>> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #backoff: number;
  #stopped = false;

  readonly #id: string;
  readonly #controlUrl: string;
  readonly #rpcUrl: string;
  readonly #open: SocketOpener;
  readonly #main: () => Local;
  readonly #idleMs: number;
  readonly #heartbeatMs: number;

  constructor(baseUrl: string, opts: HibernatableCapnwebClientOptions<Local>) {
    this.#open = opts.open ?? globalWebSocket;
    this.#main = opts.main;
    this.#id = opts.id ?? crypto.randomUUID();
    this.#idleMs = opts.idleMs ?? 30_000;
    this.#heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.#backoff = opts.reconnectBaseMs ?? 1_000;

    const path = opts.path ?? P.DEFAULT_PATH;
    const base = baseUrl.replace(/\/+$/, "");
    const id = encodeURIComponent(this.#id);
    const meta = opts.meta ? `&m=${encodeURIComponent(JSON.stringify(opts.meta))}` : "";
    this.#controlUrl = `${base}${P.controlPath(path)}?i=${id}${meta}`;
    this.#rpcUrl = `${base}${path}?i=${id}`;
  }

  get id() {
    return this.#id;
  }

  get connected() {
    return this.#remote !== undefined;
  }

  start(): void {
    this.#stopped = false;
    void this.#connectControl();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearHeartbeat();
    if (this.#idle) clearTimeout(this.#idle);
    try {
      this.#rpc?.close(1000, "stop");
    } catch {}
    try {
      this.#control?.close(1000, "stop");
    } catch {}
    this.#dropRpc();
  }

  async connect(): Promise<RpcStub<Remote>> {
    const remote = await this.#ensureRpc();
    this.#bumpIdle();
    return dupStub(remote);
  }

  async #connectControl(): Promise<void> {
    if (this.#stopped) return;
    let webSocket: WebSocketLike;
    try {
      webSocket = await this.#open(this.#controlUrl);
    } catch {
      this.#reconnect();
      return;
    }
    this.#control = webSocket;

    const onOpen = () => {
      this.#backoff = 1_000;
      this.#clearHeartbeat();
      if (this.#heartbeatMs <= 0) return;
      this.#heartbeat = setInterval(() => {
        try {
          if (webSocket.readyState === WEB_SOCKET_OPEN) webSocket.send(P.PING);
        } catch {}
      }, this.#heartbeatMs);
    };
    if (webSocket.readyState === WEB_SOCKET_OPEN) onOpen();
    else webSocket.addEventListener("open", onOpen, { once: true });

    webSocket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (P.readSignal(data) === this.#id) void this.#ensureRpc().catch(() => {});
    });
    webSocket.addEventListener("close", () => {
      this.#clearHeartbeat();
      this.#reconnect();
    });
    webSocket.addEventListener("error", () => {
      try {
        webSocket.close();
      } catch {}
    });
  }

  #reconnect(): void {
    if (this.#stopped) return;
    setTimeout(() => void this.#connectControl(), this.#backoff);
    this.#backoff = Math.min(this.#backoff * 2, 30_000);
  }

  #ensureRpc(): Promise<RpcStub<Remote>> {
    if (this.#remote) return Promise.resolve(this.#remote);
    if (this.#connecting) return this.#connecting;

    this.#connecting = (async () => {
      const webSocket = await this.#open(this.#rpcUrl);
      this.#rpc = webSocket;
      const remote = newWebSocketRpcSession<Remote>(
        webSocket as unknown as WebSocket,
        this.#main() as RpcTarget,
      );
      webSocket.addEventListener("message", () => this.#bumpIdle());
      webSocket.addEventListener("close", () => this.#dropRpc());
      webSocket.addEventListener("error", () => {
        try {
          webSocket.close();
        } catch {}
      });
      this.#remote = remote;
      this.#connecting = undefined;
      this.#bumpIdle();
      return remote;
    })().catch((error) => {
      this.#connecting = undefined;
      throw error;
    });

    return this.#connecting;
  }

  #bumpIdle(): void {
    if (this.#idleMs <= 0) return;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      try {
        this.#rpc?.close(1000, "idle");
      } catch {}
    }, this.#idleMs);
  }

  #dropRpc(): void {
    if (this.#idle) {
      clearTimeout(this.#idle);
      this.#idle = undefined;
    }
    disposeStub(this.#remote);
    this.#remote = undefined;
    this.#rpc = undefined;
    this.#connecting = undefined;
  }

  #clearHeartbeat(): void {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }
}
