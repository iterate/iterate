/// <reference types="@cloudflare/workers-types" />

import { RpcTarget } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import { HibernatableCapnwebClient, HibernatableCapnwebHost, workersFetchWith } from "../index.ts";
import type {
  CallPeerProof,
  PeerRecordArgs,
  PeerRecordResult,
  ProofHostApi,
  ProofPeerApi,
  ProofStatus,
} from "./proof-protocol.ts";

type Env = {
  PROOF_DO: DurableObjectNamespace<ProofDurableObject>;
};

const PROOF_DO_NAME = "proof";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    if (url.pathname === "/stateless-worker-proof") {
      return cors(json(await runStatelessWorkerProof(request, env)));
    }

    if (url.pathname === "/browser-proof") {
      return html(browserProofHtml(url));
    }

    const id = env.PROOF_DO.idFromName(PROOF_DO_NAME);
    return cors(await env.PROOF_DO.get(id).fetch(request));
  },
};

export class ProofDurableObject extends DurableObject<Env> {
  readonly #host: HibernatableCapnwebHost<ProofPeerApi, ProofHostApi>;
  readonly #instanceId = crypto.randomUUID();
  #constructorCount = 0;
  #fetchCount = 0;
  #webSocketMessageCount = 0;
  #webSocketCloseCount = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host = new HibernatableCapnwebHost<ProofPeerApi, ProofHostApi>(ctx, {
      idleMs: 250,
      main: (_request, id) => new HostRpcTarget(this, id),
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#constructorCount = ((await ctx.storage.get<number>("constructorCount")) ?? 0) + 1;
      await ctx.storage.put("constructorCount", this.#constructorCount);
    });
  }

  async fetch(request: Request): Promise<Response> {
    this.#fetchCount++;

    const handled = this.#host.handle(request);
    if (handled) return handled;

    const url = new URL(request.url);
    if (url.pathname === "/__proof/status") return json(this.#status());

    if (url.pathname === "/__proof/call-peer") {
      const id = requiredSearchParam(url, "id");
      const message = requiredSearchParam(url, "message");
      return json(await this.#callPeer(id, message));
    }

    return new Response("not found", { status: 404 });
  }

  webSocketMessage(webSocket: WebSocket, data: string | ArrayBuffer): void {
    if (this.#host.message(webSocket, data)) {
      this.#webSocketMessageCount++;
      return;
    }
    webSocket.close(1008, "unknown socket");
  }

  webSocketClose(webSocket: WebSocket): void {
    if (this.#host.closed(webSocket)) this.#webSocketCloseCount++;
  }

  webSocketError(webSocket: WebSocket): void {
    if (this.#host.errored(webSocket)) this.#webSocketCloseCount++;
  }

  echo(message: string) {
    return { message, instanceId: this.#instanceId };
  }

  async callPeerFromSession(id: string, message: string): Promise<PeerRecordResult> {
    const connection = this.#host.connection(id);
    if (!connection) throw new Error(`no control socket for ${id}`);
    return await connection.withRemote((remote) =>
      remote.record({ message, callerInstanceId: this.#instanceId }),
    );
  }

  async #callPeer(id: string, message: string): Promise<CallPeerProof> {
    const before = this.#status();
    const result = await this.callPeerFromSession(id, message);
    const after = this.#status();
    return { before, result, after };
  }

  #status(): ProofStatus {
    const controlsById = new Map(
      this.ctx.getWebSockets("/capnweb-control").map((webSocket) => {
        const attachment = webSocket.deserializeAttachment() as { i?: string } | null;
        return [attachment?.i, webSocket] as const;
      }),
    );
    return {
      instanceId: this.#instanceId,
      constructorCount: this.#constructorCount,
      fetchCount: this.#fetchCount,
      webSocketMessageCount: this.#webSocketMessageCount,
      webSocketCloseCount: this.#webSocketCloseCount,
      connections: this.#host.connections().map((connection) => {
        const control = controlsById.get(connection.id);
        const autoResponseTimestamp = control
          ? (this.ctx.getWebSocketAutoResponseTimestamp(control)?.toISOString() ?? null)
          : null;
        return {
          id: connection.id,
          meta: connection.meta,
          live: connection.live,
          autoResponseTimestamp,
        };
      }),
    };
  }
}

class HostRpcTarget extends RpcTarget implements ProofHostApi {
  constructor(
    private readonly room: ProofDurableObject,
    private readonly id: string,
  ) {
    super();
  }

  echo(args: { message: string }) {
    return this.room.echo(args.message);
  }

  callPeerFromSession(args: { message: string }) {
    return this.room.callPeerFromSession(this.id, args.message);
  }
}

class StatelessWorkerPeerTarget extends RpcTarget implements ProofPeerApi {
  #receivedCount = 0;

  constructor(private readonly runtime: string) {
    super();
  }

  record(args: PeerRecordArgs): PeerRecordResult {
    this.#receivedCount++;
    return {
      runtime: this.runtime,
      message: args.message,
      callerInstanceId: args.callerInstanceId,
      receivedCount: this.#receivedCount,
    };
  }
}

async function runStatelessWorkerProof(request: Request, env: Env) {
  const url = new URL(request.url);
  const id = `stateless-worker-${crypto.randomUUID()}`;
  const baseUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  const proofObject = env.PROOF_DO.get(env.PROOF_DO.idFromName(PROOF_DO_NAME));
  const client = new HibernatableCapnwebClient<ProofHostApi, ProofPeerApi>(baseUrl, {
    id,
    open: workersFetchWith((input, init) => proofObject.fetch(input, init)),
    main: () => new StatelessWorkerPeerTarget("stateless-worker"),
    meta: { runtime: "stateless-worker" },
    idleMs: 0,
    heartbeatMs: 1_000,
  });

  client.start();
  try {
    await waitForConnection(() => proofObject.fetch("https://proof.local/__proof/status"), id);
    const host = await client.connect();
    const echo = await host.echo({ message: "stateless-worker -> host" });
    const callback = await host.callPeerFromSession({ message: "host -> stateless-worker" });
    return { id, echo, callback };
  } finally {
    client.stop();
  }
}

function browserProofHtml(url: URL) {
  const base = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  const hibernateWaitMs = Number(url.searchParams.get("wait") ?? 12_000);
  const heartbeatMs = Number(url.searchParams.get("heartbeat") ?? 250);
  const requireHibernation = url.searchParams.get("requireHibernation") !== "false";
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>hibernatable-capnweb browser proof</title></head>
  <body>
    <pre id="out">running</pre>
    <script type="module">
      import { newWebSocketRpcSession, RpcTarget } from "https://esm.sh/capnweb@0.8.0";

      const out = document.querySelector("#out");
      const show = (value) => {
        out.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      };

      const PING = "ping";
      const PONG = "pong";
      const openSignalId = (data) => {
        if (!data || data === PONG) return null;
        try {
          const message = JSON.parse(data);
          return message?.capnweb === "open" ? message.id : null;
        } catch {
          return null;
        }
      };

      class BrowserClient {
        control;
        rpc;
        remote;
        connecting;
        heartbeat;
        idle;

        constructor(baseUrl, options) {
          this.baseUrl = baseUrl.replace(/\\/+$/, "");
          this.options = options;
          this.id = options.id;
          const meta = options.meta ? "&m=" + encodeURIComponent(JSON.stringify(options.meta)) : "";
          this.controlUrl = this.baseUrl + "/capnweb-control?i=" + encodeURIComponent(this.id) + meta;
          this.rpcUrl = this.baseUrl + "/capnweb?i=" + encodeURIComponent(this.id);
        }

        start() {
          const ws = new WebSocket(this.controlUrl);
          this.control = ws;
          ws.addEventListener("open", () => {
            this.heartbeat = setInterval(() => {
              if (ws.readyState === 1) ws.send(PING);
            }, this.options.heartbeatMs ?? 250);
          });
          ws.addEventListener("message", (event) => {
            if (openSignalId(typeof event.data === "string" ? event.data : "") === this.id) {
              this.ensureRpc().catch(() => {});
            }
          });
        }

        async connect() {
          const remote = await this.ensureRpc();
          this.bumpIdle();
          return remote.dup?.() ?? remote;
        }

        ensureRpc() {
          if (this.remote) return Promise.resolve(this.remote);
          if (this.connecting) return this.connecting;
          this.connecting = Promise.resolve().then(() => {
            const ws = new WebSocket(this.rpcUrl);
            this.rpc = ws;
            const remote = newWebSocketRpcSession(ws, this.options.main());
            ws.addEventListener("message", () => this.bumpIdle());
            ws.addEventListener("close", () => this.dropRpc());
            this.remote = remote;
            this.connecting = undefined;
            this.bumpIdle();
            return remote;
          }).catch((error) => {
            this.connecting = undefined;
            throw error;
          });
          return this.connecting;
        }

        bumpIdle() {
          const idleMs = this.options.idleMs ?? 250;
          if (idleMs <= 0) return;
          clearTimeout(this.idle);
          this.idle = setTimeout(() => this.rpc?.close(1000, "idle"), idleMs);
        }

        dropRpc() {
          clearTimeout(this.idle);
          this.remote?.[Symbol.dispose]?.();
          this.remote = undefined;
          this.rpc = undefined;
          this.connecting = undefined;
        }
      }

      class BrowserPeer extends RpcTarget {
        count = 0;
        record(args) {
          this.count++;
          return {
            runtime: "browser",
            message: args.message,
            callerInstanceId: args.callerInstanceId,
            receivedCount: this.count,
          };
        }
      }

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        const id = "browser-" + crypto.randomUUID();
        const client = new BrowserClient(${JSON.stringify(base)}, {
          id,
          main: () => new BrowserPeer(),
          meta: { runtime: "browser" },
          idleMs: 250,
          heartbeatMs: ${JSON.stringify(heartbeatMs)},
        });
        client.start();

        show("waiting for control socket");
        for (;;) {
          const status = await fetch("/__proof/status").then((r) => r.json());
          if (status.connections.some((connection) => connection.id === id)) break;
          await sleep(50);
        }

        show("calling host from browser");
        const host = await client.connect();
        const echo = await host.echo({ message: "browser -> host" });

        show("waiting for browser RPC burst to close");
        let beforeHibernate;
        for (;;) {
          beforeHibernate = await fetch("/__proof/status").then((r) => r.json());
          const connection = beforeHibernate.connections.find((candidate) => candidate.id === id);
          if (connection && connection.live === false) break;
          await sleep(100);
        }

        show("waiting for DO hibernation");
        await sleep(${JSON.stringify(hibernateWaitMs)});
        const afterHibernate = await fetch("/__proof/status").then((r) => r.json());

        show("calling browser target after wake");
        const call = await fetch("/__proof/call-peer?id=" + encodeURIComponent(id) + "&message=host%20-%3E%20browser").then((r) => r.json());
        const observedHibernation =
          beforeHibernate.instanceId !== afterHibernate.instanceId &&
          afterHibernate.constructorCount > beforeHibernate.constructorCount;
        const result = {
          ok: call.result.runtime === "browser" &&
            call.result.message === "host -> browser" &&
            (${JSON.stringify(requireHibernation)} ? observedHibernation : true) &&
            call.before.instanceId === afterHibernate.instanceId,
          id,
          observedHibernation,
          waitMs: ${JSON.stringify(hibernateWaitMs)},
          beforeHibernate,
          afterHibernate,
          call,
          echo,
        };
        window.__HIBERNATABLE_CAPNWEB_BROWSER_PROOF__ = result;
        show(result);
      } catch (error) {
        const result = { ok: false, error: String(error), stack: error?.stack ?? null };
        window.__HIBERNATABLE_CAPNWEB_BROWSER_PROOF__ = result;
        show(result);
        throw error;
      }
    </script>
  </body>
</html>`;
}

async function waitForConnection(fetchStatus: () => Promise<Response>, id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = (await fetchStatus().then((response) => response.json())) as ProofStatus;
    if (status.connections.some((connection) => connection.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for connection ${id}`);
}

function requiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

function html(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function cors(response: Response): Response {
  if (response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,upgrade");
  return new Response(response.body, { ...response, headers });
}
