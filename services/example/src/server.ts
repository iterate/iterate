import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceObservabilityHandler,
  createServiceOpenAPIHandler,
  initializeServiceEvlog,
  initializeServiceOtel,
  registerServiceWithRegistry,
  type ServiceAppEnv,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { createServer as createViteServer, searchForWorkspaceRoot } from "vite";
import { getExampleDbRuntimeConfig, initializeExampleDb } from "./db.ts";
import { exampleRouter } from "./router.ts";

const serviceName = "jonasland-example";
const viteServiceRoot = fileURLToPath(new URL("..", import.meta.url));
const viteUiRoot = fileURLToPath(new URL("./ui", import.meta.url));
const viteUiIndexHtmlPath = fileURLToPath(new URL("./ui/index.html", import.meta.url));
const viteUiPackageRoot = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url));
const viteUiGlobalsCss = `${viteUiPackageRoot}/styles/globals.css`;
const port = Number(process.env.PORT) || exampleServiceManifest.port;

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const openAPIHandler = createServiceOpenAPIHandler({
  router: exampleRouter,
  title: "jonasland example API",
  version: exampleServiceManifest.version,
});

const app = new Hono<ServiceAppEnv>();
applyServiceMiddleware(app);

app.get("/api/observability", createServiceObservabilityHandler(getExampleDbRuntimeConfig));

app.get("/", async (c) => {
  const html = await readFile(viteUiIndexHtmlPath, "utf8");
  return c.html(html);
});

app.all("/api/echo", async (c) => {
  const request = c.req.raw;
  const bodyText = await request.clone().text();
  return c.json({
    method: request.method,
    url: request.url,
    host: request.headers.get("host") ?? "",
    headers: Object.fromEntries(request.headers.entries()),
    body: bodyText,
  });
});

applyOpenAPIRoute(app, openAPIHandler, serviceName);

await initializeExampleDb();

const vite = await createViteServer({
  configFile: false,
  root: viteUiRoot,
  cacheDir: "/tmp/vite-example",
  resolve: {
    alias: [
      { find: "@iterate-com/ui/globals.css", replacement: viteUiGlobalsCss },
      { find: "@iterate-com/ui/styles.css", replacement: viteUiGlobalsCss },
      {
        find: "@iterate-com/ui/components",
        replacement: `${viteUiPackageRoot}/components`,
      },
      { find: "@iterate-com/ui/lib", replacement: `${viteUiPackageRoot}/lib` },
      { find: "@iterate-com/ui/hooks", replacement: `${viteUiPackageRoot}/hooks` },
      { find: "@iterate-com/ui", replacement: `${viteUiPackageRoot}/index.ts` },
    ],
  },
  plugins: [tailwindcss(), react()],
  appType: "spa",
  server: {
    middlewareMode: true,
    fs: {
      strict: false,
      allow: ["/", searchForWorkspaceRoot(viteServiceRoot), viteUiRoot, viteUiPackageRoot],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**"],
    },
  },
});

app.use("*", async (c) => {
  await new Promise<void>((resolve) => {
    vite.middlewares(c.env.incoming, c.env.outgoing, () => {
      if (!c.env.outgoing.writableEnded) {
        c.env.outgoing.writeHead(404, { "content-type": "application/json" });
        c.env.outgoing.end(JSON.stringify({ error: "not_found" }));
      }
      resolve();
    });
  });

  return RESPONSE_ALREADY_SENT;
});

const server = createAdaptorServer({ fetch: app.fetch });
server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  const boundPort = address && typeof address === "object" ? (address as AddressInfo).port : port;
  void registerServiceWithRegistry({
    manifest: exampleServiceManifest,
    port: boundPort,
    metadata: { openapiPath: "/api/openapi.json", title: "Example Service" },
    tags: ["openapi", "example"],
  });
});
