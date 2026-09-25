// serve-localhost-example.e2e.test.ts — examples/serve-localhost.mjs, `iterate tunnel` without the
// CLI, run as a reader runs it (`node serve-localhost.mjs <origin> <project> <routingSlug> <port>`,
// the operator's credentials in the environment) against the deployment, with a tiny HTTP +
// WebSocket server on a local port. The project is a fresh one on the default template, so its
// config worker is the template's router (configs/default/worker.ts). Pins:
//   • the URL it prints reaches the local server over HTTP, the visitor's path as-is (under paths
//     routing the platform strips the base, so the local server sees the same path either way),
//     the body uncompressed (a local server that gzips whatever the request accepts is not asked to)
//   • a WebSocket asking for `vite-hmr` opens with it and echoes
//   • SIGINT deletes the route: the host is the template's own 404 again

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { adminCredentials, session, workerUrl } from "./support/client.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  registerProject,
  wsRoundTripOnProjectUrl,
} from "./support/project-host.ts";

const example = fileURLToPath(new URL("../examples/serve-localhost.mjs", import.meta.url).href);

test(
  "examples/serve-localhost.mjs: the printed URL reaches the local server (HTTP and a vite-hmr WebSocket), SIGINT deletes the route",
  // one capnweb session that lends and sets a route: a few seconds against a preview
  { timeout: 60_000 },
  async () => {
    await using local = await localServer();
    const slug = freshDnsSafeProjectSlug("serve-localhost");
    const projectId = await registerProject(slug);
    const itx = session().authenticate(adminCredentials()).projects.get(projectId);
    await itx.waitForEvent({
      type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
      afterOffset: 0,
      timeoutMs: 60_000,
    });
    const child = execFile(
      process.execPath,
      [example, new URL(workerUrl("/")).origin, slug, "web", String(local.port)],
      {
        env: {
          ...process.env,
          APP_CONFIG_ADMIN_API_SECRET: adminCredentials().secret,
          ITERATE_BEARER_TOKEN: "",
        },
      },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once("line", resolve);
        void exited.then((code) =>
          reject(new Error(`the example exited ${code} before it printed its URL: ${stderr}`)),
        );
      });
      const hello = new URL("hello", url.endsWith("/") ? url : `${url}/`);
      expect(await fetchProjectUrl(hello)).toMatchObject({ status: 200, text: "local /hello" });
      expect(await wsRoundTripOnProjectUrl(hello, "ping", 15_000, ["vite-hmr"])).toMatchObject({
        opened: true,
        protocol: "vite-hmr",
        echo: "local-echo:ping",
      });

      child.kill("SIGINT");
      expect(await exited).toBe(0);
      expect(await itx.fetchRoutes.list()).toEqual([]);
      expect(await fetchProjectUrl(hello)).toMatchObject({ status: 404, text: "Not found\n" });
    } finally {
      child.kill("SIGKILL");
    }
  },
);

/** The local server: `local <path>` over HTTP (gzipped when the request accepts it), and a
 *  WebSocket choosing `vite-hmr` that echoes. */
async function localServer() {
  const server = createServer((request, response) => {
    const body = `local ${request.url}`;
    if (!/gzip/.test(request.headers["accept-encoding"] ?? "")) return response.end(body);
    response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(body));
  });
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
