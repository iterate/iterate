import { createAdaptorServer } from "@hono/node-server";
import app, { injectWebSocket } from "./api/app.ts";
import { getWsTest2ServiceEnv, wsTest2ServiceManifest } from "./manifest.ts";

const env = getWsTest2ServiceEnv();
const server = createAdaptorServer({ fetch: app.fetch });

injectWebSocket(server);

server.listen(env.PORT, env.HOST, () => {
  console.log(
    `${wsTest2ServiceManifest.displayName} backend listening on http://${env.HOST}:${env.PORT}`,
  );
});
