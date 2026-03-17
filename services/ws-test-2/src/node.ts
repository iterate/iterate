import { createAdaptorServer } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "./api/app.ts";
import { createPtyRouter } from "./api/pty.ts";
import { getWsTest2ServiceEnv, wsTest2ServiceManifest } from "./manifest.ts";

const env = getWsTest2ServiceEnv();
const { app, injectWebSocket } = await createApp<
  HttpBindings,
  ReturnType<typeof createNodeWebSocket>
>({
  env,
  createWebSocketRuntime: (app) => createNodeWebSocket({ app }),
  createPtyApp: ({ upgradeWebSocket }) =>
    createPtyRouter({
      upgradeWebSocket,
    }),
});

const server = createAdaptorServer({ fetch: app.fetch });
const host = env.HOST ?? "0.0.0.0";
const port = env.PORT ?? 3000;

injectWebSocket(server);

server.listen(port, host, () => {
  console.log(`${wsTest2ServiceManifest.displayName} backend listening on http://${host}:${port}`);
});
