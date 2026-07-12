import { createServer, type Server } from "node:http";
import { expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { myComputerProvision } from "../../../../packages/iterate/src/use-my-computer.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

// `iterate use-my-computer` grew two lanes that lend a SERVER on the human's
// machine to their project, and this file proves both with the real capability
// object (myComputerProvision — the exact input the CLI sends; this vitest
// process stands in for the Mac):
//
//   1. getFetcher({ port }) — the project homepage IS the human's local server:
//      the worker's fetch forwards `itx.<name>.getFetcher({port}).fetch(req)`,
//      the Request rides capability dispatch to this process, the fetch hits
//      127.0.0.1:<port>, and the Response rides back. Plain HTTP only — an
//      upgrade can never cross capability dispatch (the socket-carrying
//      Response dies on workerd's internal RPC hops; pinned with a teaching
//      error here and with the raw DataCloneError in
//      live-capability-websocket.e2e.test.ts).
//
//   2. connectSocket({ port, path }) — WebSockets work anyway, by bridging
//      FRAMES instead of carrying the socket: a Durable Object app terminates
//      the browser's socket with WebSocketPair and pumps text frames through a
//      capability handle (send / onMessage callback), while the real socket to
//      the local server lives on the Mac. dynamic-worker-dispatch.md calls this
//      exact shape out as the workable-today form of the `test.fails`
//      specification next door.

/** The "server on the human's Mac": plain HTTP with a recognizable body. */
function startLocalHttpServer(marker: string): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><body><h1>hello from the mac ${marker}</h1>` +
        `<p data-path="${request.url ?? ""}"></p>` +
        `<p data-forwarded-host="${String(request.headers["x-forwarded-host"] ?? "")}"></p>` +
        `</body></html>`,
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

/** A local WebSocket server: greets on connect, then echoes frames prefixed. */
function startLocalWsServer(): Promise<{ port: number; server: WebSocketServer }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.send("local-hello");
    socket.on("message", (data) => socket.send(`local-echo:${String(data)}`));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      resolve({ port: (server.address() as { port: number }).port, server });
    });
  });
}

/**
 * The demo worker committed to the test project: the homepage forwards to the
 * human's HTTP server through getFetcher; the wsbridge app terminates browser
 * WebSockets and bridges frames through connectSocket. Mirrors the seeded
 * template's shape (iterate/sdk base classes, x-iterate-app routing).
 */
function demoWorkerSource(input: { name: string; httpPort: number; wsPort: number }): string {
  return `import { IterateDurableObject, IterateWorkerEntrypoint } from "iterate/sdk";

// Demo (live-capability-fetcher e2e): the homepage IS a server on the human's
// machine, and the wsbridge app carries WebSockets to it frame-by-frame.
export default class ProjectWorker extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "wsbridge") {
      return this.fetchDynamicWorker(req, {
        type: "stateful",
        path: "/",
        className: "WsBridgeApp",
        durableWorkerKey: "app-wsbridge",
        source: {
          files: { type: "repo", repoPath: "/repos/config" },
          options: { entryPoint: "worker.ts" },
        },
      });
    }
    if (app) return new Response("unknown app: " + app, { status: 404 });

    // THE DEMO: serve the project homepage straight from the shared computer.
    const itx = await this.env.ITX.get();
    try {
      const computer = (itx as any).${input.name};
      const fetcher = await computer.getFetcher({ port: ${input.httpPort} });
      return await fetcher.fetch(req);
    } finally {
      try {
        (itx as any)[Symbol.dispose]?.();
      } catch {}
    }
  }
}

// The socket itself can never cross RPC hops, so this Durable Object holds the
// browser's end (WebSocketPair) and exchanges FRAMES with the shared computer:
// browser frames go out through handle.send, local-server frames come back
// through the onMessage callback. Durable Objects share one I/O context across
// events, which is what lets the handle and callbacks outlive the upgrade
// request.
export class WsBridgeApp extends IterateDurableObject {
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();

    // Deliberately NOT disposed at the end of this request: the bridge lives
    // as long as the browser's socket does.
    const itx = await this.env.ITX.get();
    let handle: any;
    try {
      handle = await (itx as any).${input.name}.connectSocket({
        port: ${input.wsPort},
        path: "/",
        onMessage: (data: string) => {
          try {
            server.send(data);
          } catch {}
        },
        onClose: () => {
          try {
            server.close(1000, "local server closed");
          } catch {}
        },
      });
    } catch (error) {
      try {
        (itx as any)[Symbol.dispose]?.();
      } catch {}
      return new Response("bridge failed: " + String(error), { status: 502 });
    }

