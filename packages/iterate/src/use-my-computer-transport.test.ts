import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { openSocketBridge, proxyLocalHttp, stripHopByHop } from "./use-my-computer-transport.ts";

// Direct tests for the two transports behind `iterate use-my-computer` — the
// HTTP reverse proxy and the WebSocket frame bridge — with real local servers,
// no OS/capnweb round trip. The e2e proves they compose through the platform;
// this proves the fiddly bits (header fidelity, redirect rewriting, the 502
// boundary, and the bridge's callback-dispose ordering) in isolation.

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function startHttp(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server: Server = createServer(handler);
  closers.push(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

function startWs(onConnection: (socket: import("ws").WebSocket) => void): Promise<number> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", onConnection);
  closers.push(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  return new Promise((resolve) =>
    wss.once("listening", () => resolve((wss.address() as AddressInfo).port)),
  );
}

describe("proxyLocalHttp", () => {
  test("proxies body, sets x-forwarded-host, strips hop-by-hop, drops stale framing", async () => {
    const port = await startHttp((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        // `connection` is hop-by-hop; node sets a correct content-length that the
        // proxy still drops (undici may have decompressed the buffered body, so
        // the framing headers are stale on the hop back).
        res.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" });
        res.end(`seen:${req.headers["x-forwarded-host"]}:${Buffer.concat(chunks).toString()}`);
      });
    });
    const request = new Request("https://slug.iterate.app/echo?q=1", {
      method: "POST",
      headers: { connection: "keep-alive", "x-keep": "yes" },
      body: "hello",
    });
    const response = await proxyLocalHttp(`http://127.0.0.1:${port}`, request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("seen:slug.iterate.app:hello");
    // hop-by-hop + stale framing stripped on the way back
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  test("refuses websocket upgrades with a teaching error", async () => {
    const request = new Request("https://slug.iterate.app/ws", {
      headers: { upgrade: "websocket" },
    });
    await expect(proxyLocalHttp("http://127.0.0.1:1", request)).rejects.toThrow(
      /cannot carry a WebSocket upgrade/,
    );
  });

  test("returns 502 when the local server is unreachable", async () => {
    // Port 1 is not listening; the connection is refused.
    const response = await proxyLocalHttp(
      "http://127.0.0.1:1",
      new Request("https://slug.iterate.app/"),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("unreachable");
  });

  test("returns 502 when the server resets mid-body", async () => {
    const port = await startHttp((req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      // Destroy the socket before the promised body arrives.
      req.socket.destroy();
    });
    const response = await proxyLocalHttp(
      `http://127.0.0.1:${port}`,
      new Request("https://slug.iterate.app/"),
    );
    expect(response.status).toBe(502);
  });

  test("rewrites a loopback Location onto the public origin — and respects the port boundary", async () => {
    const port = await startHttp((_req, res) => {
      // Redirect back to the local origin; must land on the public host.
      res.writeHead(302, { location: `http://127.0.0.1:${port}/login?next=/` });
      res.end();
    });
    const response = await proxyLocalHttp(
      `http://127.0.0.1:${port}`,
      new Request("https://slug.iterate.app/protected"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://slug.iterate.app/login?next=/");
  });

  test("does not rewrite a Location to a different port that shares a prefix", async () => {
    // origin :3000 must not match a Location on :30001 (the startsWith bug).
    const port = await startHttp((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:30001/elsewhere" });
      res.end();
    });
    const response = await proxyLocalHttp(
      `http://127.0.0.1:${port}`,
      new Request("https://slug.iterate.app/"),
    );
    // The proxied origin is `port` (random), not 30001, so the Location is left alone.
    expect(response.headers.get("location")).toBe("http://127.0.0.1:30001/elsewhere");
  });

  test("gives HEAD a null body and keeps its content-length metadata", async () => {
    const port = await startHttp((_req, res) => {
      res.writeHead(200, { "content-length": "512", "content-type": "text/html" });
      res.end(); // HEAD: no body
    });
    const response = await proxyLocalHttp(
      `http://127.0.0.1:${port}`,
      new Request("https://slug.iterate.app/", { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    // bodyless response keeps its representation metadata (not stripped)
    expect(response.headers.get("content-length")).toBe("512");
  });
});

describe("stripHopByHop", () => {
  test("removes the standard set plus any header named by Connection", async () => {
    const headers = new Headers({
      connection: "x-custom, keep-alive",
      "x-custom": "drop-me",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "content-type": "text/plain",
    });
    stripHopByHop(headers);
    expect(headers.get("x-custom")).toBeNull();
    expect(headers.get("keep-alive")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("content-type")).toBe("text/plain");
  });
});

describe("openSocketBridge", () => {
  test("delivers frames to onMessage and round-trips send", async () => {
    const port = await startWs((socket) => {
      socket.send("hello");
      socket.on("message", (d) => socket.send(`echo:${String(d)}`));
    });
    const received: string[] = [];
    const bridge = await openSocketBridge({
      port,
      onMessage: (data) => {
        received.push(data);
      },
    });
    await bridge.send("ping");
    await vi_waitFor(() => received.includes("echo:ping"));
    expect(received).toContain("hello");
    expect(received).toContain("echo:ping");
    await bridge.close();
  });

  test("send after close rejects", async () => {
    const port = await startWs(() => {});
    const bridge = await openSocketBridge({ port });
    await bridge.close();
    await vi_waitFor(async () => {
      try {
        await bridge.send("nope");
        return false;
      } catch {
        return true;
      }
    });
  });

  test("delivers onClose BEFORE disposing the retained callback (round-2 blocker)", async () => {
    // A callback stub that tracks dup/dispose and whether it was ever called
    // after disposal — the exact hazard: a deferred onClose running against an
    // already-released stub.
    let disposed = false;
    let calledAfterDispose = false;
    let closeInfo: unknown;
    const onClose = Object.assign(
      (info: unknown) => {
        if (disposed) calledAfterDispose = true;
        closeInfo = info;
      },
      {
        dup() {
          return onClose;
        },
        [Symbol.dispose]() {
          disposed = true;
        },
      },
    );

    const port = await startWs((socket) => socket.close(1000, "bye"));
    const bridge = await openSocketBridge({ port, onClose });
    await vi_waitFor(() => disposed); // shutdown ran after the server closed us
    expect(closeInfo).toMatchObject({ code: 1000 });
    expect(calledAfterDispose).toBe(false);
    await bridge.close();
  });
});

/** Tiny poll helper (vitest's expect.poll would also work; this keeps deps local). */
async function vi_waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
