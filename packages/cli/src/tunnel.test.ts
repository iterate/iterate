// tunnel.test.ts — the tunnel's local proxy, `LocalPortRpcTarget`, against real local servers: what
// the project host's request becomes on `localhost:<port>`, a WebSocket that keeps the subprotocol
// the local server chose, and the 502 when nothing listens; and the route `runTunnel` sets. The
// platform half (the route, the host, the lent stub) is apps/os e2e/tunnel.e2e.test.ts.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import { LocalPortRpcTarget, runTunnel } from "./tunnel.ts";

test("HTTP: path, query, method, headers and body reach localhost:<port>; a redirect is handed back; a gzipped body arrives decoded", async () => {
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
  const serverSaw: { protocols?: string }[] = [];
  const serverClosed = new Promise<number>((resolve) =>
    wss.on("connection", (socket, request) => {
      serverSaw.push({ protocols: request.headers["sec-websocket-protocol"] });
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
  expect(serverSaw).toEqual([{ protocols: "vite-hmr,vite-ping" }]);
  visitor.close(1000, "done");
  expect(await serverClosed).toBe(1000);
});

// The route's authRequirement says private or public; under paths the tunnel names the base path
// the local server must serve under.
test.for([
  ["paths", "private"],
  ["subdomains", "public"],
] as const)("a %s deployment, a %s tunnel", async ([routing, visibility]) => {
  const url =
    routing === "paths"
      ? "https://os.example.com/projects/p/blog/"
      : "https://blog--p.example.com/";
  const fake = fakeProject(url);
  using stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  using stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const run = runTunnel({
    // the tunnel ends as soon as it is live: the connection is already closed, and no reconnect
    connection: fake.connection(Promise.resolve({ code: 1006, reason: "" })),
    reconnect: () => Promise.reject(new Error("unreachable")),
    reconnectDelaysMs: [],
    project: "p",
    port: 5173,
    routingSlug: "blog",
    public: visibility === "public",
  });
  await expect(run).rejects.toThrow("The tunnel disconnected and could not reconnect");
  expect(fake).toMatchObject({ calls: ["provide itx.tunnels.blog with route tunnel-blog"] });
  expect(fake.routes[0]).toMatchObject({
    authRequirement: visibility === "public" ? null : { visitors: "project-members" },
  });
  expect(stdout.mock).toMatchObject({ calls: [[url]] });
  const basePathLines = stderr.mock.calls.filter(
    ([line]) => !String(line).includes(url) && String(line).includes("/projects/p/blog/"),
  );
  expect(basePathLines).toHaveLength(routing === "paths" ? 1 : 0);
});

// A connection that closes under a live tunnel (its heartbeat found the network gone — a laptop
// asleep, a NAT mapping expired) is replaced: the tunnel reconnects and lends and routes again, and
// says so; a failed attempt is tried again on the schedule, and only when every attempt fails does
// it end, with an error. 2026-09-25: a tunnel sat 55 minutes on a dead connection, unaware.
test("a tunnel whose connection closes reconnects, lends and routes again; it ends only when every attempt fails", async () => {
  const fake = fakeProject("https://blog--p.example.com/");
  using stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  using _stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  let dropSecond!: () => void;
  const reconnects = [
    () => Promise.reject(new Error("getaddrinfo ENOTFOUND os.example.com")), // Wi-Fi not back yet
    async () =>
      fake.connection(
        new Promise((resolve) => (dropSecond = () => resolve({ code: 1006, reason: "gone" }))),
      ),
  ];
  const run = runTunnel({
    connection: fake.connection(Promise.resolve({ code: 1006, reason: "no answer to a ping" })),
    reconnect: () => {
      const next = reconnects.shift();
      if (!next) return Promise.reject(new Error("still offline"));
      const connection = next();
      void connection.then(
        () => setTimeout(() => dropSecond(), 5),
        () => undefined,
      );
      return connection;
    },
    reconnectDelaysMs: [0, 0],
    project: "p",
    port: 5173,
    routingSlug: "blog",
  });
  await expect(run).rejects.toThrow(
    "The tunnel disconnected and could not reconnect (still offline)",
  );
  expect(fake).toMatchObject({
    calls: [
      "provide itx.tunnels.blog with route tunnel-blog",
      "provide itx.tunnels.blog with route tunnel-blog",
    ],
    disposedConnections: 2,
  });
  expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([
    expect.stringContaining("Press Ctrl-C to stop."),
    "The tunnel disconnected (1006: no answer to a ping). Reconnecting...",
    "Could not reconnect: getaddrinfo ENOTFOUND os.example.com",
    "Reconnected: https://blog--p.example.com/ → http://localhost:5173",
    "The tunnel disconnected (1006: gone). Reconnecting...",
    "Could not reconnect: still offline",
    "Could not reconnect: still offline",
  ]);
});

/** A project whose routes and lends are recorded, reached over connections that close when `closed`
 *  resolves (each counts its disposal). */
function fakeProject(url: string) {
  const fake = {
    calls: [] as string[],
    routes: [] as unknown[],
    disposedConnections: 0,
    connection: (closed: Promise<{ code: number; reason: string }>) =>
      ({
        session: { projects: { get: async () => project } },
        closed,
        [Symbol.dispose]: () => void (fake.disposedConnections += 1),
      }) as unknown as Parameters<typeof runTunnel>[0]["connection"],
  };
  const project = {
    url: async () => url,
    fetchRoutes: {
      list: async () => [],
      set: async (name: string, route: unknown) => {
        fake.calls.push(`set ${name} ${route && "route"}`);
        fake.routes.push(route);
      },
    },
    provide: async (
      target: string,
      _stub: unknown,
      options: { fetchRoute: { fetchRouteName: string } },
    ) => {
      fake.calls.push(`provide ${target} with route ${options.fetchRoute.fetchRouteName}`);
      fake.routes.push(options.fetchRoute);
      return { [Symbol.dispose]: () => {} };
    },
    [Symbol.dispose]: () => {},
  };
  return fake;
}

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
