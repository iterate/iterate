// AppRunner — per-app runtime extracted from Project DO.
// Reads manifest + modules from Project DO via RPC, creates dynamic worker,
// forwards requests to the App facet.

import { DurableObject } from "cloudflare:workers";
import { PLATFORM_SUFFIX } from "./host-parser.ts";

interface Env {
  PROJECT: DurableObjectNamespace;
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

// Extract app name from host (platform suffix only — custom domains resolved by worker)
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

    // Get Project DO stub — the AppRunner was created with idFromName(slug),
    // so we use the same ID to reach the Project DO
    const projectId = this.env.PROJECT.idFromName(
      // Derive slug from host: <app>.<slug>.iterate-dev-jonas.app
      host.slice(app.length + 1, -PLATFORM_SUFFIX.length),
    );
    const project = this.env.PROJECT.get(projectId) as unknown as ProjectStub;
    const slug = await project.slug;

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

    // Create/retrieve App facet via dynamic worker
    const ctx = this.ctx as any;
    const facet = ctx.facets.get(`app:${app}:${sourceHash}`, async () => {
      const worker = this.env.LOADER.get(`code:${app}:${sourceHash}`, async () => ({
        compatibilityDate: "2026-04-01",
        compatibilityFlags: appCompatFlags,
        mainModule,
        modules,
        globalOutbound: this.env.EGRESS_GATEWAY,
        env: { AI: this.env.AI_PROXY, EXEC: this.env.CODE_EXECUTOR },
      }));
      return { class: (worker as any).getDurableObjectClass("App") };
    });

    console.log(`[AppRunner] forwarding to App facet`);
    return facet.fetch(req);
  }
}
