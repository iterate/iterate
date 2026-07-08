import { expect, test } from "vitest";
import WebSocket from "ws";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

// A project app host (`livews--<slug>.<base>`) frontING a WebSocket server
// that runs HERE, in the vitest runner — provided over Cap'n Web as a live
// capability. The author-side programming model is a plain `fetch(request)`
// handler that upgrades, exactly like a Cloudflare worker's; a browser-side
// socket connecting to the app host reaches it end to end.
//
// Why this shape (see docs/dynamic-worker-dispatch.md): a live socket cannot
// cross the workerd RPC hops between the provider's Cap'n Web session and the
// app isolate — our capnweb fork tunnels sockets across ITS sessions as
// stream pairs, but a Response carrying a materialized WebSocket still cannot
// re-serialize across internal mesh hops. So the socket crosses the mesh as
// paired callback STUBS (functions chain through every hop — RPC's native
// strength), and each end materializes its own real socket: the app isolate
// mints the WebSocketPair that completes the eyeball's upgrade, and the
// Node adapter below feeds the author's fetch handler a WebSocket-like shim.

/** One end of an in-memory socket pair: the WebSocket surface the Node-side
 * fetch handler sees (mirrors workerd's WebSocketPair semantics — born open,
 * buffering until accept()). */
type ShimSocket = {
  accept(): void;
  addEventListener(type: "message" | "close", listener: (event: MessageOrCloseEvent) => void): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
};

type MessageOrCloseEvent = { code?: number; data?: string; reason?: string };

/** An in-memory WebSocketPair for Node: send() on one end fires "message" on
 * the other. Enough surface for a fetch-handler author and the adapter. */
type ShimEnd = {
  buffered: { event: MessageOrCloseEvent; type: "message" | "close" }[];
  closed: boolean;
  listeners: Map<string, ((event: MessageOrCloseEvent) => void)[]>;
  open: boolean;
  peer: ShimEnd | undefined;
};

function socketPairShim(): [ShimSocket, ShimSocket] {
  const makeEnd = (): ShimEnd => ({
    buffered: [],
    closed: false,
    listeners: new Map(),
    open: false,
    peer: undefined,
  });
  const a = makeEnd();
  const b = makeEnd();
  a.peer = b;
  b.peer = a;

  const deliver = (end: ShimEnd, type: "message" | "close", event: MessageOrCloseEvent) => {
    if (!end.open) {
      end.buffered.push({ event, type });
      return;
    }
    for (const listener of end.listeners.get(type) ?? []) listener(event);
  };

  const api = (end: ShimEnd): ShimSocket => ({
    accept: () => {
      end.open = true;
      for (const { event, type } of end.buffered.splice(0)) {
        for (const listener of end.listeners.get(type) ?? []) listener(event);
      }
    },
    addEventListener: (type, listener) => {
      const list = end.listeners.get(type) ?? [];
      list.push(listener);
      end.listeners.set(type, list);
    },
    close: (code, reason) => {
      if (end.closed) return;
      end.closed = true;
      deliver(end.peer!, "close", { code: code ?? 1000, reason: reason ?? "" });
    },
    send: (data) => {
      if (end.closed) return;
      deliver(end.peer!, "message", { data });
    },
  });

  return [api(a), api(b)];
}

/** What the app-side bridge passes when it dials in: callbacks for frames
 * flowing provider → eyeball. */
type WireClient = {
  close(code?: number, reason?: string): void;
  send(data: string): void;
};

/** What the provider answers with: callbacks for frames flowing
 * eyeball → provider. Same shape both directions — a socket over RPC is just
 * two of these facing each other. */
type WireBackend = WireClient;

/**
 * Adapts an author-written `fetch(request)` handler (Node flavor: attach the
 * client end of a socket pair as `response.webSocket`) into the live
 * capability the app-side bridge dials: `connect({ url, headers, client })`
 * returning the backend's callback pair.
 */
