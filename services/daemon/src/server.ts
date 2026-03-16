import { createAdaptorServer } from "@hono/node-server";
import { daemonServiceManifest } from "@iterate-com/daemon-contract";
import { registerServiceWithRegistry } from "@iterate-com/shared/jonasland";
import app, { injectWebSocket } from "./server/app.ts";

const port = Number(process.env.PORT) || daemonServiceManifest.port;

const server = createAdaptorServer({ fetch: app.fetch });
injectWebSocket(server);

server.listen(port, "0.0.0.0", () => {
  console.log(`daemon listening on http://localhost:${port}`);
  void registerServiceWithRegistry({
    manifest: daemonServiceManifest,
    port,
    metadata: { openapiPath: "/api/openapi.json", title: "Daemon Service" },
    tags: ["openapi", "daemon", "terminal"],
  });
});
