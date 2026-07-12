import { createServer, type Server } from "node:http";
import { expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { myComputerProvision } from "../../../../packages/iterate/src/use-my-computer.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

// `iterate use-my-computer` can lend the SERVER on the human's machine to their
// project BY URL, and this proves it end to end with the real capability object
// (myComputerProvision — the exact input the CLI sends; this vitest process
// stands in for the Mac). The mount is `addressable`, so it answers at
// http://<name>.iterate/ :
//
//   // a project worker's whole homepage:
//   fetch(new Request("http://testComputer.iterate/…", req))
//
// Because every hop is a real fetch(), ONE forward serves both the homepage
// (HTTP) and its /ws upgrade: project egress → the capability host Durable
// Object, which terminates the WebSocket (WebSocketPair) and bridges frames to
// the Mac. The RPC path (itx.<name>.fetch) carries the HTTP but never the
// upgrade — that boundary is pinned in live-capability-websocket.e2e.test.ts;
// the URL form is what makes the upgrade work.

/** The "server on the human's Mac": a dev-server-like combined HTTP + WebSocket
 * origin on ONE port — HTML on GET, greet-then-echo on a /ws upgrade. */
function startLocalServer(
  marker: string,
): Promise<{ port: number; http: Server; ws: WebSocketServer }> {
  const http = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><body><h1>hello from the mac ${marker}</h1>` +
        `<p data-path="${request.url ?? ""}"></p>` +
        `<p data-forwarded-host="${String(request.headers["x-forwarded-host"] ?? "")}"></p>` +
        `</body></html>`,
    );
  });
  // Attach the WebSocket server to the SAME http server, so http and ws share one
  // port — exactly like a real dev server with HMR.
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket) => {
    socket.send("local-hello");
    socket.on("message", (data) => socket.send(`local-echo:${String(data)}`));
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ port: address.port, http, ws });
    });
  });
}

/**
 * Await full shutdown. A WebSocketServer won't close while a client socket is
 * open — here the bridge's still-live provider socket (a hibernated capability
 * host may never run its close) — so terminate any clients first. That abrupt
 * close also drives the provider's own socket-close teardown.
 */
function closeLocalServer(server: { http: Server; ws: WebSocketServer }): Promise<void> {
  for (const client of server.ws.clients) client.terminate();
  return new Promise((resolve) => {
    server.ws.close(() => server.http.close(() => resolve()));
  });
}

/**
 * The demo worker committed to the test project: ONE fetch() forwards
 * everything — the homepage and the /ws upgrade alike — to the addressable
 * capability by URL. The whole WsBridgeApp + getFetcher/connectSocket dance is
 * gone; the platform runs it. `testComputer` (a camelCase mount) is reached at
 * the lowercased URL host, proving case-insensitive capability resolution.
 */
function demoWorkerSource(name: string): string {
  return `import { IterateWorkerEntrypoint } from "iterate/sdk";

export default class ProjectWorker extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return fetch(new Request(\`http://${name}.iterate\${url.pathname}\${url.search}\`, req));
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

test("the homepage AND its websocket are a server on the human's machine, reached by URL", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const slug = `mac-url-${marker}`;
  const name = "testComputer";

  const local = await startLocalServer(marker);
  try {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug });
    const { projectId } = await project.__describe();

    // The REAL capability, provided exactly as the CLI provides it: addressable,
    // bound to the local server's port, with the types string the typed-mount
    // gate compiles.
    using _provision = await project.provideCapability(
      myComputerProvision(name, { exposePort: local.port }),
    );

    await project.repo.commitFiles({
      message: "homepage = the human's local server, by URL (live-capability url e2e)",
      changes: [{ path: "worker.ts", content: demoWorkerSource(name) }],
    });

    // ── HTTP: the homepage IS the human's server ──────────────────────────────
    // The commit triggers a cold rebuild: retry through building 503s (and the
    // stale pre-commit homepage) until the local server's body shows.
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
    // Path + query traveled to the Mac; the request arrived with a forwarded host.
    expect(body).toContain('data-path="/proxied?q=1"');
    expect(body).toMatch(/data-forwarded-host="[^"]+"/);

    // ── WebSocket: the SAME URL forward carries the upgrade ──────────────────
    const { base, isLocal, projectBase } = projectHosts();
    const connect = () =>
      isLocal
        ? new WebSocket(`ws://${base.host}/ws`, {
            handshakeTimeout: 20_000,
            headers: { host: `${slug}.localhost${base.port ? `:${base.port}` : ""}` },
          })
        : new WebSocket(`wss://${slug}.${projectBase}/ws`, { handshakeTimeout: 20_000 });

    const openSocket = (ws: WebSocket) =>
      new Promise<WebSocket>((resolve, reject) => {
        ws.once("open", () => resolve(ws));
        ws.once("unexpected-response", (_req, res) => {
          res.resume();
          const error = new Error(`upgrade rejected: ${res.statusCode}`) as Error & {
            status?: number;
          };
          error.status = res.statusCode;
          reject(error);
        });
        ws.once("error", reject);
      });

    // Retry ONLY the cold-build 503 (the router's building page); a real failure
    // such as a 502/501 from the bridge surfaces immediately.
    const openSocketReady = async () => {
      const wsDeadline = Date.now() + 60_000;
      for (;;) {
        try {
          return await openSocket(connect());
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 503 || Date.now() > wsDeadline) throw error;
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
        const msgDeadline = Date.now() + 30_000;
        for (;;) {
          const hit = messages.find(predicate);
          if (hit) return hit;
          if (Date.now() > msgDeadline) {
            throw new Error(`no matching frame; saw ${JSON.stringify(messages)}`);
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 500);
          });
        }
      };

      // Mac → browser, unprompted: the local server greets on connect, crossing
      // the bridge via the onMessage callback chain.
      expect(await waitForMessage((m) => m === "local-hello")).toBe("local-hello");
      // Browser → Mac → browser: a frame out through the bridge, echoed back.
      socket.send(`ping-${marker}`);
      expect(await waitForMessage((m) => m === `local-echo:ping-${marker}`)).toBe(
        `local-echo:ping-${marker}`,
      );
    } finally {
      socket.close();
    }
    // Teardown note: closing the browser socket does NOT reliably drain the Mac's
    // socket in local dev — the capability host's close listener may not run once
    // the upgrade request has returned — so closeLocalServer force-terminates it,
    // which also drives the provider's own socket-close teardown.
  } finally {
    await closeLocalServer(local);
  }
});