    server.addEventListener("message", (event) => {
      void handle.send(String(event.data)).catch(() => {
        try {
          server.close(1011, "bridge send failed");
        } catch {}
      });
    });
    const teardown = () => {
      void handle.close({}).catch(() => {});
      try {
        (itx as any)[Symbol.dispose]?.();
      } catch {}
    };
    server.addEventListener("close", teardown);
    server.addEventListener("error", teardown);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
`;
}

/** Project-host plumbing, same shape as project-ingress/live-capability-websocket. */
function projectHosts() {
  const base = new URL(buildUrl({ path: "/" }));
  const isLocal = base.hostname === "localhost" || base.hostname.endsWith(".localhost");
  const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
  const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
  const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
  return { base, isLocal, projectBase };
}

test("the homepage is a server on the human's machine: getFetcher proxies HTTP end to end", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const slug = `mac-fetch-${marker}`;
  const name = "testComputer";

  const { port, server } = await startLocalHttpServer(marker);
  const { port: wsPort, server: wsServer } = await startLocalWsServer();
  try {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug });
    const { projectId } = await project.__describe();

    // The REAL capability, provided exactly as the CLI provides it — including
    // the types string, so the typed-mount gate compiles the new declaration.
    using _provision = await project.provideCapability(myComputerProvision(name));

    await project.repo.commitFiles({
      message: "homepage = the human's local server (live-capability-fetcher e2e)",
      changes: [{ path: "worker.ts", content: demoWorkerSource({ name, httpPort: port, wsPort }) }],
    });

    // The commit triggers a cold rebuild: retry through building 503s (and the
    // stale pre-commit build's homepage) until the local server's body shows.
    const deadline = Date.now() + 120_000;
    let body = "";
    for (;;) {
      const response = await fetch(buildUrl({ path: `/${projectId}/proxied?q=1` }));
      body = await response.text();
      if (response.status === 200 && body.includes(`hello from the mac ${marker}`)) break;
      if (Date.now() > deadline) {
        throw new Error(
          `homepage never showed the local server (last ${response.status}): ${body.slice(0, 300)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    // Path + query traveled to the Mac; the original host arrived as
    // x-forwarded-host.
    expect(body).toContain('data-path="/proxied?q=1"');
    expect(body).toMatch(/data-forwarded-host="[^"]+"/);

    // The boundary, taught not tripped: an upgrade through the fetcher fails
    // with the capability's own explanation, not a deep DataCloneError.
    const fetcher = await (
      project as unknown as {
        testComputer: {
          getFetcher(input: { port: number }): Promise<{ fetch(req: Request): Promise<Response> }>;
        };
      }
    ).testComputer.getFetcher({ port });
    const outcome = await (async () => {
      try {
        await fetcher.fetch(
          new Request("https://mac.example.com/ws", { headers: { upgrade: "websocket" } }),
        );
        return "upgrade unexpectedly succeeded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(outcome).toContain("cannot carry a WebSocket upgrade");
  } finally {
    server.close();
    wsServer.close();
  }
});

test("WebSockets work through the bridge: frames pump between a browser socket and the Mac's server", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const slug = `mac-ws-${marker}`;
  const name = "testComputer";

  const { port, server } = await startLocalHttpServer(marker);
  const { port: wsPort, server: wsServer } = await startLocalWsServer();
  try {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug });
    await project.__describe();

    using _provision = await project.provideCapability(myComputerProvision(name));

    await project.repo.commitFiles({
      message: "wsbridge app (live-capability-fetcher e2e)",
      changes: [{ path: "worker.ts", content: demoWorkerSource({ name, httpPort: port, wsPort }) }],
    });

    const { base, isLocal, projectBase } = projectHosts();
    const appHost = `wsbridge--${slug}`;
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

    // Cold build: retry until the upgrade lands (building 503s read as
    // rejected upgrades; a 502 means the bridge dialed but couldn't connect).
    const openSocketReady = async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          return await openSocket(connect());
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    };

    const socket = await openSocketReady();
    try {
      const messages: string[] = [];
      let wake: (() => void) | undefined;
      socket.on("message", (data) => {
        messages.push(String(data));
        wake?.();
      });
      const waitForMessage = async (predicate: (m: string) => boolean) => {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const hit = messages.find(predicate);
          if (hit) return hit;
          if (Date.now() > deadline) {
            throw new Error(`no matching frame; saw ${JSON.stringify(messages)}`);
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 500);
          });
        }
      };

      // Mac → browser, unprompted: the local server greets on connect, and the
      // greeting crosses the bridge via the onMessage callback chain.
      expect(await waitForMessage((m) => m === "local-hello")).toBe("local-hello");

      // Browser → Mac → browser: a frame out through handle.send, echoed by
      // the local server, back through the callback.
      socket.send(`ping-${marker}`);
      expect(await waitForMessage((m) => m === `local-echo:ping-${marker}`)).toBe(
        `local-echo:ping-${marker}`,
      );
    } finally {
      socket.close();
    }
  } finally {
    server.close();
    wsServer.close();
  }
});
