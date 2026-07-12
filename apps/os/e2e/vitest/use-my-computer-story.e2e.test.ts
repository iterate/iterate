import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import WebSocket, { type ClientOptions } from "ws";
import { myComputerProvision } from "../../../../packages/iterate/src/use-my-computer.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The whole `use-my-computer` story, end to end, against a real deployment
// (run it against a PREVIEW slot). It proves the four steps a human + agent do:
//
//   1. install the CLI            — the human runs `iterate use-my-computer`
//   2. share the computer         — we provide the CLI's EXACT payload
//                                    (myComputerProvision, the same input the CLI
//                                    sends), with this vitest process standing in
//                                    for the Mac, lending a port
//   3. run code to start a server — an agent calls itx.<name>.runSwift(...) to
//                                    launch a DETACHED HTTP+WebSocket server on
//                                    the machine (the genuinely new step)
//   4. make it accessible         — the agent commits a homepage that forwards
//                                    to http://<name>.iterate/, and it is reached
//                                    by a website VISITOR over real HTTPS + WSS
//                                    (websocket greet + echo). Agent access is the
//                                    same egress that forward exercises.
//
// It starts a real detached OS process (the "server on the Mac") and needs this
// machine to act as the Mac, so it is OPT-IN. Run it (from apps/os) with:
//
//   RUN_UMC_STORY=1 doppler run --project os --config preview_9 -- \
//     pnpm e2e run e2e/vitest/use-my-computer-story.e2e.test.ts
//
// (`myComputerProvision` is the exact input `iterate use-my-computer` provides;
// the CLI itself is `connectItx` + `provideCapability(myComputerProvision)` +
// holdWarm, plus the --expose-port flag and APP_CONFIG_BASE_URL base-URL added
// in this PR so a `doppler run --config preview_N -- iterate use-my-computer
// --expose-port <p>` run works.)
// ─────────────────────────────────────────────────────────────────────────────

const STORY_ENABLED = process.env.RUN_UMC_STORY === "1";

// apps/os/e2e/vitest/ → repo root is four levels up. ws is a direct dep of
// packages/iterate (not hoisted to the repo root), so the detached server
// resolves it via NODE_PATH pointed there.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const serverNodePath = `${repoRoot}packages/iterate/node_modules`;

/** Grab a free localhost port (small race, fine for a test). */
function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * The agent's "run code to start a server" step: Swift that writes a tiny Node
 * HTTP+WebSocket server and launches it DETACHED, so runSwift returns while the
 * server keeps serving on `port`. The detached child is nohup'd AND redirects
 * fd 0/1/2 (`</dev/null >log 2>&1`) — both are needed, or the CLI's `run()`
 * never sees the pipes EOF and runSwift hangs. (`nohup`, not `setsid`: macOS
 * has no setsid.)
 */
function startServerSwift(input: { port: number; marker: string }): string {
  const serverJs = `
const http = require("http");
const { WebSocketServer } = require("ws");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><html><body><h1>hello from the mac ${input.marker}</h1>' +
    '<p data-path="' + (req.url || "") + '"></p></body></html>');
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  socket.send("local-hello");
  socket.on("message", (data) => socket.send("local-echo:" + String(data)));
});
server.listen(${input.port}, "127.0.0.1");
setTimeout(() => process.exit(0), 180000); // self-clean after 3 min
`;
  const b64 = Buffer.from(serverJs, "utf8").toString("base64");
  // NOTE: `\\(...)` in this TS template becomes Swift string interpolation.
  return `
import Foundation
do {
  let js = String(data: Data(base64Encoded: "${b64}")!, encoding: .utf8)!
  let dir = NSTemporaryDirectory()
  let jsPath = dir + "iterate-mac-${input.marker}.js"
  let logPath = dir + "iterate-mac-${input.marker}.log"
  try js.write(toFile: jsPath, atomically: true, encoding: .utf8)
  let cmd = "NODE_PATH=${serverNodePath} nohup node \\(jsPath) </dev/null >\\(logPath) 2>&1 & disown; echo started ${input.marker}"
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = ["-lc", cmd]
  try p.run()
  p.waitUntilExit()
  print("launched \\(jsPath)")
} catch {
  FileHandle.standardError.write("swift-launch-error: \\(error)".data(using: .utf8)!)
  exit(1)
}
`;
}

/** The homepage the agent commits: one forward carries HTTP and /ws alike. */
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

function projectHosts() {
  const base = new URL(buildUrl({ path: "/" }));
  const isLocal = base.hostname === "localhost" || base.hostname.endsWith(".localhost");
  const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
  const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
  const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
  return { base, isLocal, projectBase };
}

