// WorkspaceDO — owns the R2-backed Workspace, FileSystem, and git operations.
// One per project, keyed by slug. Single source of truth for all file I/O.

import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { studioHTML, execSQL } from "./sql-studio.ts";

interface Env {
  WORKSPACE_R2: R2Bucket;
}

const REPO_DIR = "/repo";
const GIT_AUTHOR = { name: "POC Editor", email: "poc@iterate.com" };

export class WorkspaceDO extends DurableObject<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.WORKSPACE_R2,
    name: () => `workspace-${this.ctx.id}`,
  });
  fs = new WorkspaceFileSystem(this.workspace);
  git = createGit(this.fs, REPO_DIR);

  #cloned = false;

  #gitAuth(token: string) {
    if (!token || typeof token !== "string") {
      console.error(`[WorkspaceDO] invalid token: ${typeof token}`);
      return { username: "x", password: "" };
    }
    return { username: "x", password: token.split("?expires=")[0] };
  }

  // ── File I/O (RPC) ──────────────────────────────────────────────────

  async readFile(path: string): Promise<string | null> {
    return this.workspace.readFile(`${REPO_DIR}/${path}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = `${REPO_DIR}/${path}`;
    const dir = fullPath.split("/").slice(0, -1).join("/");
    await this.workspace.mkdir(dir, { recursive: true });
    await this.workspace.writeFile(fullPath, content);
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    const fullPath = `${REPO_DIR}/${path}`;
    const dir = fullPath.split("/").slice(0, -1).join("/");
    await this.workspace.mkdir(dir, { recursive: true });
    await this.workspace.writeFileBytes(fullPath, bytes);
  }

  async listFiles(dir = ""): Promise<string[]> {
    const fullDir = dir ? `${REPO_DIR}/${dir}` : REPO_DIR;
    const entries = await this.workspace.glob(`${fullDir}/**/*`);
    return entries
      .filter((e: any) => e.type === "file" && !e.path.includes("/.git/"))
      .map((e: any) => e.path.replace(`${REPO_DIR}/`, ""));
  }

  async exists(path: string): Promise<boolean> {
    return this.workspace.exists(`${REPO_DIR}/${path}`);
  }

  async snapshotAppFiles(app: string): Promise<InMemoryFileSystem> {
    const appDir = `${REPO_DIR}/apps/${app}`;
    const entries = await this.workspace.glob(`${appDir}/**/*`);
    const files: Record<string, string> = {};
    for (const entry of entries.filter(
      (e: any) =>
        e.type === "file" && !e.path.includes("/dist/") && !e.path.includes("/node_modules/"),
    )) {
      const content = await this.workspace.readFile(entry.path);
      if (content !== null) files[entry.path.replace(appDir + "/", "")] = content;
    }
    return new InMemoryFileSystem(files);
  }

  async writeDistFiles(
    app: string,
    modules: Record<string, string>,
    assets?: Record<string, string | ArrayBuffer>,
  ): Promise<string[]> {
    const distDir = `${REPO_DIR}/apps/${app}/dist`;
    try {
      await this.workspace.rm(distDir, { force: true, recursive: true });
    } catch {}
    await this.workspace.mkdir(distDir, { recursive: true });

    for (const [name, content] of Object.entries(modules)) {
      const value =
        typeof content === "string"
          ? content
          : ((content as any).js ?? (content as any).text ?? "");
      await this.writeFile(`apps/${app}/dist/${name}`, value);
    }

    const assetKeys: string[] = [];
    if (assets) {
      for (const [name, content] of Object.entries(assets)) {
        const fullPath = `${REPO_DIR}/apps/${app}/dist/assets${name}`;
        const dir = fullPath.split("/").slice(0, -1).join("/");
        await this.workspace.mkdir(dir, { recursive: true });
        if (typeof content === "string") {
          await this.workspace.writeFile(fullPath, content);
        } else {
          await this.workspace.writeFileBytes(fullPath, new Uint8Array(content));
        }
        assetKeys.push(name);
      }
    }

    return assetKeys;
  }

  async writeManifest(app: string, manifest: Record<string, unknown>): Promise<void> {
    await this.writeFile(`apps/${app}/dist/manifest.json`, JSON.stringify(manifest, null, 2));
  }

  async globAppDir(app: string): Promise<any[]> {
    const appDir = `${REPO_DIR}/apps/${app}`;
    return this.workspace.glob(`${appDir}/**/*`);
  }

  async rmDist(app: string): Promise<void> {
    try {
      await this.workspace.rm(`${REPO_DIR}/apps/${app}/dist`, { force: true, recursive: true });
    } catch {}
  }

  // ── Git (RPC) ────────────────────────────────────────────────────────

  async ensureCloned(remote: string, token: string): Promise<void> {
    if (this.#cloned) return;
    const hasGit = await this.workspace.exists(`${REPO_DIR}/.git/config`);
    if (hasGit) {
      console.log(`[WorkspaceDO] repo already cloned in SQLite`);
      this.#cloned = true;
      return;
    }
    console.log(`[WorkspaceDO] cloning from artifacts...`);
    await this.workspace.mkdir(REPO_DIR, { recursive: true });
    await this.git.clone({ url: remote, dir: REPO_DIR, ...this.#gitAuth(token) });
    this.#cloned = true;
    console.log(`[WorkspaceDO] clone complete`);
  }

  async pull(token: string): Promise<void> {
    await this.git.pull({
      dir: REPO_DIR,
      remote: "origin",
      ref: "main",
      author: GIT_AUTHOR,
      ...this.#gitAuth(token),
    });
  }

  async commitAndPush(message: string, token: string): Promise<string | null> {
    await this.git.add({ filepath: ".", dir: REPO_DIR });
    const result = await this.git.commit({ message, author: GIT_AUTHOR, dir: REPO_DIR });
    await this.git.push({ dir: REPO_DIR, remote: "origin", ...this.#gitAuth(token) });
    console.log(`[WorkspaceDO] pushed commit ${result.oid}`);
    return result.oid;
  }

  async rebaseFromBase(
    ownRemote: string,
    ownToken: string,
    baseRemote: string,
    baseToken: string,
    force: boolean,
  ): Promise<{ pulled: boolean; oid: string | null; forced: boolean }> {
    console.log(`[WorkspaceDO] rebasing from base-template...`);
    const baseAuth = this.#gitAuth(baseToken);

    if (force) {
      console.log(`[WorkspaceDO] force rebase: resetting to base-template`);
      await this.workspace.rm(REPO_DIR, { force: true, recursive: true });
      this.#cloned = false;
      await this.workspace.mkdir(REPO_DIR, { recursive: true });
      await this.git.clone({ url: baseRemote, dir: REPO_DIR, ...baseAuth });

      try {
        await this.git.remote({ dir: REPO_DIR, remove: "origin" });
      } catch {}
      await this.git.remote({ dir: REPO_DIR, add: { name: "origin", url: ownRemote } });
      await this.git.push({
        dir: REPO_DIR,
        remote: "origin",
        force: true,
        ...this.#gitAuth(ownToken),
      });

      const log = await this.git.log({ dir: REPO_DIR, depth: 1 });
      this.#cloned = true;
      return { pulled: true, oid: log[0]?.oid ?? null, forced: true };
    }

    // Normal rebase: add base remote, pull, push
    try {
      await this.git.remote({ dir: REPO_DIR, remove: "base" });
    } catch {}
    const authenticatedBaseUrl = baseRemote.replace(
      "https://",
      `https://${baseAuth.username}:${baseAuth.password}@`,
    );
    await this.git.remote({ dir: REPO_DIR, add: { name: "base", url: authenticatedBaseUrl } });

    const pullResult = await this.git.pull({
      dir: REPO_DIR,
      remote: "base",
      ref: "main",
      author: GIT_AUTHOR,
      ...baseAuth,
    });
    console.log(`[WorkspaceDO] pull result: pulled=${pullResult.pulled}`);

    let oid: string | null = null;
    if (pullResult.pulled) {
      await this.git.push({
        dir: REPO_DIR,
        remote: "origin",
        ...this.#gitAuth(ownToken),
      });
      const log = await this.git.log({ dir: REPO_DIR, depth: 1 });
      oid = log[0]?.oid ?? null;
      console.log(`[WorkspaceDO] pushed rebased result: ${oid}`);
    }

    return { pulled: pullResult.pulled, oid, forced: false };
  }

  // ── Debug: SQL Studio ────────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/_studio") {
      return new Response(studioHTML(`WorkspaceDO`), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (req.method === "POST" && url.pathname === "/_sql") {
      return execSQL(this.ctx.storage.sql, req);
    }
    return new Response("WorkspaceDO", { status: 200 });
  }
}
