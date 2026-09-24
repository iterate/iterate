// tunnel.e2e.test.ts — `iterate tunnel <port>` against the deployment, the CLI run as a person runs
// it (the package's bin, operator credentials) and a tiny HTTP + WebSocket server on a local port.
// The project is a fresh one on the default template, so its config worker is the template's router
// (configs/default/worker.ts: `itx.ingressRoutes.match`, then `env.ITX.fetch`). Pins:
//   • private (the default): an anonymous page load is sent to sign in, an anonymous fetch is 401;
//     refused outright where projects are served under paths (a per-PR preview)
//   • public: HTTP reaches the local server; a WebSocket asking for `vite-hmr` opens with it, echoes
//   • Ctrl-C deletes the route: the host is the template's own 404 again
//   • a tunnel killed outright leaves its route standing and answering 502, "not connected", with
//     `x-iterate-ingress-route-offline` naming the route
// The proxy's own behaviour (headers, bodies, frames) is packages/cli src/tunnel.test.ts; the route
// and the subprotocol through the platform, e2e/ingress-routes.e2e.test.ts.

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
import { adminCredentials, session, untilValue, workerUrl } from "./support/client.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  ingressRouting,
  navigateProjectUrl,
  registerProject,
  wsRoundTripOnProjectUrl,
} from "./support/project-host.ts";

const bin = fileURLToPath(new URL("../../../packages/cli/bin/iterate.js", import.meta.url).href);

test(
  "iterate tunnel: private by default (refused under paths), public on --public (HTTP and a vite-hmr WebSocket), Ctrl-C deletes the route, a killed tunnel is 502",
  // Each CLI process connects and sets a route (a few seconds each against a preview); under paths
  // the private one is refused at once, so a preview runs two full ones.
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

    // private (the default). Under paths routing it is refused before anything is set: the
    // tunnel's pages run sandboxed on the platform's origin, where no cookie reaches a subresource.
    const privateTunnel = cli.tunnel([String(local.port), "--name", "web", "--project", projectId]);
    if (ingressRouting()?.type === "paths") {
      await expect(privateTunnel.live).rejects.toThrow("Private tunnels need their own origin");
      expect(await itx.ingressRoutes.list()).toEqual([]);
    } else {
      const privateUrl = new URL((await privateTunnel.live).url);
      const navigation = await navigateProjectUrl(privateUrl, {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      });
      expect(navigation).toMatchObject({ status: 302 });
      expect(navigation.headers.location).toContain("/.auth/login");
      expect(await fetchProjectUrl(privateUrl)).toMatchObject({ status: 401 });
      expect(await privateTunnel.stop("SIGINT")).toBe(0);
      expect(await itx.ingressRoutes.list()).toEqual([]);
      expect(await fetchProjectUrl(privateUrl)).toMatchObject({
        status: 404,
        text: "Not found\n",
      });
    }

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

    // killed outright: nothing deletes the route, and its target is not connected
    await publicTunnel.stop("SIGKILL");
    expect(
      await untilValue(
        "the killed tunnel answers 502",
        () => fetchProjectUrl(publicUrl),
        (page) => page.status === 502,
        { timeoutMs: 30_000 },
      ),
    ).toMatchObject({
      status: 502,
      headers: { "x-iterate-ingress-route-offline": "tunnel-web" },
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
    expect(await itx.ingressRoutes.list()).toEqual([]);
    expect(await fetchProjectUrl(publicUrl)).toMatchObject({ status: 404, text: "Not found\n" });
  },
);

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
