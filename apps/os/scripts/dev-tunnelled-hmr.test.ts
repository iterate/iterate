// dev-tunnelled-hmr.test.ts — the local OS's `pnpm dev` (`vite dev` with @cloudflare/vite-plugin)
// hands a Vite dev server's HMR socket behind a tunnel to the Worker, as a deployed or built OS does.
//
// Behind a tunnel the page's HMR socket arrives at the platform's dev server under the tunnel's
// path (`/projects/<project>/<name>/`), asking for Vite's client's subprotocol, `vite-hmr`. The
// dev server's own HMR serves `vite-hmr` only at its own base, so this socket is the Worker's.
// The plugin's upgrade handler returns before forwarding any upgrade whose protocol starts with
// `vite`, so nothing answers it and the page's `[vite] connecting…` never connects
// (apps/notes/README.md). The row serves a Worker that answers every upgrade, with no platform, so
// it goes red the day the plugin forwards the socket; the README's caveat goes with the wrapper.

import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { createServer } from "vite";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { COMPATIBILITY_DATE } from "../../../scripts/lib/wrangler-config.ts";

createFailing(test, /left the vite-hmr upgrade unanswered/)(
  "@cloudflare/vite-plugin: vite dev hands the Worker a vite-hmr WebSocket outside Vite's own HMR base",
  async () => {
    await using dev = await viteDevServingAWorker();
    const tunnelled = new URL("/projects/acme/notes-dev/?token=the-notes-dev-token", dev.origin);
    // The Worker answers an upgrade at the tunnel's path; the first one also loads its module.
    expect(await upgrade(tunnelled, ["chat"])).toEqual({
      protocol: "chat",
      reply: "the worker heard ping at /projects/acme/notes-dev/",
    });
    const hmr = await upgrade(tunnelled, ["vite-hmr"]);
    if (hmr === "unanswered") {
      throw new Error(
        `@cloudflare/vite-plugin left the vite-hmr upgrade unanswered: no handshake within ${UNANSWERED_AFTER_MS}ms`,
      );
    }
    expect(hmr).toEqual({
      protocol: "vite-hmr",
      reply: "the worker heard ping at /projects/acme/notes-dev/",
    });
  },
);

/** A dropped upgrade is never answered, so this negative wait outlasts a forwarded one: the warm
 *  Worker answers a forwarded upgrade in about ten milliseconds (measured 2026-09-27). */
const UNANSWERED_AFTER_MS = 2_000;

/** A Worker that accepts every WebSocket upgrade with the first subprotocol it was offered, as the
 *  platform hands back the one a tunnel's local server chose, and answers each message with where
 *  it arrived. */
const WORKER = `
export default {
  fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("the worker");
    const { pathname } = new URL(request.url);
    const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0].trim();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) =>
      server.send("the worker heard " + event.data + " at " + pathname),
    );
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: protocol ? { "sec-websocket-protocol": protocol } : {},
    });
  },
};
`;

/** `vite dev` with the Cloudflare plugin, as the OS's `pnpm dev` runs it, serving WORKER. */
async function viteDevServingAWorker() {
  const directory = temporaryDirectory();
  await writeFile(join(directory.path, "worker.js"), WORKER);
  const vite = await createServer({
    root: directory.path,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, watch: null },
    plugins: [
      cloudflare({
        config: { name: "fixture", main: "./worker.js", compatibility_date: COMPATIBILITY_DATE },
        persistState: false,
        inspectorPort: false,
      }),
    ],
  });
  await vite.listen();
  const { port } = vite.httpServer!.address() as AddressInfo;
  return {
    origin: `ws://127.0.0.1:${port}`,
    async [Symbol.asyncDispose]() {
      await vite.close();
      directory[Symbol.dispose]();
    },
  };
}

/** Open a WebSocket to `url` offering `protocols`, send `ping`, and return the subprotocol the 101
 *  named with the first reply — or "unanswered" when no handshake arrives in UNANSWERED_AFTER_MS. */
async function upgrade(url: URL, protocols: string[]) {
  const socket = new WebSocket(url, protocols);
  try {
    return await new Promise<{ protocol: string; reply: string } | "unanswered">(
      (resolve, reject) => {
        const unanswered = setTimeout(() => resolve("unanswered"), UNANSWERED_AFTER_MS);
        socket.on("open", () => {
          clearTimeout(unanswered);
          socket.send("ping");
        });
        socket.on("message", (data) => resolve({ protocol: socket.protocol, reply: String(data) }));
        socket.on("unexpected-response", (_, response) =>
          reject(new Error(`the upgrade was refused: ${response.statusCode}`)),
        );
        socket.on("error", reject);
      },
    );
  } finally {
    socket.terminate();
  }
}
