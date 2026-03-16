import { createAdaptorServer } from "@hono/node-server";
import app, { injectWebSocket } from "./api/app.ts";
import { getWsTest2ServiceEnv, wsTest2ServiceManifest } from "./manifest.ts";

const env = getWsTest2ServiceEnv();
const server = createAdaptorServer({ fetch: app.fetch });
const host = env.HOST ?? "0.0.0.0";
const port = env.PORT ?? 3000;

injectWebSocket(server);

server.listen(port, host, () => {
  console.log(`${wsTest2ServiceManifest.displayName} backend listening on http://${host}:${port}`);
});
