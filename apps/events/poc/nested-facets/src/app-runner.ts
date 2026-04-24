// AppRunner — standalone per-app DO with own R2-backed Workspace.
// Clones the artifact repo, serves assets, runs dynamic worker facets.
// Project DO just forwards fetch() here — no facets in the Project DO.

import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { inferContentType, cacheHeaders } from "./content-types.ts";

interface Env {
  WORKSPACE_R2: R2Bucket;
  LOADER: WorkerLoader;
  EGRESS_GATEWAY: Fetcher;
  AI_PROXY: Fetcher;
  CODE_EXECUTOR: Fetcher;
  ARTIFACTS: any;
}

const REPO_DIR = "/repo";

export class AppRunner extends DurableObject<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.WORKSPACE_R2,
    name: () => `runner-${this.ctx.id}`,
  });
  fs = new WorkspaceFileSystem(this.workspace);
  git = createGit(this.fs, REPO_DIR);

  // In-memory caches (survive within a single DO activation)
  #metaReady = false;
  #cloned = false;
  #needsSync = false;
  #remote: string | null = null;
  #repoName: string | null = null;
  #app: string | null = null;

  // ── Meta table ──────────────────────────────────────────────────────

  #ensureMetaTable() {
    if (this.#metaReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.#metaReady = true;
  }

  #getMeta(key: string): string | null {
    this.#ensureMetaTable();
    const rows = this.ctx.storage.sql.exec("SELECT value FROM _meta WHERE key = ?", key).toArray();
    return rows.length > 0 ? (rows[0].value as string) : null;
  }

  #setMeta(key: string, value: string) {
    this.#ensureMetaTable();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  // Lazy-load meta into memory (once per activation)
  #loadMeta() {
    if (this.#remote !== null) return;
    this.#remote = this.#getMeta("remote");
    this.#repoName = this.#getMeta("repo_name");
    this.#app = this.#getMeta("app");
    this.#needsSync = this.#getMeta("needs_sync") === "1";
  }

  // ── RPC methods called by Project DO ────────────────────────────────

  async setup(remote: string, repoName: string, app: string) {
    this.#loadMeta();
    if (this.#remote === remote && this.#app === app) return; // Already set up
    this.#setMeta("remote", remote);
    this.#setMeta("repo_name", repoName);
    this.#setMeta("app", app);
    this.#remote = remote;
    this.#repoName = repoName;
    this.#app = app;
    console.log(`[AppRunner] setup: app=${app} repo=${repoName}`);
    this.ctx.waitUntil(this.#ensureSync());
  }

  async notifyBuild() {
    this.#setMeta("needs_sync", "1");
    this.#needsSync = true;
    console.log(`[AppRunner] notifyBuild: flagged for sync`);
  }

  // ── Sync logic ──────────────────────────────────────────────────────

  async #ensureSync() {
    this.#loadMeta();
    if (!this.#remote || !this.#repoName) return;

    if (!this.#cloned) {
      const hasGit = await this.workspace.exists(`${REPO_DIR}/.git/config`);
      if (!hasGit) {
        console.log(`[AppRunner] cloning ${this.#repoName}...`);
        const token = await this.#getToken();
        await this.workspace.mkdir(REPO_DIR, { recursive: true });
        await this.git.clone({
          url: this.#remote,
          dir: REPO_DIR,
          ...this.#gitAuth(token),
        });
        this.#cloned = true;
        this.#needsSync = false;
        this.#setMeta("needs_sync", "0");
        console.log(`[AppRunner] clone complete`);
        return;
      }
      this.#cloned = true;
    }

    if (this.#needsSync) {
      console.log(`[AppRunner] pulling latest...`);
      const token = await this.#getToken();
      try {
        await this.git.pull({
          dir: REPO_DIR,
          remote: "origin",
          ref: "main",
          author: { name: "AppRunner", email: "runner@iterate.com" },
          ...this.#gitAuth(token),
        });
        console.log(`[AppRunner] pull complete`);
      } catch (e: any) {
        console.error(`[AppRunner] pull failed: ${e.message}`);
      }
      this.#needsSync = false;
      this.#setMeta("needs_sync", "0");
    }
  }

  async #getToken(): Promise<string> {
    const repo = await this.env.ARTIFACTS.get(this.#repoName!);
    const result = await repo.createToken("read", 3600);
    return result.plaintext ?? result.token ?? String(result);
  }

  #gitAuth(token: string) {
    if (!token || typeof token !== "string") return { username: "x", password: "" };
    return { username: "x", password: token.split("?expires=")[0] };
  }

  // ── Request handling ────────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    await this.#ensureSync();
    this.#loadMeta();

    const app = this.#app;
    if (!app) return new Response("AppRunner: not set up (no app)", { status: 500 });

    const url = new URL(req.url);

    // Read manifest
    const manifestStr = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/dist/manifest.json`);
    if (!manifestStr) {
      return new Response(`App "${app}" has no dist — needs building`, { status: 404 });
    }
    const meta = JSON.parse(manifestStr);

    // ── Asset serving ─────────────────────────────────────────────────
    if (url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
      const cleanPath = url.pathname.replace(/^\/+/, "");
      for (const dir of ["dist/client/", "dist/assets/", "dist/"]) {
        const content = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/${dir}${cleanPath}`);
        if (content !== null) {
          return new Response(content, {
            headers: {
              "content-type": inferContentType(url.pathname),
              "cache-control": cacheHeaders(url.pathname),
            },
          });
        }
      }
    }

    // ── SPA fallback ──────────────────────────────────────────────────
    if (!url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
      for (const dir of ["dist/client/", "dist/assets/", "dist/"]) {
        const content = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/${dir}index.html`);
        if (content !== null) {
          return new Response(content, {
            headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
          });
        }
      }
    }

    // ── Dynamic worker (API routes, SSR) ──────────────────────────────
    return this.#dispatchToFacet(app, meta, req);
  }

  async #dispatchToFacet(
    app: string,
    meta: { mainModule: string; moduleFiles: string[] },
    req: Request,
  ): Promise<Response> {
    const modules: Record<string, string> = {};
    for (const f of meta.moduleFiles) {
      const content = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/dist/${f}`);
      if (content) modules[f] = content;
    }

    const mainModule = meta.mainModule;
    if (!modules[mainModule]) {
      return new Response(`App ${app} missing main module: ${mainModule}`, { status: 500 });
    }

    const appPkgStr = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/package.json`);
    const appCompatFlags: string[] = appPkgStr
      ? (JSON.parse(appPkgStr).buildConfig?.compatibilityFlags ?? [])
      : [];

    const hashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(modules[mainModule])),
    );
    const sourceHash = Array.from(hashBytes.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const ctx = this.ctx as any;
    const facet = ctx.facets.get(`app:${sourceHash}`, async () => {
      const worker = this.env.LOADER.get(`code:${sourceHash}`, async () => ({
        compatibilityDate: "2026-04-01",
        compatibilityFlags: appCompatFlags,
        mainModule,
        modules,
        globalOutbound: this.env.EGRESS_GATEWAY,
        env: {
          AI: this.env.AI_PROXY,
          EXEC: this.env.CODE_EXECUTOR,
        },
      }));
      return { class: (worker as any).getDurableObjectClass("App") };
    });
    return facet.fetch(req);
  }

  // ── WebSocket handling ──────────────────────────────────────────────
  // AppRunner accepts WS and dispatches messages to the app facet.

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws);
    const wsTag = tags.find((t) => t.startsWith("ws:"));
    if (!wsTag) return;

    const pathname = wsTag.slice(3); // "ws:/path" → "/path"

    try {
      this.#loadMeta();
      const app = this.#app;
      if (!app) return;

      const manifestStr = await this.workspace.readFile(
        `${REPO_DIR}/apps/${app}/dist/manifest.json`,
      );
      if (!manifestStr) return;
      const meta = JSON.parse(manifestStr);

      const resp = await this.#dispatchToFacet(
        app,
        meta,
        new Request("http://localhost/_ws-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pathname, message: typeof message === "string" ? message : "" }),
        }),
      );
      const result = (await resp.json()) as { appends?: any[] };

      if (result.appends) {
        for (const event of result.appends) {
          ws.send(JSON.stringify({ type: "append", event }));
        }
      }
    } catch (e: any) {
      console.error(`[AppRunner] WS dispatch error: ${e.message}`);
      try {
        ws.send(JSON.stringify({ type: "error", message: e.message }));
      } catch {}
    }
  }

  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
