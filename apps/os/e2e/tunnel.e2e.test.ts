// tunnel.e2e.test.ts — `iterate tunnel <port>` against the deployment, the CLI run as a person runs
// it (the package's bin, operator credentials) and a tiny HTTP + WebSocket server on a local port.
// The project is a fresh one on the default template, so its config worker is the template's router
// (configs/default/worker.ts: `itx.fetchRoutes.match`, then `env.ITX.fetch`). Pins:
//   • private (the default): an anonymous page load is sent to sign in, an anonymous fetch is 401,
//     under paths (a per-PR preview) as under subdomains
//   • public: HTTP reaches the local server; a WebSocket asking for `vite-hmr` opens with it, echoes
//   • a context reset (what every deploy does) leaves the WebSocket open, nothing lost
//   • Ctrl-C deletes the route: the host is the template's own 404 again
//   • a tunnel killed outright closes a visitor's WebSocket at once, 1001 "tunnel disconnected",
//     and leaves its route standing and answering 502, "not connected", with
//     `x-iterate-fetch-route-offline` naming the route
// The proxy's own behaviour (headers, bodies, frames) is packages/cli src/tunnel.test.ts; the route
// and the subprotocol through the platform, e2e/fetch-routes.e2e.test.ts.

import { execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { adminCredentials, session, until, untilValue, workerUrl } from "./support/client.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  navigateProjectUrl,
  projectUrlSocket,
  registerProject,
  wsRoundTripOnProjectUrl,
} from "./support/project-host.ts";

const bin = fileURLToPath(new URL("../../../packages/cli/bin/iterate.js", import.meta.url).href);

test(
  "iterate tunnel: private by default, public on --public (HTTP and a vite-hmr WebSocket), Ctrl-C deletes the route, a killed tunnel is 502",
  // Each CLI process connects and sets a route (a few seconds each against a preview): three of them.
  { timeout: 90_000 },
  async () => {
    await using local = await localServer();
    const slug = freshDnsSafeProjectSlug("tunnel");
    const projectId = await registerProject(slug);
    const itx = session().authenticate(adminCredentials()).projects.get(projectId);
    await itx.waitForEvent({
      type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
      afterOffset: 0,
      timeoutMs: 60_000,
    });
    await using cli = await cliConfig();

    // private (the default): the route's authRequirement, under paths as under subdomains — an
    // anonymous page load goes to sign in and back to the full path, a fetch is 401
    const privateTunnel = cli.tunnel([String(local.port), "--name", "web", "--project", projectId]);
    const privateUrl = new URL((await privateTunnel.live).url);
    const navigation = await navigateProjectUrl(privateUrl, {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    expect(navigation).toMatchObject({ status: 302 });
    expect(navigation.headers.location).toContain(
      `/.auth/login?next=${encodeURIComponent(privateUrl.pathname)}`,
    );
    expect(await fetchProjectUrl(privateUrl)).toMatchObject({ status: 401 });
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
    const { url } = await publicTunnel.live;
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
    // nothing deletes the route, and its target is not connected
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
        "the killed tunnel answers 502",
        () => fetchProjectUrl(publicUrl),
        (page) => page.status === 502,
        { timeoutMs: 30_000 },
      ),
    ).toMatchObject({
      status: 502,
      headers: { "x-iterate-fetch-route-offline": "tunnel-web" },
      text: "tunnel-web is not connected\n",
    });

    // run again, then Ctrl-C: the route is deleted and the host is the template's own 404 again
    const again = cli.tunnel([
      String(local.port),
      "--name",
      "web",
      "--public",
      "--project",
      projectId,
    ]);
    await again.live;
    expect(await again.stop("SIGINT")).toBe(0);
    expect(await itx.fetchRoutes.list()).toEqual([]);
    expect(await fetchProjectUrl(publicUrl)).toMatchObject({ status: 404, text: "Not found\n" });
  },
);

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
 *  that echoes. */
async function localServer() {
  const server = createServer((request, response) => response.end(`local ${request.url}`));
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false),
  });
  wss.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(`local-echo:${data.toString()}`)),
  );
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    [Symbol.asyncDispose]: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A CLI config pointing at the worker under test, the operator's credentials in the environment,
 *  and `tunnel(args)`: the bin running `iterate tunnel … --json`, its `live` line awaited. */
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
      const child = execFile(process.execPath, [bin, "tunnel", ...args, "--json"], {
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
      const live = new Promise<{ url: string }>((resolve, reject) => {
        createInterface({ input: child.stdout! }).on("line", (line) => {
          const event = JSON.parse(line) as { type: string; url: string };
          if (event.type === "live") resolve(event);
        });
        void exited.then((code) =>
          reject(new Error(`iterate tunnel exited ${code} before it was live: ${stderr}`)),
        );
      });
      return {
        live,
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
