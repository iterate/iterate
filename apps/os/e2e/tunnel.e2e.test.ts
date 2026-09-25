// tunnel.e2e.test.ts — `iterate tunnel <port>` against the deployment, the CLI run as a person runs
// it (the package's bin, operator credentials) and a tiny HTTP + WebSocket server on a local port.
// The project is a fresh one on the default template, so its config worker is the template's router
// (configs/default/worker.ts: `itx.fetchRoutes.match`, then `env.ITX.fetch` to the route's target).
// Pins:
//   • private (the default): an anonymous page load is sent to sign in, an anonymous fetch is 401,
//     under paths (a per-PR preview) as under subdomains
//   • public: HTTP reaches the local server; a WebSocket asking for `vite-hmr` opens with it, echoes
//   • a context reset (what every deploy does) leaves the WebSocket open, nothing lost
//   • Ctrl-C deletes the route: the host is the template's own 404 again
//   • a tunnel killed outright closes a visitor's WebSocket at once, 1001 "tunnel disconnected",
//     and its route goes with its lend: the host is the template's own 404 again
//   • a restart sets its route again, and Ctrl-C deletes it
//   • a visitor whose connection vanishes without a close frame (a tab closed, a laptop gone):
//     the local server's socket closes within seconds, so nothing keeps streaming through the
//     platform
// The proxy's own behaviour (headers, bodies, frames) is packages/cli src/tunnel.test.ts; the route
// and the subprotocol through the platform, e2e/fetch-routes.e2e.test.ts.

import { execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { adminCredentials, session, until, untilValue, workerUrl } from "./support/client.ts";
import { issuerCookie } from "./support/principal.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  ingressRouting,
  navigateProjectUrl,
  projectHostsAreLocal,
  projectUrlSocket,
  registerProject,
  wsRoundTripOnProjectUrl,
} from "./support/project-host.ts";

const bin = fileURLToPath(new URL("../../../packages/cli/bin/iterate.js", import.meta.url).href);

