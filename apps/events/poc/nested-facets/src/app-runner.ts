// AppRunner — per-app runtime extracted from Project DO.
// Reads manifest + modules from Project DO via RPC, creates dynamic worker,
// forwards requests to the App facet.
// Provides env.ASSETS (R2 client assets) and env.STORAGE (R2 app storage) to apps.

import { DurableObject } from "cloudflare:workers";
import { PLATFORM_SUFFIX } from "./host-parser.ts";

interface Env {
  PROJECT: DurableObjectNamespace;
  WORKSPACE_R2: R2Bucket;
  LOADER: WorkerLoader;
  EGRESS_GATEWAY: Fetcher;
  AI_PROXY: Fetcher;
  CODE_EXECUTOR: Fetcher;
}

interface ProjectStub {
  readFile(path: string): Promise<string | null>;
  readonly slug: string;
}

function egressRuntimeWrapper(projectSlug: string): string {
  return `
;(function() {
  var _originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function(input, init) {
    var request = new Request(input, init);
    var headers = new Headers(request.headers);
    headers.set("x-iterate-project-slug", ${JSON.stringify(projectSlug)});
    return _originalFetch(new Request(request, { headers: headers }));
  };
})();
`;
}

function parseApp(host: string): string | null {
  if (!host.endsWith(PLATFORM_SUFFIX)) return null;
  const prefix = host.slice(0, -PLATFORM_SUFFIX.length);
  const dot = prefix.indexOf(".");
  return dot !== -1 ? prefix.slice(0, dot) : null;
}

export class AppRunner extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.hostname;
    const app = parseApp(host);

    if (!app) {
      return new Response("AppRunner: cannot derive app from host", { status: 400 });
    }

    // Get Project DO stub for file reads
    const slugFromHost = host.slice(app.length + 1, -PLATFORM_SUFFIX.length);
    const projectId = this.env.PROJECT.idFromName(slugFromHost);
    const project = this.env.PROJECT.get(projectId) as unknown as ProjectStub;
    const slug = await project.slug;
    const doId = projectId.toString();

    // Read app build config
    const appPkgStr = await project.readFile(`apps/${app}/package.json`);
    const appPkg = appPkgStr ? JSON.parse(appPkgStr) : {};
    const appBuildConfig = appPkg.buildConfig ?? {};
    const appCompatFlags: string[] = appBuildConfig.compatibilityFlags ?? [];

    // Read manifest
    const manifestStr = await project.readFile(`apps/${app}/dist/manifest.json`);
    if (!manifestStr) {
      return new Response(`App "${app}" has no dist — needs building`, { status: 404 });
    }

    const meta = JSON.parse(manifestStr);

    // Load modules from dist via Project DO
    const modules: Record<string, string> = {};
    for (const f of meta.moduleFiles) {
      const content = await project.readFile(`apps/${app}/dist/${f}`);
      if (content) modules[f] = content;
    }

    const mainModule: string = meta.mainModule;
    if (!modules[mainModule]) {
      return new Response(`App ${app} missing main module: ${mainModule}`, { status: 500 });
    }

    // Prepend egress runtime wrapper
    modules[mainModule] = egressRuntimeWrapper(slug) + modules[mainModule];

    // Compute source hash for cache key
    const hashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(modules[mainModule])),
    );
    const sourceHash = Array.from(hashBytes.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    console.log(
      `[AppRunner] app=${app} mainModule=${mainModule} hash=${sourceHash} modules=${Object.keys(modules).join(",")}`,
    );

    // R2 prefixes for scoped access
    const assetsPrefix = `${doId}/app/${app}/dist/client/`;
    const storagePrefix = `${doId}/app/${app}/`;

    // Create/retrieve App facet via dynamic worker
    const ctx = this.ctx as any;
    const facet = ctx.facets.get(`app:${app}:${sourceHash}`, async () => {
      const worker = this.env.LOADER.get(`code:${app}:${sourceHash}`, async () => ({
        compatibilityDate: "2026-04-01",
        compatibilityFlags: appCompatFlags,
        mainModule,
        modules,
        globalOutbound: this.env.EGRESS_GATEWAY,
        env: {
          AI: this.env.AI_PROXY,
          EXEC: this.env.CODE_EXECUTOR,
          ASSETS: ctx.exports.R2BucketProxy({ props: { prefix: assetsPrefix } }),
          STORAGE: ctx.exports.R2BucketProxy({ props: { prefix: storagePrefix } }),
        },
      }));
      return { class: (worker as any).getDurableObjectClass("App") };
    });

    // Serve client assets from R2 directly (apps don't need to implement this)
    if (url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
      const assetKey = assetsPrefix + url.pathname.replace(/^\/+/, "");
      const obj = await this.env.WORKSPACE_R2.get(assetKey);
      if (obj) {
        const ext = url.pathname.split(".").pop()?.toLowerCase() ?? "";
        const ct =
          {
            js: "application/javascript",
            css: "text/css",
            html: "text/html;charset=utf-8",
            json: "application/json",
            svg: "image/svg+xml",
            png: "image/png",
            jpg: "image/jpeg",
            woff2: "font/woff2",
          }[ext] ?? "application/octet-stream";
        const cc = /[-\.][A-Za-z0-9_-]{6,}\.\w+$/.test(url.pathname)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600";
        console.log(`[AppRunner] served asset from R2: ${url.pathname}`);
        return new Response(obj.body, {
          headers: { "content-type": ct, "cache-control": cc, etag: obj.httpEtag },
        });
      }
    }

    // SPA fallback: serve index.html from R2 for non-file, non-API paths
    if (!url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
      const indexKey = assetsPrefix + "index.html";
      const indexObj = await this.env.WORKSPACE_R2.get(indexKey);
      if (indexObj) {
        console.log(`[AppRunner] SPA fallback from R2: ${url.pathname} → index.html`);
        return new Response(indexObj.body, {
          headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
        });
      }
    }

    console.log(`[AppRunner] forwarding to App facet`);
    return facet.fetch(req);
  }
}