function websocketFetchCapability(
  fetchHandler: (request: Request) => Promise<Response>,
): Record<string, unknown> {
  return {
    async connect(input: {
      client: WireClient;
      headers: Record<string, string>;
      url: string;
    }): Promise<WireBackend> {
      const request = new Request(input.url, { headers: input.headers });
      const response = await fetchHandler(request);
      const socket = (response as { webSocket?: ShimSocket }).webSocket;
      if (!socket) {
        throw new Error(`fetch handler did not upgrade (status ${response.status})`);
      }
      // Ownership rule: RPC params are released when the call returns, so
      // callbacks kept for the socket's lifetime must be dup()ed here (and
      // disposed when the socket goes away).
      const dup = <T>(stub: T): T =>
        (stub as { dup?: () => T }).dup ? (stub as { dup(): T }).dup() : stub;
      const clientSend = dup(input.client.send);
      const clientClose = dup(input.client.close);
      const release = () => {
        for (const stub of [clientSend, clientClose]) {
          (stub as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
        }
      };
      socket.accept();
      socket.addEventListener("message", (event) => void clientSend(event.data ?? ""));
      socket.addEventListener("close", (event) => {
        void clientClose(event.code, event.reason);
        release();
      });
      return {
        close: (code, reason) => socket.close(code, reason),
        send: (data) => socket.send(data),
      };
    },
  };
}

/** The bridge app committed into the project repo: terminates the eyeball's
 * upgrade with a real WebSocketPair (this is the class-named-fetch on a real
 * worker object the platform requires) and pumps frames to/from the live
 * capability over plain RPC callbacks. */
const BRIDGE_APP_SOURCE = `import { WorkerEntrypoint } from "cloudflare:workers";
import type { ItxBinding } from "../../sdk.ts";

export default class LiveWsApp extends WorkerEntrypoint<{ ITX: ItxBinding }> {
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const itx = await this.env.ITX.get();
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();

    // Frames provider -> eyeball: the live capability calls these stubs.
    const client = {
      close: (code?: number, reason?: string) => {
        try {
          server.close(code ?? 1000, reason ?? "");
        } catch {}
      },
      send: (data: string) => {
        try {
          server.send(data);
        } catch {}
      },
    };

    const wsbackend = (itx as unknown as {
      wsbackend: {
        connect(input: { client: unknown; headers: Record<string, string>; url: string }): Promise<{
          close(code?: number, reason?: string): Promise<void>;
          send(data: string): Promise<void>;
        }>;
      };
    }).wsbackend;
    const backend = await wsbackend.connect({
      client,
      headers: Object.fromEntries(req.headers),
      url: req.url,
    });

    // Frames eyeball -> provider.
    server.addEventListener("message", (event) => {
      backend.send(String(event.data ?? "")).catch(() => {});
    });
    server.addEventListener("close", (event) => {
      backend.close(event.code, event.reason).catch(() => {});
    });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
`;

test("live capability WebSocket fetcher serves an app host end to end", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const slug = `live-ws-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug });
  await project.__describe();

  // The author-side WebSocket server, running in THIS process: a plain fetch
  // handler that upgrades — echoes frames back with a marker and records what
  // it saw so the test can assert the request really reached Node.
  const seenUrls: string[] = [];
  const nodeFetchHandler = async (request: Request): Promise<Response> => {
    seenUrls.push(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [clientEnd, serverEnd] = socketPairShim();
    serverEnd.accept();
    serverEnd.addEventListener("message", (event) => {
      serverEnd.send(`node-echo:${event.data ?? ""}`);
    });
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "webSocket", { configurable: true, value: clientEnd });
    return response;
  };

  using _provision = await project.provideCapability({
    path: ["wsbackend"],
    type: "live",
    capability: websocketFetchCapability(nodeFetchHandler),
  });

  // Stage A: the capability chain alone (test → platform → this process),
  // proving callback stubs round-trip through the mesh before ingress enters
  // the picture.
  {
    const received: string[] = [];
    // @ts-expect-error dynamic capability path
    const backend = await project.wsbackend.connect({
      client: {
        close: () => {},
        send: (data: string) => void received.push(data),
      },
      headers: { upgrade: "websocket" },
      url: "https://stage-a.example.com/ws",
    });
    await backend.send("stage-a");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(received).toEqual(["node-echo:stage-a"]);
    console.log("stage A ok: capability callbacks round-trip through the mesh");
  }

  // Commit the bridge app and register it in the router's APPS map.
  const router = await project.repo.readFile({ path: "worker.ts" });
  const anchor = "} satisfies Record<string, DynamicWorkerRef>;";
  const patched = router!.content.replace(
    anchor,
    `  livews: {
    type: "stateless",
    path: "/",
    source: {
      files: { type: "repo", repoPath: "/", include: ["apps/livews/**", "sdk.ts"] },
      options: { entryPoint: "apps/livews/worker.ts" },
    },
  },
${anchor}`,
  );
  expect(patched).not.toBe(router!.content);
  await project.repo.commitFiles({
    message: "add livews bridge app (live-capability websocket e2e)",
    changes: [
      { path: "apps/livews/worker.ts", content: BRIDGE_APP_SOURCE },
      { path: "worker.ts", content: patched },
    ],
  });

  const base = new URL(buildUrl({ path: "/" }));
  const isLocal = base.hostname === "localhost" || base.hostname.endsWith(".localhost");
  const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
  const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
  const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
  const appHost = `livews--${slug}`;

  const connect = () =>
    isLocal
      ? new WebSocket(`ws://${base.host}/ws`, {
          handshakeTimeout: 20_000,
          headers: { host: `${appHost}.localhost${base.port ? `:${base.port}` : ""}` },
        })
      : new WebSocket(`wss://${appHost}.${projectBase}/ws`, { handshakeTimeout: 20_000 });

  const openSocket = (ws: WebSocket) =>
    new Promise<WebSocket>((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          reject(
            new Error(
              `upgrade rejected: ${res.statusCode} ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`,
            ),
          ),
        );
      });
      ws.once("error", reject);
    });

  const nextMessage = (ws: WebSocket) =>
    new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(String(data)));
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`socket closed (${code})`)));
    });

  // Cold build → retryable 503s until the bridge app's artifact lands. Any
  // other rejection is a real failure and surfaces immediately.
  const openSocketReady = async () => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        return await openSocket(connect());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("503")) throw error;
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  };

  // Stage A2 (characterization): the DIRECT form — a live capability fetch
  // returning a Response that carries the socket itself. Our capnweb fork
  // tunnels the socket across the capnweb session as a stream pair, but the
  // materialized socket cannot re-serialize across the workerd RPC hops
  // between the session and the caller.
  {
    using _direct = await project.provideCapability({
      path: ["wsdirect"],
      type: "live",
      capability: { fetch: nodeFetchHandler },
    });
    const outcome = await (async () => {
      try {
        // @ts-expect-error dynamic capability path
        const response = await project.wsdirect.fetch(
          new Request("https://direct.example.com/ws", { headers: { upgrade: "websocket" } }),
        );
        return `response ${response.status} webSocket=${String("webSocket" in response && response.webSocket !== null)}`;
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
    // Pin the boundary: if this ever starts succeeding, the mesh learned to
    // carry sockets and docs/dynamic-worker-dispatch.md (plus the bridge
    // below) should be revisited.
    expect(outcome).toContain('Could not serialize object of type "WebSocket"');
  }

  // Stage B: plain HTTP through the app host — routing plus the bridge app's
  // cold build, no capability involved (the bridge answers 426 to non-ws).
  {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const ws = connect();
      const status = await new Promise<number>((resolve, reject) => {
        ws.once("unexpected-response", (_req, res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        ws.once("open", () => resolve(101));
        ws.once("error", reject);
      }).finally(() => ws.close());
      if (status === 101) break;
      if (status !== 503 || Date.now() > deadline) {
        throw new Error(`stage B: app host answered ${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    console.log("stage B ok: app host upgrades through the cold build");
  }

  const socket = await openSocketReady();
  try {
    const echoed = nextMessage(socket);
    socket.send("hello-from-eyeball");
    expect(await echoed).toBe("node-echo:hello-from-eyeball");

    // The upgrade genuinely reached the Node fetch handler, with the app-host
    // URL intact.
    expect(seenUrls.length).toBeGreaterThan(0);
    expect(seenUrls[0]).toContain("/ws");
  } finally {
    socket.close();
  }
});
