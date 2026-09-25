// tunnel.test.ts — the tunnel's local proxy, `LocalPortRpcTarget`, against real local servers: what
// the project host's request becomes on `localhost:<port>`, a WebSocket that keeps the subprotocol
// the local server chose, and the 502 when nothing listens; and `runTunnel` refusing a private
// tunnel where projects are served under paths. The platform half (the route, the host,
// the lent stub) is apps/os e2e/tunnel.e2e.test.ts.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import { LocalPortRpcTarget, randomRoutingSlug, runTunnel } from "./tunnel.ts";

test("HTTP: path, query, method, headers and body reach localhost:<port>, with the visitor's host as x-forwarded-host; a redirect is handed back; a gzipped body arrives decoded", async () => {
  const seen: {
    method?: string;
    url?: string;
    headers?: IncomingMessage["headers"];
    body?: string;
  }[] = [];
  await using server = await listen(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.url === "/moved") {
      response.writeHead(302, { location: "/elsewhere" }).end();
      return;
    }
    if (request.url === "/gzipped") {
      response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("unzipped"));
      return;
    }
    response.writeHead(201, { "x-local": "yes" }).end(`echo ${body}`);
  });
  const target = new LocalPortRpcTarget(server.port);

  const response = await target.fetch(
    new Request("https://blog--acme.iterate.app/a/b?c=d", {
      method: "POST",
      body: "hello",
      headers: { "x-custom": "1", cookie: "app=1" },
    }),
  );
  expect({
    status: response.status,
    local: response.headers.get("x-local"),
    text: await response.text(),
  }).toEqual({ status: 201, local: "yes", text: "echo hello" });
  expect(seen[0]).toMatchObject({
    method: "POST",
    url: "/a/b?c=d",
    body: "hello",
    headers: {
      host: `localhost:${server.port}`,
      "x-custom": "1",
      cookie: "app=1",
      "x-forwarded-host": "blog--acme.iterate.app",
      "x-forwarded-proto": "https",
    },
  });

  const moved = await target.fetch(new Request("https://blog--acme.iterate.app/moved"));
  expect({ status: moved.status, location: moved.headers.get("location") }).toEqual({
    status: 302,
    location: "/elsewhere",
  });

  // paths routing: the base the edge stripped is put back
  await target.fetch(
    new Request("https://os.example/src/main.ts", {
      headers: { "x-iterate-base-path": "/projects/acme/blog" },
    }),
  );
  expect(seen.at(-1)).toMatchObject({ url: "/projects/acme/blog/src/main.ts" });

  // a path that looks like an authority stays a path on localhost
  await target.fetch(new Request("https://blog--acme.iterate.app//127.0.0.1:1/x"));
  expect(seen.at(-1)).toMatchObject({
    url: "//127.0.0.1:1/x",
    headers: { host: `localhost:${server.port}` },
  });

  const gzipped = await target.fetch(new Request("https://blog--acme.iterate.app/gzipped"));
  expect({
    encoding: gzipped.headers.get("content-encoding"),
    text: await gzipped.text(),
  }).toEqual({ encoding: null, text: "unzipped" });
});

test("nothing listening on the port: a 502 naming it", async () => {
  const port = await freePort();
  const response = await new LocalPortRpcTarget(port).fetch(
    new Request("https://blog--acme.iterate.app/"),
  );
  expect(response).toMatchObject({ status: 502 });
  expect(await response.text()).toContain(`localhost:${port}`);
  const upgrade = await new LocalPortRpcTarget(port).fetch(
    new Request("https://blog--acme.iterate.app/", { headers: { upgrade: "websocket" } }),
  );
  expect(upgrade).toMatchObject({ status: 502 });
});

