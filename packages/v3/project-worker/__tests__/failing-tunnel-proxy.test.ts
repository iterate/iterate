// __tests__/failing-tunnel-proxy.test.ts — the TUNNEL use case (`iterate tunnel bla 3000`):
// a CLI — a plain NODE capnweb client on /api — provides the fetch-shaped live capability
// `itx.bla` and PROXIES every request to a server on localhost. `itx.bla.fetch(req)` anywhere in
// the project reaches the CLI and comes back carrying localhost's answer — WEBSOCKET UPGRADES
// INCLUDED: the CLI dials its localhost WS client and answers with the blessed one-call
// `upgradeWebSocketResponse(localSocket)` (capnweb ≥0.12.2 — the sender-side upgrade answer,
// docs/capnweb-upgrade-answer.md). The frames tunnel over the session's existing stream pipes.
// Both halves are GREEN end to end; formerly the WS half was a test.fails pinning that no
// blessed spelling existed (Node has no WebSocketPair; undici rejects status 101).
// Run:
//   pnpm exec vitest run --project harness __tests__/failing-tunnel-proxy.test.ts

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget, upgradeWebSocketResponse } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_tunnel${RUN}_${name}`;

let harness: ProjectHarness;
// Live mounts ride their providing session (the harness disposes its sessions at stop()) — no
// client-side handle to retain: the mount path is the stub's identity.
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

/** What `iterate tunnel` runs: fetch-shaped, proxies to localhost. The HTTP branch re-mints
 *  the upstream answer; the upgrade branch dials the localhost WS client and answers with the
 *  blessed `upgradeWebSocketResponse` — capnweb's own tunnel is the frame bridge. */
class TunnelProvider extends RpcTarget {
  async fetch(request: Request) {
    const upgrade = String(request?.headers?.get?.("upgrade") ?? "");
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
    // The whole WS stitch: dial localhost, await open (speak-second server — the await-open
    // posture), answer with the socket. capnweb tunnels its frames + close both ways.
    const local = new WebSocket(`ws://127.0.0.1:${localWs.port}/`);
    await new Promise<void>((resolve, reject) => {
      local.addEventListener("open", () => resolve(), { once: true });
      local.addEventListener("error", () => reject(new Error("local ws dial failed")), {
        once: true,
      });
    });
    return upgradeWebSocketResponse(local);
  }
}

const capUrl = (ctx: string, scheme: "http" | "ws", path = "") =>
  `${scheme}://${harness.url.host}/cap?ctx=${ctx}&cap=${encodeURIComponent("itx.bla")}${path}`;

/** Provide `itx.bla` from a fresh Node capnweb session — the CLI's exact posture. */
async function provideTunnel(ctx: string): Promise<void> {
  const provider = harness.session(ctx);
  const itx = await provider.authenticate().get();
  await itx.provide("itx.bla", new TunnelProvider());
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

// ─────────────────────── 1. the HTTP half of the tunnel — GREEN TODAY ───────────────────────

test("HTTP tunnel: an eyeball POST to itx.bla rides through the Node CLI provider to localhost and back, bodies intact both ways", async () => {
  const ctx = c("http");
  await provideTunnel(ctx);

  const res = await fetch(capUrl(ctx, "http"), { method: "POST", body: "ping-through-tunnel" });
  const body = await res.text();
  console.log("[tunnel] HTTP:", res.status, JSON.stringify(body));
  expect(res.status).toBe(200);
  // localhost's own words prove the REQUEST crossed the tunnel (path+query intact), not just
  // that a response came back:
  expect(body).toBe(`upstream-saw:POST /cap?ctx=${ctx}&cap=itx.bla body=ping-through-tunnel`);
  expect(res.headers.get("x-upstream")).toBe("localhost-http");
});

// ─────────────────────── 2. the WS half — GREEN since capnweb 0.12.2 ───────────────────────
// History: pinned RED until the fork blessed the sender-side answer (the CLI held both working
// halves — the platform delivered the upgrade Request, Node's WS client reached localhost — but
// no spelling could stitch them: no WebSocketPair, undici rejects status 101). Now ONE call.

test("WS tunnel: an eyeball WebSocket on itx.bla opens (101), echoes off the LOCALHOST server, and closes clean", async () => {
  const ctx = c("ws");
  await provideTunnel(ctx);

  const ws = await wsRoundTrip(capUrl(ctx, "ws"), "hello-through-tunnel");
  console.log("[tunnel] ws round trip:", JSON.stringify(ws));
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("local-echo:hello-through-tunnel");
  expect(ws.closeCode).toBe(1000);
});
