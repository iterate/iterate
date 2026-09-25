// fetch-upgrade-visitor-close.test.ts — a visitor that closes its WebSocket to a lent stub (a
// tunnel's /clock, a Vite HMR socket; a tab closed or reloaded) ends the edge's invocation cleanly.
//
// The edge holds the visitor's socket: its 101 carries one end of the edge's own WebSocketPair, and
// the other end is spliced to the context's socket (context/fetch-upgrade-splice.ts). prd logged
// EVERY such invocation as an uncaught "Network connection lost." at the visitor's close
// (2026-09-25: each edge /clock invocation, outcome `exception`), and the fault alarm paged on a tab
// closing. It is workerd's, shown here without the platform: a pair end accepted BEFORE the runtime
// starts pumping the returned end to the network reads on after the visitor's close frame, so
// releasing the accepted end fails the pump ("other end of WebSocketPipe was destroyed"), the
// invocation's error. Accepted a turn later, the pump stops at the close.
//
// Only a real socket over real HTTP into workerd shows it (the Workers suite's in-process visitor
// never meets the network pump, and wrangler's harness does not log the runtime's own uncaught
// errors), so this row serves `visitorEndOfSplice` — the edge's code, both ends of the splice wired
// through a stand-in context socket — from a bare workerd, and reads workerd's own log.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WebSocket } from "ws";
import { expect, test, vi } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";

test("a visitor that closes its WebSocket to the edge's spliced upgrade ends the invocation without an uncaught error", async () => {
  await using runtime = await bareWorkerd();
  for (let visit = 0; visit < 3; visit++)
    expect(await visitTheClock(`${runtime.origin}/spliced`)).toEqual({
      ticks: 3,
      closeCode: 1000,
    });
  expect(await runtime.uncaughtAfterTheCloses()).toEqual([]);
});

// THE UPSTREAM DEFECT the splice works around (docs/engineering-invariants.md: a workaround stays only
// while a test pins its defect): a pair end accepted before its other end is returned. This row goes
// red the day workerd stops failing that invocation; `visitorEndOfSplice` may then accept at once.
createFailing(test, /the invocation failed: .*other end of WebSocketPipe was destroyed/)(
  "workerd: a WebSocketPair end accepted before the 101 carrying the other end is sent fails the invocation at a clean close",
  async () => {
    await using runtime = await bareWorkerd();
    expect(await visitTheClock(`${runtime.origin}/accepted-first`)).toEqual({
      ticks: 3,
      closeCode: 1000,
    });
    const uncaught = await runtime.uncaughtAfterTheCloses();
    if (uncaught.length) throw new Error(`the invocation failed: ${uncaught.join(" | ")}`);
  },
);

/** The edge's splice, served by a bare workerd: `/spliced` answers with `visitorEndOfSplice` spliced
 *  to a stand-in context socket whose other end is the provider's side of the splice, a clock (a
 *  tunnel's /clock sends a tick a second); `/accepted-first` with the clock's own pair, its end
 *  accepted before the 101 — the defect alone. */
const FIXTURE = `
import { FetchUpgradeSpliceEnd, visitorEndOfSplice } from "./fetch-upgrade-splice.ts";

function clockSocket() {
  const pair = new WebSocketPair();
  pair[1].accept();
  for (let tick = 1; tick <= 3; tick++) pair[1].send("tick " + tick);
  return pair[0];
}

function end(side, local, socket) {
  return new FetchUpgradeSpliceEnd({
    side, upgradeId: "u", local, localGoneClose: { code: 1001, reason: "gone" }, socket,
    deployId: "d", contextAbortedOffset: null, redial: async () => null, report: () => {},
  });
}

export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.headers.get("upgrade") !== "websocket") return new Response("up");
    if (pathname === "/accepted-first") return new Response(null, { status: 101, webSocket: clockSocket() });
    const context = new WebSocketPair();
    const leg = clockSocket();
    leg.accept();
    context[1].accept();
    end("leg", leg, context[1]);
    const visitor = visitorEndOfSplice((local) => {
      context[0].accept();
      end("eyeball", local, context[0]);
    });
    return new Response(null, { status: 101, webSocket: visitor });
  },
};
`;

/** A bare workerd (the binary wrangler runs) serving FIXTURE on a free port, `--verbose` so its log
 *  names every invocation that failed. `uncaughtAfterTheCloses` waits out the invocations' ends
 *  and returns those lines. */
async function bareWorkerd() {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "fetch-upgrade-visitor-close-"));
  const bundle = await build({
    stdin: { contents: FIXTURE, resolveDir: dirname(fileURLToPath(import.meta.url)) },
    bundle: true,
    format: "esm",
    write: false,
  });
  await writeFile(join(dir, "worker.js"), bundle.outputFiles[0]!.text);
  await writeFile(
    join(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = (
    modules = [ (name = "worker.js", esModule = embed "worker.js") ],
    compatibilityDate = "2026-09-01",
  )) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);`,
  );
  const binary: string = createRequire(createRequire(import.meta.url).resolve("wrangler"))(
    "workerd",
  ).default;
  const child: ChildProcess = spawn(binary, ["serve", join(dir, "config.capnp"), "--verbose"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (chunk) => (log += chunk));
  child.stderr!.on("data", (chunk) => (log += chunk));
  await vi.waitFor(
    async () => expect(await fetch(`http://127.0.0.1:${port}/`)).toMatchObject({ ok: true }),
    { timeout: 15_000, interval: 100 },
  );
  return {
    origin: `ws://127.0.0.1:${port}`,
    async uncaughtAfterTheCloses() {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return log.split("\n").filter((line) => line.includes("uncaught exception"));
    },
    async [Symbol.asyncDispose]() {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A port nothing listens on: the OS's pick for a listener closed at once. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Open the clock, read its three ticks, close 1000 as a browser tab does, and wait for the close. */
async function visitTheClock(url: string) {
  const socket = new WebSocket(url);
  const out: { ticks: number; closeCode?: number } = { ticks: 0 };
  socket.on("message", () => {
    if (++out.ticks === 3) socket.close(1000, "tab closed");
  });
  socket.on("close", (code) => (out.closeCode = code));
  await vi.waitFor(() => expect(out).toMatchObject({ closeCode: expect.any(Number) }), {
    timeout: 15_000,
  });
  return out;
}