test(
  "iterate tunnel: private by default (under paths a member reaches its page, assets and WebSocket), public on --public (HTTP and a vite-hmr WebSocket), Ctrl-C deletes the route, a killed tunnel's host is 404",
  // Each CLI process connects and sets a route (a few seconds each against a preview): three of them.
  { timeout: 90_000 },
  async () => {
    await using local = await localServer();
    const slug = freshDnsSafeProjectSlug("tunnel");
    const member = { email: `${slug}@example.com` };
    const projectId = await registerProject(slug, member);
    const itx = session().authenticate(adminCredentials()).projects.get(projectId);
    await itx.waitForEvent({
      type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
      afterOffset: 0,
      timeoutMs: 60_000,
    });
    await using cli = await cliConfig();

    // private (the default): the route's authRequirement, under paths as under subdomains — an
    // anonymous page load goes to sign in, a fetch is 401
    const privateTunnel = cli.tunnel([String(local.port), "--name", "web", "--project", projectId]);
    const privateUrl = new URL(await privateTunnel.url);
    const navigation = await navigateProjectUrl(privateUrl, {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    expect(navigation).toMatchObject({ status: 302 });
    expect(navigation.headers.location).toContain("/.auth/login");
    expect(await fetchProjectUrl(privateUrl)).toMatchObject({ status: 401 });
    if (ingressRouting()?.type === "paths") {
      // under paths a member's platform cookie is the tunnel's: the page, a nested asset, and a
      // same-origin WebSocket all reach the local server
      const signedIn = {
        cookie: await issuerCookie(member.email),
        origin: new URL(workerUrl("/")).origin,
      };
      const base = privateUrl.href.endsWith("/") ? privateUrl.href : `${privateUrl.href}/`;
      for (const url of [new URL(base), new URL("assets/app.js", base)])
        expect(await fetchProjectUrl(url, signedIn)).toMatchObject({
          status: 200,
          text: `local ${url.pathname}`,
        });
      const socket = await projectUrlSocket(new URL(base), signedIn);
      const echo = await new Promise<string>((resolve, reject) => {
        socket.addEventListener("open", () => socket.send("member"));
        socket.addEventListener("message", (event) => resolve(String(event.data)));
        socket.addEventListener("error", () => reject(new Error("the WebSocket did not open")));
      });
      socket.close(1000, "done");
      expect(echo).toBe("local-echo:member");
    }
    expect(await privateTunnel.stop("SIGINT")).toBe(0);
    expect(await itx.fetchRoutes.list()).toEqual([]);
    expect(await fetchProjectUrl(privateUrl)).toMatchObject({
      status: 404,
      text: "Not found\n",
    });

    // public
    const publicTunnel = cli.tunnel([
      String(local.port),
      "--name",
      "web",
      "--public",
      "--project",
      projectId,
    ]);
    // relative: under paths routing the tunnel's base is `/projects/<project>/web/`, which the
    // local server sees too (it serves under that base)
    const url = await publicTunnel.url;
    const publicUrl = new URL("hello", url.endsWith("/") ? url : `${url}/`);
    expect(await fetchProjectUrl(publicUrl)).toMatchObject({
      status: 200,
      text: `local ${publicUrl.pathname}`,
    });
    expect(await wsRoundTripOnProjectUrl(publicUrl, "ping", 15_000, ["vite-hmr"])).toMatchObject({
      opened: true,
      protocol: "vite-hmr",
      echo: "local-echo:ping",
      closeCode: 1000,
    });

    // a context reset — what every deploy does to every Durable Object — cuts the context's sockets;
    // the visitor's socket outlives it (context/fetch-upgrade-splice.ts)
    expect(
      await echoesAcrossContextReset(publicUrl, () => itx.abort("a deploy's reset, on demand")),
    ).toEqual({
      echoes: ["local-echo:before", "local-echo:across", "local-echo:after"],
      closeCode: null,
    });

    // killed outright: a visitor's socket closes at once — the relay knows its provider is gone —
    // and the route and the rule its target named go with the lend, though the CLI deleted nothing
    const visitor = await openSocket(publicUrl);
    const killedAt = Date.now();
    await publicTunnel.stop("SIGKILL");
    const visitorClosed = await visitor.closed;
    expect({ ...visitorClosed, afterMs: visitorClosed.at - killedAt }).toMatchObject({
      code: 1001,
      reason: "tunnel disconnected",
      afterMs: expect.toSatisfy((ms: number) => ms < 2_000),
    });
    expect(
      await untilValue(
        "the killed tunnel's route is gone",
        () => itx.fetchRoutes.list() as Promise<unknown[]>,
        (routes) => routes.length === 0,
        { timeoutMs: 10_000 },
      ),
    ).toEqual([]);
    expect(await fetchProjectUrl(publicUrl)).toMatchObject({ status: 404, text: "Not found\n" });

    // a restart sets its route again; then Ctrl-C deletes it and the host is the template's own
    // 404 again
    const again = cli.tunnel([
      String(local.port),
      "--name",
      "web",
      "--public",
      "--project",
      projectId,
    ]);
    await again.url;
    expect(await fetchProjectUrl(publicUrl)).toMatchObject({ status: 200 });
    expect(await again.stop("SIGINT")).toBe(0);
    expect(await itx.fetchRoutes.list()).toEqual([]);
    expect(await fetchProjectUrl(publicUrl)).toMatchObject({ status: 404, text: "Not found\n" });
  },
);

test(
  "iterate tunnel: a visitor whose connection vanishes without a close frame ends the local server's socket within seconds",
  { timeout: 60_000 },
  async () => {
    await using local = await localServer();
    const slug = freshDnsSafeProjectSlug("tunnel-drop");
    const projectId = await registerProject(slug);
    const itx = session().authenticate(adminCredentials()).projects.get(projectId);
    await itx.waitForEvent({
      type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
      afterOffset: 0,
      timeoutMs: 60_000,
    });
    await using cli = await cliConfig();
    const tunnel = cli.tunnel([
      String(local.port),
      "--name",
      "clock",
      "--public",
      "--project",
      projectId,
    ]);
    const url = await tunnel.url;
    const clockUrl = new URL("clock", url.endsWith("/") ? url : `${url}/`);

    const visitor = await rawVisitorSocket(clockUrl);
    await until("the clock ticks reach the visitor", () => visitor.bytesReceived() > 20, 15_000);
    expect(local.clockSockets()).toMatchObject({ open: 1, closed: [] });

    // the visitor's TCP connection is gone: no close frame, no FIN handshake
    const droppedAt = Date.now();
    visitor.destroy();
    await until("the local server's socket closed", () => local.clockSockets().open === 0, 20_000);
    const [closed] = local.clockSockets().closed;
    expect({ ...closed, afterMs: closed!.at - droppedAt }).toMatchObject({
      afterMs: expect.toSatisfy((ms: number) => ms < 10_000),
    });
    expect(await tunnel.stop("SIGINT")).toBe(0);
  },
);

/** A visitor's WebSocket to `url` over a bare TCP (or TLS) connection — the handshake written by
 *  hand, so `destroy()` drops it the way a closed tab or a vanished network does: no close frame. */
async function rawVisitorSocket(url: URL) {
  const local = projectHostsAreLocal();
  const worker = new URL(workerUrl("/"));
  const port = local ? Number(worker.port) : 443;
  const host = local ? worker.hostname : url.hostname;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connected: Socket = local
      ? connect({ host, port }, () => resolve(connected))
      : tlsConnect({ host, port, servername: url.hostname }, () => resolve(connected));
    connected.once("error", reject);
  });
  let bytes = 0;
  let head = "";
  socket.on("data", (chunk: Uint8Array) => {
    if (!head.includes("\r\n\r\n")) head += new TextDecoder("latin1").decode(chunk);
    else bytes += chunk.byteLength;
  });
  socket.on("error", () => undefined);
  socket.write(
    [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  await until("the 101", () => head.includes("\r\n\r\n"), 15_000);
  expect(head.split("\r\n")[0]).toContain("101");
  return { bytesReceived: () => bytes, destroy: () => socket.destroy() };
}

/** A WebSocket held open on `url`: one echo, then `reset()`, then two more sent across it — the
 *  echoes it saw, and the close code if the socket closed before it was done. */
async function echoesAcrossContextReset(url: URL, reset: () => Promise<unknown>) {
  const socket = projectUrlSocket(url);
  const echoes: string[] = [];
  let closeCode: number | null = null;
  socket.addEventListener("message", (event) => echoes.push(String(event.data)));
  socket.addEventListener("close", (event) => (closeCode = event.code));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the WebSocket did not open")));
  });
  socket.send("before");
  await until("the echo before the reset", () => echoes.length === 1 || closeCode !== null);
  await reset();
  socket.send("across");
  socket.send("after");
  await until(
    "the echoes after the reset",
    () => echoes.length === 3 || closeCode !== null,
    // the ends re-dial the reset context and resume: a second or two on a preview
    20_000,
  );
  socket.close(1000, "done");
  return { echoes, closeCode };
}