test("WebSocket: the requested subprotocols reach the local server, its choice names the 101, its greeting is not lost, frames flow both ways, and a close crosses", async () => {
  await using server = await listen((_request, response) => response.end("http"));
  const wss = new WebSocketServer({
    server: server.server,
    handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false),
  });
  // disposed before the server: an upgraded socket holds `server.close` open
  using _wss = {
    [Symbol.dispose]: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
  const serverSaw: { protocols?: string; forwardedHost?: string; closeCode?: number }[] = [];
  const serverClosed = new Promise<number>((resolve) =>
    wss.on("connection", (socket, request) => {
      serverSaw.push({
        protocols: request.headers["sec-websocket-protocol"],
        forwardedHost: request.headers["x-forwarded-host"] as string,
      });
      socket.send('{"type":"connected"}'); // Vite's HMR server greets at once
      socket.on("message", (data, isBinary) =>
        socket.send(isBinary ? data : `local-echo:${data.toString()}`, { binary: isBinary }),
      );
      socket.on("close", (code) => resolve(code));
    }),
  );

  const response = await new LocalPortRpcTarget(server.port).fetch(
    new Request("https://blog--acme.iterate.app/?token=abc", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "vite-hmr, vite-ping" },
    }),
  );
  expect(response.headers.get("sec-websocket-protocol")).toBe("vite-hmr");
  const visitor = (response as Response & { webSocket: VisitorSocket }).webSocket;
  const frames: unknown[] = [];
  const threeFrames = new Promise<void>((resolve) =>
    visitor.addEventListener("message", (event) => {
      frames.push(typeof event.data === "string" ? event.data : [...new Uint8Array(event.data)]);
      if (frames.length === 3) resolve();
    }),
  );
  visitor.accept();
  visitor.send("ping");
  visitor.send(new Uint8Array([1, 2, 3]));
  await threeFrames;
  expect(frames).toEqual(['{"type":"connected"}', "local-echo:ping", [1, 2, 3]]);
  expect(serverSaw).toEqual([
    { protocols: "vite-hmr,vite-ping", forwardedHost: "blog--acme.iterate.app" },
  ]);
  visitor.close(1000, "done");
  expect(await serverClosed).toBe(1000);
});

test("a random routing slug is a letter and seven letters or digits", () => {
  for (let i = 0; i < 50; i++) expect(randomRoutingSlug()).toMatch(/^[a-z][a-z0-9]{7}$/);
});

// Under paths routing the tunnel lives under a base path: private and public tunnels are both set,
// and the tunnel says where it lives and what the local server must do.
test.for([
  ["paths", "private"],
  ["paths", "public"],
  ["subdomains", "private"],
  ["subdomains", "public"],
] as const)("a %s deployment, a %s tunnel", async ([routing, visibility]) => {
  const url =
    routing === "paths"
      ? "https://os.example.com/projects/p/blog/"
      : "https://blog--p.example.com/";
  const calls: string[] = [];
  const project = {
    url: async () => url,
    fetchRoutes: {
      list: async () => [],
      set: async (name: string, route: unknown) =>
        void calls.push(`set ${name} ${route && "route"}`),
    },
    provide: async (target: string) => {
      calls.push(`provide ${target}`);
      return { [Symbol.dispose]: () => {} };
    },
    [Symbol.dispose]: () => {},
  };
  const connection = {
    session: { projects: { get: async () => project } },
    // the tunnel ends as soon as it is live: the connection is already closed
    closed: Promise.resolve({ code: 1006, reason: "" }),
  } as unknown as Parameters<typeof runTunnel>[0]["connection"];
  using stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = runTunnel({
    connection,
    project: "p",
    port: 5173,
    routingSlug: "blog",
    public: visibility === "public",
  });
  await expect(run).rejects.toThrow("The tunnel disconnected");
  expect(calls).toEqual([
    "provide itx.tunnels.blog",
    "set tunnel-blog route",
    "set tunnel-blog null",
  ]);
  const underPaths =
    "This deployment serves projects under paths, so this tunnel lives at https://os.example.com/projects/p/blog/. Your local server must serve under /projects/p/blog/ (Vite: --base /projects/p/blog/); a server that only works at / will not work here. To serve at the root of its own origin, give the deployment a domain with a wildcard certificate: https://github.com/iterate/iterate/blob/main/apps/os/SELF-HOSTING.md#custom-domain-own-origins-for-apps-and-tunnels";
  expect(stderr.mock.calls.some(([line]) => line === underPaths)).toBe(routing === "paths");
});

type VisitorSocket = {
  accept(): void;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string | ArrayBuffer }) => void,
  ): void;
};

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number; [Symbol.asyncDispose](): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
