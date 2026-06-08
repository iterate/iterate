/// <reference types="@cloudflare/workers-types" />

import { newWebSocketRpcSession, type RpcStub, type RpcTarget } from "capnweb";
import * as P from "./protocol.ts";
import { disposeStub, dupStub } from "./stub.ts";

export interface Connection<Remote extends RpcTarget = RpcTarget> {
  readonly id: string;
  readonly meta: unknown;
  readonly live: boolean;
  signal(): void;
  withRemote<T>(fn: (remote: RpcStub<Remote>) => T | Promise<T>): Promise<T>;
  close(): void;
}

export interface HibernatableCapnwebHostOptions<Local extends RpcTarget = RpcTarget> {
  path?: string;
  main?: (request: Request, id: string) => Local | null;
  teardown?: "idle" | "immediate" | "peer";
  idleMs?: number;
  connectTimeoutMs?: number;
}

type Live<Remote extends RpcTarget> = {
  remote: RpcStub<Remote>;
  webSocket: WebSocket;
  active: number;
  idle: ReturnType<typeof setTimeout> | undefined;
};

type Pending<Remote extends RpcTarget> = {
  promise: Promise<RpcStub<Remote>>;
  resolve: (stub: RpcStub<Remote>) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class HibernatableCapnwebHost<
  Remote extends RpcTarget = RpcTarget,
  Local extends RpcTarget = RpcTarget,
> {
  readonly #live = new Map<string, Live<Remote>>();
  readonly #pending = new Map<string, Pending<Remote>>();

  readonly #path: string;
  readonly #control: string;
  readonly #tag: string;
  readonly #main: (request: Request, id: string) => Local | null;
  readonly #teardown: "idle" | "immediate" | "peer";
  readonly #idleMs: number;
  readonly #connectTimeoutMs: number;

  constructor(
    private readonly ctx: DurableObjectState,
    opts: HibernatableCapnwebHostOptions<Local> = {},
  ) {
    this.#path = opts.path ?? P.DEFAULT_PATH;
    this.#control = P.controlPath(this.#path);
    this.#tag = P.controlTag(this.#path);
    this.#main = opts.main ?? (() => null);
    this.#teardown = opts.teardown ?? "idle";
    this.#idleMs = opts.idleMs ?? 10_000;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(P.PING, P.PONG));
  }

  handle(request: Request): Response | null {
    const url = new URL(request.url);
    if (url.pathname === this.#path) return this.#acceptRpc(request, url);
    if (url.pathname === this.#control) return this.#acceptControl(url);
    return null;
  }

  message(webSocket: WebSocket, _data?: string | ArrayBuffer): boolean {
    return this.#owns(webSocket);
  }

  closed(webSocket: WebSocket): boolean {
    if (!this.#owns(webSocket)) return false;
    const id = (webSocket.deserializeAttachment() as { i?: string } | null)?.i;
    if (id) this.#drop(id);
    return true;
  }

  errored(webSocket: WebSocket): boolean {
    return this.closed(webSocket);
  }

  connections(): Connection<Remote>[] {
    return this.ctx
      .getWebSockets(this.#tag)
      .map((webSocket) => this.#wrap(webSocket))
      .filter((connection): connection is Connection<Remote> => connection !== null);
  }

  connection(id: string): Connection<Remote> | undefined {
    for (const webSocket of this.ctx.getWebSockets(this.#tag)) {
      const attachment = webSocket.deserializeAttachment() as { i?: string } | null;
      if (attachment?.i === id) return this.#wrap(webSocket) ?? undefined;
    }
    return undefined;
  }

  #acceptControl(url: URL): Response {
    const id = url.searchParams.get("i") || crypto.randomUUID();
    const meta = url.searchParams.get("m");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [this.#tag]);
    server.serializeAttachment({ i: id, m: meta });
    return new Response(null, { status: 101, webSocket: client });
  }

  #acceptRpc(request: Request, url: URL): Response {
    const id = url.searchParams.get("i");
    if (!id) return new Response("missing connection id", { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    if (this.#live.has(id)) {
      server.accept();
      server.close(1000, "duplicate");
      return new Response(null, { status: 101, webSocket: client });
    }

    server.accept();
    const rawRemote = newWebSocketRpcSession(
      server,
      this.#main(request, id) as RpcTarget | null,
    ) as RpcStub<Remote>;
    const remote = dupStub(rawRemote);
    const live: Live<Remote> = { remote, webSocket: server, active: 0, idle: undefined };
    this.#live.set(id, live);

    server.addEventListener("close", () => this.#drop(id));
    server.addEventListener("error", () => this.#drop(id));

    const pending = this.#pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.resolve(remote);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  #owns(webSocket: WebSocket): boolean {
    return this.ctx.getTags(webSocket).includes(this.#tag);
  }

  #wrap(control: WebSocket): Connection<Remote> | null {
    const attachment = control.deserializeAttachment() as { i?: string; m?: string | null } | null;
    const id = attachment?.i;
    if (!id) return null;
    const host = this;

    let meta: unknown = null;
    try {
      meta = attachment?.m ? JSON.parse(attachment.m) : null;
    } catch {
      meta = null;
    }

    return {
      id,
      meta,
      get live() {
        return host.#live.has(id);
      },
      signal() {
        try {
          control.send(P.openSignal(id));
        } catch {}
      },
      withRemote: (fn) => this.#withRemote(id, control, fn),
      close: () => {
        this.#close(id, "closed");
        try {
          control.close(1000, "closed");
        } catch {}
      },
    };
  }

  async #withRemote<T>(
    id: string,
    control: WebSocket,
    fn: (remote: RpcStub<Remote>) => T | Promise<T>,
  ): Promise<T> {
    const remote = await this.#ensure(id, control);
    const live = this.#live.get(id);
    if (!live) throw new Error("[capnweb] RPC session disappeared before call");
    live.active++;
    if (live.idle) {
      clearTimeout(live.idle);
      live.idle = undefined;
    }
    try {
      return await fn(remote);
    } finally {
      live.active--;
      if (live.active === 0) this.#scheduleTeardown(id);
    }
  }

  #ensure(id: string, control: WebSocket): Promise<RpcStub<Remote>> {
    const live = this.#live.get(id);
    if (live) return Promise.resolve(live.remote);

    const pending = this.#pending.get(id);
    if (pending) return pending.promise;

    let resolve!: (stub: RpcStub<Remote>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<RpcStub<Remote>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error("[capnweb] peer did not open an RPC session in time"));
    }, this.#connectTimeoutMs);
    this.#pending.set(id, { promise, resolve, timer });

    try {
      control.send(P.openSignal(id));
    } catch {
      // The timeout rejects if the control socket was stale.
    }
    return promise;
  }

  #scheduleTeardown(id: string): void {
    if (this.#teardown === "peer") return;
    if (this.#teardown === "immediate") {
      this.#close(id, "idle");
      return;
    }
    const live = this.#live.get(id);
    if (!live || live.idle) return;
    live.idle = setTimeout(() => {
      const current = this.#live.get(id);
      if (current && current.active === 0) this.#close(id, "idle");
    }, this.#idleMs);
  }

  #close(id: string, reason: string): void {
    try {
      this.#live.get(id)?.webSocket.close(1000, reason);
    } catch {}
  }

  #drop(id: string): void {
    const live = this.#live.get(id);
    if (!live) return;
    if (live.idle) clearTimeout(live.idle);
    disposeStub(live.remote);
    this.#live.delete(id);
  }
}