test.skipIf(!STORY_ENABLED)(
  "share → runSwift a server → accessible to visitors (HTTP + WebSockets), on preview",
  { timeout: 300_000 },
  async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const slug = `mac-story-${marker}`;
    const name = "testComputer";
    const port = await freePort();

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug });
    const { projectId } = await project.__describe();

    // Keep the providing session warm — it IS the Mac, so it must stay reachable
    // through the visitor cold-build poll below; an idle capnweb /api socket gets
    // edge-closed (1006). The CLI heartbeats its own session for the same reason.
    const heartbeat = setInterval(() => void project.__describe().catch(() => {}), 5_000);

    try {
      // ── 1 + 2. install + share: the CLI's exact payload, lending `port` ─────
      using _provision = await project.provideCapability(
        myComputerProvision(name, { exposePort: port }),
      );
      const computer = project as unknown as Record<
        string,
        {
          runSwift(input: {
            code: string;
          }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
        }
      >;

      // ── 3. run code on the Mac to START A SERVER (detached, on `port`) ──────
      const launched = await computer[name]!.runSwift({ code: startServerSwift({ port, marker }) });
      expect(launched.exitCode, `runSwift failed: ${launched.stderr}`).toBe(0);

      // ── 4. make it accessible: the agent commits a forwarding homepage ─────
      await project.repo.commitFiles({
        message: "homepage = the human's local server, by URL (use-my-computer story)",
        changes: [{ path: "worker.ts", content: demoWorkerSource(name) }],
      });

      // ── 4a. accessible to a VISITOR over real HTTPS (retry cold build) ─────
      const deadline = Date.now() + 180_000;
      let body = "";
      for (;;) {
        const response = await fetch(buildUrl({ path: `/${projectId}/` }));
        body = await response.text();
        if (response.status === 200 && body.includes(`hello from the mac ${marker}`)) break;
        if (Date.now() > deadline) {
          throw new Error(`homepage never showed the Mac's server (last ${response.status})`);
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      expect(body).toContain(`hello from the mac ${marker}`);

      // ── 4b. accessible to a VISITOR over real WSS (websockets!) ────────────
      const { base, isLocal, projectBase } = projectHosts();
      const wsUrl = isLocal ? `ws://${base.host}/ws` : `wss://${slug}.${projectBase}/ws`;
      const wsOptions: ClientOptions = isLocal
        ? { headers: { host: `${slug}.localhost${base.port ? `:${base.port}` : ""}` } }
        : {};
      const frames = await roundTripWebSocket(wsUrl, wsOptions, `ping-${marker}`);
      expect(frames).toContain("local-hello");
      expect(frames).toContain(`local-echo:ping-${marker}`);

      // ── 4c. accessible to the AGENT ────────────────────────────────────────
      // The homepage worker above IS in-project code reaching the capability by
      // URL (`fetch("http://<name>.iterate/…")`). An agent's codemode script uses
      // the IDENTICAL egress — bare `fetch()` in a script isolate flows through
      // the same projectEgressFetcher → ProjectDurableObject.fetch → capability
      // arm as a worker's (worker-runner.ts binds both the same globalOutbound).
      // So the visitor forward above is also the agent-access proof.
    } finally {
      clearInterval(heartbeat);
      // Best-effort: stop the Mac's server (it also self-exits after 3 min).
      const { spawn } = await import("node:child_process");
      spawn("bash", ["-lc", `pkill -f iterate-mac-${marker}.js || true`], { stdio: "ignore" });
    }
  },
);

/**
 * Connect a WebSocket (retrying cold-build 503s), send one frame, and resolve
 * with all frames seen once both the greeting and the echo have arrived.
 */
function roundTripWebSocket(url: string, options: ClientOptions, send: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    const want = `local-echo:${send}`;
    const deadline = Date.now() + 90_000;
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const attempt = () => {
      if (settled) return;
      const socket = new WebSocket(url, { handshakeTimeout: 20_000, ...options });
      socket.on("open", () => socket.send(send));
      socket.on("message", (data) => {
        frames.push(String(data));
        if (frames.includes("local-hello") && frames.includes(want)) {
          try {
            socket.close();
          } catch {}
          settle(() => resolve(frames));
        }
      });
      socket.on("unexpected-response", (_req, res) => {
        res.resume();
        // Retry ONLY the cold-build 503; a real failure surfaces immediately.
        if (res.statusCode === 503 && Date.now() < deadline) setTimeout(attempt, 2_000);
        else settle(() => reject(new Error(`ws upgrade rejected: ${res.statusCode}`)));
      });
      socket.on("error", (error) => {
        if (Date.now() < deadline) setTimeout(attempt, 2_000);
        else settle(() => reject(error));
      });
    };
    setTimeout(
      () => settle(() => reject(new Error(`ws never echoed; saw ${JSON.stringify(frames)}`))),
      90_000,
    );
    attempt();
  });
}
