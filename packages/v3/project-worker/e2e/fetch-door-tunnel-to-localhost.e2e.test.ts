// fetch-door-tunnel-to-localhost.e2e.test.ts — the TUNNEL use case (`iterate tunnel bla 3000`): a
// CLI — a plain NODE capnweb client on /api — lends a fetch-shaped rpc stub behind the rewrite rule
// `itx.bla` and PROXIES every request to a server on localhost. `itx.bla.fetch(req)` anywhere in the
// project reaches the CLI and comes back carrying localhost's answer — WEBSOCKET UPGRADES INCLUDED: the CLI
// dials its localhost WS client and answers with the one-call `upgradeWebSocketResponse(localSocket)`
// (capnweb ≥0.12.2, the sender-side upgrade answer; docs/capnweb-upgrade-answer.md). The frames
// tunnel over the session's existing stream pipes.

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget, upgradeWebSocketResponse } from "capnweb";
import { expressionUrl, freshCtx, openItx, wsRoundTrip } from "./support/client.ts";

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
afterAll(() => {
  localHttp?.server.close();
  localWs?.server.close();
});

// ── the CLI side: the tunnel provider ──

/** What `iterate tunnel` runs: fetch-shaped, proxies to localhost. The HTTP branch re-mints the
 *  upstream answer; the upgrade branch dials the localhost WS client and answers with
 *  `upgradeWebSocketResponse` — capnweb's own tunnel is the frame bridge. */
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

test("HTTP tunnel: an eyeball POST to itx.bla rides through the Node CLI provider to localhost and back, bodies intact both ways", async () => {
  const ctx = freshCtx("tunnelhttp");
  await openItx(ctx).provide("itx.bla", { stub: new TunnelProvider(), rewrite: "itx.bla" }); // the CLI's exact posture

  const res = await fetch(expressionUrl(ctx, "itx.bla", "http"), {
    method: "POST",
    body: "ping-through-tunnel",
  });
  const body = await res.text();
  expect(res.status).toBe(200);
  // localhost's own words prove the REQUEST crossed the tunnel (path+query intact), not just
  // that a response came back:
  expect(body).toBe(
    `upstream-saw:POST /expression?context=${ctx}&itx=itx.bla body=ping-through-tunnel`,
  );
  expect(res.headers.get("x-upstream")).toBe("localhost-http");
});

test("WS tunnel: an eyeball WebSocket on itx.bla opens (101), echoes off the LOCALHOST server, and closes clean", async () => {
  const ctx = freshCtx("tunnelws");
  await openItx(ctx).provide("itx.bla", { stub: new TunnelProvider(), rewrite: "itx.bla" });

  const ws = await wsRoundTrip(expressionUrl(ctx, "itx.bla", "ws"), "hello-through-tunnel");
  expect(ws.error).toBeUndefined();
  expect(ws.opened).toBe(true);
  expect(ws.echo).toBe("local-echo:hello-through-tunnel");
  expect(ws.closeCode).toBe(1000);
});
