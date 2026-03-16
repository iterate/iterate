import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { serviceLog } from "@iterate-com/shared/jonasland";
import app, {
  injectWebSocket,
  store,
  env,
  serviceName,
  getOtelRuntimeConfig,
  ensureSeededRoutes,
  ensureInitialCaddySynchronization,
} from "./server/app.ts";

export async function startRegistryService(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const host = options?.host ?? env.REGISTRY_SERVICE_HOST;
  const port = options?.port ?? env.REGISTRY_SERVICE_PORT;
  const server = createAdaptorServer({ fetch: app.fetch });
  injectWebSocket(server);

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  await ensureSeededRoutes({ store, env });
  await ensureInitialCaddySynchronization({ store, env });

  serviceLog.info({
    event: "service.started",
    service: serviceName,
    host,
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    orpc_path: "/orpc",
    orpc_ws_path: "/orpc/ws",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await store.close();
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startRegistryService().catch(() => {
    process.exit(1);
  });
}
