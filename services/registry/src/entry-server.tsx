import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import {
  createRequestHandler,
  RouterServer,
  renderRouterToString,
} from "@tanstack/react-router/ssr/server";
import app, { injectWebSocket } from "./server/app.ts";
import { getEnv } from "./server/context.ts";
import { createRouter } from "./router.tsx";

interface ViteManifestChunk {
  file: string;
  assets?: string[];
  css?: string[];
}

type ViteManifest = Record<string, ViteManifestChunk>;

let cachedProdAppCssHrefs: string[] | null = null;

function isProductionRuntime() {
  return import.meta.env?.PROD ?? process.env.NODE_ENV === "production";
}

function getProdAppCssHrefs() {
  if (cachedProdAppCssHrefs) {
    return cachedProdAppCssHrefs;
  }

  try {
    const manifestPath = resolve(process.cwd(), "dist/client/.vite/manifest.json");
    const rawManifest = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(rawManifest) as ViteManifest;
    const entry = manifest["src/entry-client.tsx"];

    if (!entry) {
      cachedProdAppCssHrefs = [];
      return cachedProdAppCssHrefs;
    }

    const cssFiles = new Set<string>();
    for (const href of entry.css ?? []) {
      if (href.endsWith(".css")) cssFiles.add(href);
    }
    for (const href of entry.assets ?? []) {
      if (href.endsWith(".css")) cssFiles.add(href);
    }

    cachedProdAppCssHrefs = Array.from(cssFiles).map((file) =>
      file.startsWith("/") ? file : `/${file}`,
    );
    return cachedProdAppCssHrefs;
  } catch {
    cachedProdAppCssHrefs = [];
    return cachedProdAppCssHrefs;
  }
}

function getAppCssHrefs() {
  if (isProductionRuntime()) {
    return getProdAppCssHrefs();
  }

  return ["/src/styles.css"];
}

if (isProductionRuntime()) {
  app.use(compress());
  app.use(
    "/*",
    serveStatic({
      root: "./dist/client",
    }),
  );
}

app.use("*", async (c) => {
  const requestHandler = createRequestHandler({
    request: c.req.raw,
    createRouter: () =>
      createRouter({
        appCssHrefs: getAppCssHrefs(),
      }),
  });

  return await requestHandler(({ responseHeaders, router }) => {
    return renderRouterToString({
      responseHeaders,
      router,
      children: <RouterServer router={router} />,
    });
  });
});

if (process.env.NODE_ENV === "production") {
  const env = getEnv();
  const host = env.REGISTRY_SERVICE_HOST;
  const port = process.env.PORT?.trim() ? Number(process.env.PORT) : env.REGISTRY_SERVICE_PORT;
  const server = createAdaptorServer({ fetch: app.fetch });
  injectWebSocket(server);
  server.listen(port, host, () => {
    console.log(`registry listening on http://${host}:${port}`);
  });
}

export default app;
