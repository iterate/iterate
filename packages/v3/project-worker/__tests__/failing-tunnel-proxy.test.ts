// __tests__/failing-tunnel-proxy.test.ts — BUG HUNT: the TUNNEL use case (`iterate tunnel bla
// 3000`): a CLI — a plain NODE capnweb client on /api — provides the fetch-shaped live capability
// `itx.bla` and PROXIES every request to a server on localhost. `itx.bla.fetch(req)` anywhere in
// the project should reach the CLI and come back carrying localhost's answer — WebSocket
// upgrades included, so a local `next dev`-style server with a WS endpoint tunnels whole.
//
// LAYERED like failing-ws-fetch-capability.test.ts, so the failure point is NAMED, not smeared:
//   1. the HTTP half of the tunnel — GREEN TODAY: an eyeball request rides /cap → DO → relay →
//      capnweb → the CLI provider → node:http on localhost → back out, bodies both ways.
//   2. the WS probe — GREEN: the upgrade Request reaches the CLI AND the CLI can open a client
//      WebSocket to the localhost WS server (Node ships a WS CLIENT). Both tunnel halves work;
//      only stitching them — answering the capnweb fetch WITH the socket — cannot be spelled.
//   3. test.fails — the correct behavior: eyeball WS opens (101), echoes through localhost,
//      closes clean. Same blocker as failing-ws-fetch-capability.test.ts: a non-workerd provider
//      cannot FABRICATE a webSocket-bearing 101 Response (no WebSocketPair; undici rejects
//      status 101). The fix is fork-side: a client "answer this fetch with an upgrade" primitive
//      whose socket tunnels over the session like workerd sockets already do.
// Run:
//   pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-tunnel-proxy.test.ts

import { createServer, request as httpRequest, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_tunnel${RUN}_${name}`;

let harness: ProjectHarness;
// Client-side handles retained for the file's lifetime (a GC'd provision would tear a mount
// down mid-test); the harness disposes its sessions at stop().
const keep: unknown[] = [];
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);

// ── the localhost side: what `iterate tunnel bla 3000` points at ──

/** The local HTTP server (the app under development): echoes what it saw so the test proves the
 *  REQUEST crossed the tunnel intact, not just that some response came back. */
function startLocalHttpServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "x-upstream": "localhost-http" });
      res.end(`upstream-saw:${req.method} ${req.url} body=${body}`);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as { port: number }).port, server });
    }),
  );
}

/** A minimal RFC 6455 echo endpoint over node:http upgrade (Node has no WS SERVER built in and
 *  this package deliberately has no ws dep). Handles the one small masked text frame the test
 *  sends and answers close-for-close — enough to prove "a real WS server runs on localhost". */
function startLocalWsEchoServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end("upgrade required");
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (buf: Buffer) => {
      const opcode = buf[0]! & 0x0f;
      if (opcode === 0x8) {
        socket.write(Buffer.from([0x88, 0x00])); // close-for-close, then hang up
        socket.end();
        return;
      }
      if (opcode !== 0x1) return; // text frames only — all this echo ever receives
      const len = buf[1]! & 0x7f; // test payloads stay tiny (<126), single frame
      const mask = buf.subarray(2, 6);
      const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]!));
      const reply = Buffer.from(`local-echo:${payload.toString("utf8")}`);
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as { port: number }).port, server });
    }),
  );
}

let localHttp: { port: number; server: Server };
let localWs: { port: number; server: Server };
beforeAll(async () => {
  localHttp = await startLocalHttpServer();
  localWs = await startLocalWsEchoServer();
});
afterAll(async () => {
  localHttp?.server.close();
  localWs?.server.close();
  await harness?.stop();
});

// ── the CLI side: the tunnel provider ──

/** What `iterate tunnel` would run: fetch-shaped, proxies to localhost. The HTTP branch is the
 *  real thing; the upgrade branch attempts the stitch honestly and records every observation so
 *  the failing hop is NAMED by data, not guessed. */
class TunnelProvider extends RpcTarget {
  observations: string[] = [];
  async fetch(request: Request) {
    const upgrade = String(request?.headers?.get?.("upgrade") ?? "");
    this.observations.push(`fetch invoked: ${request.method} upgrade=${JSON.stringify(upgrade)}`);
    if (upgrade.toLowerCase() !== "websocket") {
      const url = new URL(request.url);
      const upstream = await fetch(
        `http://127.0.0.1:${localHttp.port}${url.pathname}${url.search}`,
        {
          method: request.method,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.text(),
        },
      );
      // Re-minted rather than passed through: the tunnel PATH is what this test pins, not
      // undici-Response-internals-over-capnweb (a production tunnel would stream the body).
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "x-upstream": upstream.headers.get("x-upstream") ?? "" },
      });
    }
    // The localhost half of the stitch WORKS — Node ships a WebSocket CLIENT:
    const local = new WebSocket(`ws://127.0.0.1:${localWs.port}/`);
    await new Promise<void>((resolve, reject) => {
      local.addEventListener("open", () => resolve());
      local.addEventListener("error", () => reject(new Error("local ws dial failed")));
    });
    this.observations.push("local websocket opened (the localhost half is NOT the blocker)");
    local.close(1000, "probe done");
    // The capnweb-answer half CANNOT be spelled in Node — the same two blockers
    // failing-ws-fetch-capability.test.ts pins, attempted honestly:
    const Pair = (globalThis as { WebSocketPair?: new () => Record<0 | 1, unknown> }).WebSocketPair;
    if (!Pair) this.observations.push("blocker: WebSocketPair is undefined in Node");
    try {
      new Response(null, { status: 101 });
      this.observations.push("101 Response constructed (unexpected in Node)");
    } catch (e) {
      this.observations.push(`blocker: ${String(e)}`);
    }
    throw new Error(
      `tunnel provider cannot fabricate the 101 answer in Node: ${this.observations.join(" | ")}`,
    );
  }
}

