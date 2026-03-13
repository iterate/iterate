import { createNodeWebSocket } from "@hono/node-ws";
import { daemonServiceManifest } from "@iterate-com/daemon-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceOpenAPIHandler,
  initializeServiceEvlog,
  initializeServiceOtel,
  type ServiceAppEnv,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { createPtyRouter } from "./pty.ts";
import { daemonRouter } from "./router.ts";

const serviceName = "jonasland-daemon";

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const app = new Hono<ServiceAppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);

const openAPIHandler = createServiceOpenAPIHandler({
  router: daemonRouter,
  title: "jonasland daemon API",
  version: daemonServiceManifest.version,
});

app.route("/api/pty", createPtyRouter({ upgradeWebSocket }));
applyOpenAPIRoute(app, openAPIHandler, serviceName);

export default app;
export { injectWebSocket };
