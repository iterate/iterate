import { expect, test } from "vitest";
import WebSocket from "ws";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

// THE DESIRED BEHAVIOR (not yet implemented — see `test.fails` below): a live
// capability whose `fetch(request)` upgrades WebSockets, provided over Cap'n
// Web from this vitest process, serves a project app host end to end:
//
//   using _ = await project.provideCapability({
//     path: ["wsbackend"],
//     type: "live",
//     capability: { fetch: myUpgradingFetchHandler },
//   });
//   // + an app whose fetch just forwards: itx.wsbackend.fetch(req)
//
// What stands in the way (docs/dynamic-worker-dispatch.md): our capnweb fork
// tunnels the socket across the Cap'n Web session as a stream pair
// (websocket-streams.ts), but it materializes a real WebSocket at the session
// endpoint, and the internal workerd RPC hops between there and the app
// isolate refuse to serialize it. The passing test below pins that exact
// boundary; the failing test is the specification. When the mesh learns to
// carry the socket (e.g. by staying in stream-pair form until the fetch-lane
// exit), the `test.fails` flips and this file is the to-do list.

/** The WebSocket surface the fork's tunnel needs on the provider side
 * (`WebSocketLike` in capnweb's websocket-streams.ts). Node has no
 * WebSocketPair, so the fetch handler mints this in-memory pair instead —
 * born open, buffering until accept(), like workerd's. */
type ShimSocket = {
  accept(): void;
  addEventListener(type: "message" | "close", listener: (event: MessageOrCloseEvent) => void): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
};

type MessageOrCloseEvent = { code?: number; data?: string; reason?: string };

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

/** A genuine upgrading fetch handler running in this process: echoes frames
 * back prefixed. Written exactly like a workerd handler, modulo the shim
 * standing in for WebSocketPair and the 200 status (undici refuses 1xx; the
 * fork keys on `webSocket` presence, mirroring its own makeUpgradeResponse
 * non-workerd branch). */
function nodeWebSocketFetchHandler(request: Request): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Promise.resolve(new Response("expected websocket", { status: 426 }));
  }
  const [clientEnd, serverEnd] = socketPairShim();
  serverEnd.accept();
  serverEnd.addEventListener("message", (event) => {
    serverEnd.send(`node-echo:${event.data ?? ""}`);
  });
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "webSocket", { configurable: true, value: clientEnd });
  return Promise.resolve(response);
}

/** The app a user would naturally write: forward to the capability. One
 * real-fetch-lane hop terminates at this class's `fetch`; the socket would
 * have to come back through capability dispatch. */
const FORWARDING_APP_SOURCE = `import { WorkerEntrypoint } from "cloudflare:workers";
import type { ItxBinding } from "iterate/sdk";

export default class LiveWsApp extends WorkerEntrypoint<{ ITX: ItxBinding }> {
  async fetch(req: Request): Promise<Response> {
    const itx = await this.env.ITX.get();
    const wsbackend = (itx as unknown as {
      wsbackend: { fetch(req: Request): Promise<Response> };
    }).wsbackend;
    return await wsbackend.fetch(req);
  }
}
`;

test("the boundary, pinned: a socket-carrying Response dies crossing the worker mesh", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `live-ws-pin-${marker}` });
  await project.__describe();

  using _provision = await project.provideCapability({
    path: ["wsbackend"],
    type: "live",
    capability: { fetch: nodeWebSocketFetchHandler },
  });

  // Non-upgrade HTTP through the same capability works — Request/Response
  // serialize fine over capability dispatch. Only the socket cannot cross.
  // @ts-expect-error dynamic capability path
  const plain = await project.wsbackend.fetch(new Request("https://live.example.com/"));
  expect(plain.status).toBe(426);

  const outcome = await (async () => {
    try {
      // @ts-expect-error dynamic capability path
      await project.wsbackend.fetch(
        new Request("https://live.example.com/ws", { headers: { upgrade: "websocket" } }),
      );
      return "upgrade response survived the mesh";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  // The capnweb session leg tunnels the socket (stream pair); the first
  // internal workerd RPC hop after materialization refuses it. If this stops
  // matching, the mesh changed — revisit the failing test below and the doc.
  expect(outcome).toContain('Could not serialize object of type "WebSocket"');
});

test.fails(
  "DESIRED: a live-capability fetch handler serves WebSockets at an app host",
  { timeout: 150_000 },
  async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const slug = `live-ws-${marker}`;

    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({ slug });
    await project.__describe();

    using _provision = await project.provideCapability({
      path: ["wsbackend"],
      type: "live",
      capability: { fetch: nodeWebSocketFetchHandler },
    });

    const router = await project.repo.readFile({ path: "worker.ts" });
    const anchor = "} satisfies Record<string, DynamicWorkerRef>;";
    const patched = router!.content.replace(
      anchor,
      `  livews: {
    type: "stateless",
    path: "/",
    source: {
      files: { type: "repo", repoPath: "/repos/config", include: ["apps/livews/**"] },
      options: { entryPoint: "apps/livews/worker.ts" },
    },
  },
${anchor}`,
    );
    expect(patched).not.toBe(router!.content);
    await project.repo.commitFiles({
      message: "add livews forwarding app (live-capability websocket spec)",
      changes: [
        { path: "apps/livews/worker.ts", content: FORWARDING_APP_SOURCE },
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
          res.resume();
          reject(new Error(`upgrade rejected: ${res.statusCode}`));
        });
        ws.once("error", reject);
      });

    // Retry only cold-build 503s; the first real failure surfaces.
    const openSocketReady = async () => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        try {
          return await openSocket(connect());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("503") || Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    };

    const socket = await openSocketReady();
    try {
      const echoed = new Promise<string>((resolve, reject) => {
        socket.once("message", (data) => resolve(String(data)));
        socket.once("error", reject);
        socket.once("close", (code) => reject(new Error(`socket closed (${code})`)));
      });
      socket.send("hello-from-eyeball");
      expect(await echoed).toBe("node-echo:hello-from-eyeball");
    } finally {
      socket.close();
    }
  },
);