const capUrl = (ctx: string, scheme: "http" | "ws", path = "") =>
  `${scheme}://${harness.url.host}/cap?ctx=${ctx}&cap=${encodeURIComponent("itx.bla")}${path}`;

/** Provide `itx.bla` from a fresh Node capnweb session — the CLI's exact posture. */
async function provideTunnel(ctx: string): Promise<TunnelProvider> {
  const provider = harness.session(ctx);
  const itx = await provider.authenticate().get();
  const device = new TunnelProvider();
  const key = crypto.randomUUID();
  keep.push(await itx.rpcStubs.provide(device, { key }));
  await itx.provide({ path: "itx.bla", target: `itx.rpcStubs.get('${key}')` });
  return device;
}

/** One full eyeball WebSocket round trip: open → send → first message → close. Never throws —
 *  the caller asserts on the outcome (so a test.fails failure is an EXPECT, not a stray). */
function wsRoundTrip(
  url: string,
  send: string,
  timeoutMs = 10_000,
): Promise<{ opened: boolean; echo?: string; closeCode?: number; error?: string }> {
  return new Promise((resolve) => {
    const out: { opened: boolean; echo?: string; closeCode?: number; error?: string } = {
      opened: false,
    };
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ...out, error: out.error ?? `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    ws.addEventListener("open", () => {
      out.opened = true;
      ws.send(send);
    });
    ws.addEventListener("message", (ev) => {
      out.echo = String((ev as MessageEvent).data);
      ws.close(1000, "done");
    });
    ws.addEventListener("error", (ev) => {
      out.error = String((ev as { message?: unknown }).message ?? "websocket error");
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      out.closeCode = (ev as CloseEvent).code;
      resolve(out);
    });
  });
}

/** A raw HTTP/1.1 upgrade probe via node:http (undici's fetch strips Connection/Upgrade — the
 *  forbidden headers — so THIS is the only Node way to read the non-101 answer's status+body,
 *  which is where the fetch lane writes its error text). */
function rawUpgradeProbe(
  path: string,
  timeoutMs = 10_000,
): Promise<{ status?: number; body: string; upgraded: boolean; error?: string }> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: harness.url.hostname,
      port: harness.url.port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          "base64",
        ),
        "Sec-WebSocket-Version": "13",
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ body: "", upgraded: false, error: `probe timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body, upgraded: false });
      });
    });
    req.on("upgrade", (res, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: res.statusCode, body: "", upgraded: true });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      resolve({ body: "", upgraded: false, error: String(e) });
    });
    req.end();
  });
}

