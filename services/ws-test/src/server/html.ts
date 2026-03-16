import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ViteManifestChunk {
  file: string;
  assets?: string[];
  css?: string[];
}

type ViteManifest = Record<string, ViteManifestChunk>;

let cachedProdAppCssHrefs: string[] | null = null;

export function isProductionRuntime() {
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

export function renderAppShell() {
  const isProd = isProductionRuntime();
  const cssLinks = isProd
    ? getProdAppCssHrefs()
        .map((href) => `<link rel="stylesheet" href="${href}" data-app-css="1" />`)
        .join("")
    : "";

  const devPreamble = !isProd
    ? `<script type="module">
      import RefreshRuntime from "/@react-refresh"
      RefreshRuntime.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => {}
      window.$RefreshSig$ = () => (type) => type
      window.__vite_plugin_react_preamble_installed__ = true
    </script>
    <script type="module" src="/@vite/client"></script>`
    : "";

  const clientScript = isProd
    ? `<script type="module" src="/static/entry-client.js"></script>`
    : `<script type="module" src="/src/entry-client.tsx"></script>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ws-test</title>
    ${cssLinks}
    ${devPreamble}
    ${clientScript}
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;
}