/** A WebSocket open on `url`, and when and how it closed. */
async function openSocket(url: URL) {
  const socket = projectUrlSocket(url);
  const closed = new Promise<{ code: number; reason: string; at: number }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason, at: Date.now() }),
    ),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the WebSocket did not open")));
  });
  return { closed };
}

/** The local server a tunnel serves: `local <path>` over HTTP, and a WebSocket choosing `vite-hmr`
 *  that echoes — or, at `…/clock`, sends a tick every 100 ms and records when it closes. */
async function localServer() {
  const server = createServer((request, response) => response.end(`local ${request.url}`));
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false),
  });
  const clock = { open: 0, closed: [] as { code: number; at: number }[] };
  wss.on("connection", (socket, request) => {
    if (!request.url?.endsWith("/clock")) {
      socket.on("message", (data) => socket.send(`local-echo:${data.toString()}`));
      return;
    }
    clock.open += 1;
    const tick = setInterval(() => socket.send(`tick ${Date.now()}`), 100);
    socket.on("close", (code) => {
      clearInterval(tick);
      clock.open -= 1;
      clock.closed.push({ code, at: Date.now() });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    clockSockets: () => ({ open: clock.open, closed: [...clock.closed] }),
    [Symbol.asyncDispose]: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A CLI config pointing at the worker under test, the operator's credentials in the environment,
 *  and `tunnel(args)`: the bin running `iterate tunnel …`, the URL it prints on stdout awaited. */
async function cliConfig() {
  const directory = await mkdtemp(join(tmpdir(), "iterate-tunnel-e2e-"));
  await mkdir(join(directory, "iterate"));
  await writeFile(
    join(directory, "iterate/config.json"),
    JSON.stringify({ default: "e2e", configs: { e2e: { osBaseUrl: workerUrl("/") } } }),
  );
  const children: ChildProcess[] = [];
  return {
    tunnel(args: string[]) {
      const child = execFile(process.execPath, [bin, "tunnel", ...args], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: directory,
          APP_CONFIG_ADMIN_API_SECRET: adminCredentials().secret,
          ITERATE_BEARER_TOKEN: "",
        },
      });
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const url = new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once("line", resolve);
        void exited.then((code) =>
          reject(new Error(`iterate tunnel exited ${code} before it printed its URL: ${stderr}`)),
        );
      });
      return {
        url,
        stop: (signal: "SIGINT" | "SIGKILL") => {
          child.kill(signal);
          return exited;
        },
      };
    },
    [Symbol.asyncDispose]: async () => {
      for (const child of children) child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
