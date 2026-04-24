// AppRunner — per-app runtime with own R2-backed Workspace.
// Clones the artifact repo, serves assets directly, loads modules for dynamic workers.
// No RPC to Project DO for file reads.

import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { PLATFORM_SUFFIX } from "./host-parser.ts";
import { inferContentType, cacheHeaders } from "./content-types.ts";

interface Env {
  PROJECT: DurableObjectNamespace;
  WORKSPACE_R2: R2Bucket;
  LOADER: WorkerLoader;
  EGRESS_GATEWAY: Fetcher;
  AI_PROXY: Fetcher;
  CODE_EXECUTOR: Fetcher;
  ARTIFACTS: any;
}

const REPO_DIR = "/repo";

function parseApp(host: string): string | null {
  if (!host.endsWith(PLATFORM_SUFFIX)) return null;
  const prefix = host.slice(0, -PLATFORM_SUFFIX.length);
  const dot = prefix.indexOf(".");
  return dot !== -1 ? prefix.slice(0, dot) : null;
}

export class AppRunner extends DurableObject<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.WORKSPACE_R2,
    name: () => `runner-${this.ctx.id}`,
  });
  fs = new WorkspaceFileSystem(this.workspace);
  git = createGit(this.fs, REPO_DIR);

  #metaReady = false;
  #cloned = false;

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

  // ── RPC methods called by Project DO ────────────────────────────────

  async setup(remote: string, repoName: string) {
    const existing = this.#getMeta("remote");
    if (existing === remote) return; // Already set up
    this.#setMeta("remote", remote);
    this.#setMeta("repo_name", repoName);
    console.log(`[AppRunner] setup: remote=${remote} repo=${repoName}`);
    // Trigger initial clone in background
    this.ctx.waitUntil(this.#ensureSync());
  }

  async notifyBuild() {
    this.#setMeta("needs_sync", "1");
    console.log(`[AppRunner] notifyBuild: flagged for sync`);
  }

  // ── Sync logic ──────────────────────────────────────────────────────

  async #ensureSync() {
    const remote = this.#getMeta("remote");
    const repoName = this.#getMeta("repo_name");
    if (!remote || !repoName) return;

    const hasGit = await this.workspace.exists(`${REPO_DIR}/.git/config`);

    if (!hasGit) {
      // Initial clone
      console.log(`[AppRunner] cloning ${repoName}...`);
      const token = await this.#getWriteToken(repoName);
      await this.workspace.mkdir(REPO_DIR, { recursive: true });
      await this.git.clone({
        url: remote,
        dir: REPO_DIR,
        ...this.#gitAuth(token),
      });
      this.#cloned = true;
      this.#setMeta("needs_sync", "0");
      console.log(`[AppRunner] clone complete`);
      return;
    }

    this.#cloned = true;

    // Pull if flagged
    const needsSync = this.#getMeta("needs_sync");
    if (needsSync === "1") {
      console.log(`[AppRunner] pulling latest...`);
      const token = await this.#getWriteToken(repoName);
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
      this.#setMeta("needs_sync", "0");
    }
  }

  async #getWriteToken(repoName: string): Promise<string> {
    const repo = await this.env.ARTIFACTS.get(repoName);
    const tokenResult = await repo.createToken("read", 3600);
    const token = tokenResult.plaintext ?? tokenResult.token ?? String(tokenResult);
    return token;
  }

  #gitAuth(token: string) {
    if (!token || typeof token !== "string") {
      return { username: "x", password: "" };
    }
    const secret = token.split("?expires=")[0];
    return { username: "x", password: secret };
  }

  // ── Request handling ────────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.hostname;
    const app = parseApp(host);

    if (!app) {
      return new Response("AppRunner: cannot derive app from host", { status: 400 });
    }

    // Ensure we have latest from artifact repo
    await this.#ensureSync();

    // Get slug from host for facet keying
    const slugFromHost = host.slice(app.length + 1, -PLATFORM_SUFFIX.length);

    // Read app build config
    const appPkgStr = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/package.json`);
    const appPkg = appPkgStr ? JSON.parse(appPkgStr) : {};
    const appBuildConfig = appPkg.buildConfig ?? {};
    const appCompatFlags: string[] = appBuildConfig.compatibilityFlags ?? [];

    // Read manifest
    const manifestStr = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/dist/manifest.json`);
    if (!manifestStr) {
      return new Response(`App "${app}" has no dist — needs building`, { status: 404 });
    }

    const meta = JSON.parse(manifestStr);

    // ── Asset serving ─────────────────────────────────────────────────
    if (url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
      const cleanPath = url.pathname.replace(/^\/+/, "");

      // Try dist/client/ first (Vite builds), then dist/assets/, then dist/
      const candidates = [
        `${REPO_DIR}/apps/${app}/dist/client/${cleanPath}`,
        `${REPO_DIR}/apps/${app}/dist/assets/${cleanPath}`,
        `${REPO_DIR}/apps/${app}/dist/${cleanPath}`,
      ];

      for (const candidate of candidates) {
        const content = await this.workspace.readFile(candidate);
        if (content !== null) {
          console.log(`[AppRunner] asset: ${url.pathname} from ${candidate}`);
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
      // Try multiple locations for index.html
      const indexCandidates = [
        `${REPO_DIR}/apps/${app}/dist/client/index.html`,
        `${REPO_DIR}/apps/${app}/dist/assets/index.html`,
        `${REPO_DIR}/apps/${app}/dist/index.html`,
      ];

      for (const candidate of indexCandidates) {
        const content = await this.workspace.readFile(candidate);
        if (content !== null) {
          return new Response(content, {
            headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
          });
        }
      }
    }

    // ── Dynamic worker (API routes, SSR) ──────────────────────────────
    const modules: Record<string, string> = {};
    for (const f of meta.moduleFiles) {
      const content = await this.workspace.readFile(`${REPO_DIR}/apps/${app}/dist/${f}`);
      if (content) modules[f] = content;
    }

    const mainModule: string = meta.mainModule;
    if (!modules[mainModule]) {
      return new Response(`App ${app} missing main module: ${mainModule}`, { status: 500 });
    }

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
        },
      }));
      return { class: (worker as any).getDurableObjectClass("App") };
    });

    console.log(`[AppRunner] forwarding to App facet`);
    return facet.fetch(req);
  }
}