// ─────────────────────── 1. the HTTP half of the tunnel — GREEN TODAY ───────────────────────

test("HTTP tunnel: an eyeball POST to itx.bla rides through the Node CLI provider to localhost and back, bodies intact both ways", async () => {
  const ctx = c("http");
  const device = await provideTunnel(ctx);

  const res = await fetch(capUrl(ctx, "http"), { method: "POST", body: "ping-through-tunnel" });
  const body = await res.text();
  console.log(
    "[tunnel] HTTP:",
    res.status,
    JSON.stringify(body),
    JSON.stringify(device.observations),
  );
  expect(res.status).toBe(200);
  // localhost's own words prove the REQUEST crossed the tunnel (path+query intact), not just
  // that a response came back:
  expect(body).toBe(`upstream-saw:POST /cap?ctx=${ctx}&cap=itx.bla body=ping-through-tunnel`);
  expect(res.headers.get("x-upstream")).toBe("localhost-http");
  expect(device.observations).toContain('fetch invoked: POST upgrade=""');
});

// ─────────────────────── 2. the WS probe: BOTH tunnel halves work; only the stitch cannot ───────────────────────

test("WS tunnel probe: the upgrade reaches the CLI, the CLI opens the localhost WebSocket, and ONLY 101 fabrication blocks", async () => {
  const ctx = c("wsprobe");
  const device = await provideTunnel(ctx);

  const probe = await rawUpgradeProbe(`/cap?ctx=${ctx}&cap=${encodeURIComponent("itx.bla")}`);
  await new Promise((r) => setTimeout(r, 300));
  console.log("[tunnel] raw upgrade probe:", JSON.stringify(probe).slice(0, 400));
  console.log("[tunnel] provider observations:", JSON.stringify(device.observations));

  // POSITIVE PINS — everything a tunnel needs EXCEPT the answer works today:
  expect(device.observations).toContain('fetch invoked: GET upgrade="websocket"');
  expect(device.observations).toContain(
    "local websocket opened (the localhost half is NOT the blocker)",
  );
  // The one missing piece, named by the runtime itself:
  expect(device.observations).toContain("blocker: WebSocketPair is undefined in Node");
  // And the provider's throw rides every hop back as the eyeball's non-101 answer:
  expect(probe.upgraded).toBe(false);
  expect(probe.status).toBe(500);
  expect(probe.body).toContain("tunnel provider cannot fabricate the 101 answer in Node");
});

// BUG (NARROWED by measurement, 2026-08-31): `iterate tunnel bla 3000` cannot tunnel WebSockets
//   with any BLESSED spelling — the provider above attempts the workerd one
//   (`new Response(null,{status:101,webSocket})`) and Node refuses it (no WebSocketPair; undici
//   rejects status 101 and drops a `webSocket` init property).
// MEASURED: the gap is API BLESSING, not capability. The fork's serializer reads `webSocket` as
//   a plain Response property and never serializes status for upgrades, so the fork's own
//   test-only spelling — `Object.defineProperty(new Response(null), "webSocket", { value:
//   localSocket })` with the undici client socket attached — ran this exact scenario GREEN end
//   to end on published 0.12.0 (101 + `local-echo:` + clean close 1000; the clean close also
//   needed the DO's close-echo fix in fetch-capabilities.handleWebSocketClose).
// EXPECTED: parity with a workerd provider via a blessed one-call answer.
// THE FIX IS A TINY FORK EXPORT, specced in docs/capnweb-upgrade-answer.md: bless the spelling
//   as `upgradeWebSocketResponse(socket, init?)` (+ a pure-JS WebSocketPair shim for
//   endpoint-style providers, which also flips failing-ws-fetch-capability.test.ts). This test
//   flips green by swapping the upgrade branch above to that one call.
test.fails("WS tunnel: an eyeball WebSocket on itx.bla opens (101), echoes off the LOCALHOST server, and closes clean", async () => {
  const ctx = c("ws");
  await provideTunnel(ctx);

  const ws = await wsRoundTrip(capUrl(ctx, "ws"), "hello-through-tunnel");
  console.log("[tunnel] ws round trip:", JSON.stringify(ws));
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("local-echo:hello-through-tunnel");
  expect(ws.closeCode).toBe(1000);
});
