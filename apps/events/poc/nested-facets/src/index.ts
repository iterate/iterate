// Nested Facets POC — App source code lives in Cloudflare Artifacts
//
// URL hierarchy:
//   1. iterate-dev-jonas.app              → Platform admin (CRUD projects)
//   2. <project>.iterate-dev-jonas.app    → Artifact editor (edit app source, config)
//   3. <app>.<project-or-custom-host>     → App UI (loaded from artifact source code)

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import {
  createApp,
  createWorker,
  InMemoryFileSystem,
  type CreateWorkerResult,
  type CreateAppResult,
} from "@cloudflare/worker-bundler";
import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import PostalMime from "postal-mime";
import { adminHTML } from "./admin.ts";
import { editorHTML } from "./editor.ts";
export { EgressGateway } from "./egress-gateway.ts";
export { RepoDO } from "./repo-do.ts";
export { WorkspaceDO } from "./workspace-do.ts";
import type { RepoDO } from "./repo-do.ts";
import type { WorkspaceDO } from "./workspace-do.ts";
import { parseHost, PLATFORM_SUFFIX, PLATFORM_BARE } from "./host-parser.ts";
import { studioHTML, execSQL } from "./sql-studio.ts";
import { inferContentType, cacheHeaders } from "./content-types.ts";
import { handleAdminAPI } from "./admin-api.ts";
import { deriveThreadId, storeThreadMapping, appendEmailEvent } from "./email.ts";

// Export BuildSandbox for the container DO binding
export class BuildSandbox extends Sandbox<Env> {}

interface EmailService {
  send(message: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

interface Env {
  PROJECT: DurableObjectNamespace<Project>;
  BUILD_SANDBOX: DurableObjectNamespace<BuildSandbox>;
  LOADER: WorkerLoader;
  DB: D1Database;
  ARTIFACTS: any;
  EMAIL: EmailService;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  CF_WORKER_NAME: string;
  EVENTS_BASE_URL: string;
  EGRESS_GATEWAY: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  REPO: DurableObjectNamespace<RepoDO>;
  WORKSPACE_R2: R2Bucket;
  AI: Ai;
  AI_PROXY: Service<typeof AiProxy>;
  CODE_EXECUTOR: Service<CodeExecutor>;
}

// ── AiProxy — proxies AI binding to dynamic workers via ctx.exports ──────────

export class AiProxy extends WorkerEntrypoint<Env> {
  constructor(ctx: any, env: Env) {
    super(ctx, env);
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        const binding = target.env.AI as any;
        const val = binding[prop];
        if (typeof val === "function") return val.bind(binding);
        return val;
      },
    });
  }
}

// ── CodeExecutor — runs user scripts in sandboxed dynamic workers ────────────

interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  positionalArgs?: boolean;
}

export class CodeExecutor extends WorkerEntrypoint<Env> {
  async execute(
    script: string,
    providers: ResolvedProvider[],
    opts?: { timeout?: number },
  ): Promise<{ result?: unknown; error?: string; logs?: string[] }> {
    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      globalOutbound: this.env.EGRESS_GATEWAY,
      timeout: opts?.timeout ?? 30_000,
    });
    return executor.execute(script, providers);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectRow {
  slug: string;
  canonical_hostname: string | null;
  config_json: string;
  artifacts_repo: string | null;
  artifacts_remote: string | null;
  created_at: string;
}

// ── Worker entry ──────────────────────────────────────────────────────────────

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const toAddr = message.to;
    console.log(`[Email] inbound from=${message.from} to=${toAddr}`);

    const atIdx = toAddr.indexOf("@");
    if (atIdx === -1) {
      message.setReject("Invalid address");
      return;
    }
    const localPart = toAddr.slice(0, atIdx);
    const domain = toAddr.slice(atIdx + 1);

    let projectSlug: string;
    let streamName: string;

    if (domain === PLATFORM_BARE) {
      const sep = localPart.indexOf("--");
      if (sep === -1) {
        projectSlug = localPart;
        streamName = "default";
      } else {
        projectSlug = localPart.slice(0, sep);
        streamName = localPart.slice(sep + 2);
      }
    } else if (domain.endsWith(PLATFORM_SUFFIX)) {
      streamName = localPart;
      projectSlug = domain.slice(0, -PLATFORM_SUFFIX.length);
    } else {
      message.setReject("Unknown domain");
      return;
    }

    console.log(`[Email] project=${projectSlug} stream=${streamName}`);

    const project = await env.DB.prepare("SELECT * FROM projects WHERE slug = ?")
      .bind(projectSlug)
      .first<ProjectRow>();
    if (!project) {
      message.setReject(`Project "${projectSlug}" not found`);
      return;
    }

    const rawBytes = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(rawBytes);

    const id = env.PROJECT.idFromName(projectSlug);
    const stub = env.PROJECT.get(id);

    const headers = new Headers();
    headers.set("x-level", "app");
    headers.set("x-app", "agents");
    headers.set("x-project-slug", projectSlug);
    if (project.artifacts_remote) headers.set("x-artifacts-remote", project.artifacts_remote);
    if (project.artifacts_repo) headers.set("x-artifacts-repo", project.artifacts_repo);
    headers.set("x-config", project.config_json);
    headers.set("content-type", "application/json");

    const referencesHeader =
      parsed.headers?.find((h: any) => h.key === "references")?.value ?? null;
    const inReplyToHeader =
      parsed.headers?.find((h: any) => h.key === "in-reply-to")?.value ?? null;

    const emailPayload = {
      from: message.from,
      to: toAddr,
      subject: parsed.subject ?? "(no subject)",
      messageId: parsed.messageId ?? null,
      references: referencesHeader,
      inReplyTo: inReplyToHeader,
      text: parsed.text ?? "",
      html: parsed.html ?? "",
      streamName,
      date: parsed.date ?? new Date().toISOString(),
    };

    const resp = await stub.fetch(
      new Request("https://internal/emails", {
        method: "POST",
        headers,
        body: JSON.stringify(emailPayload),
      }),
    );

    if (!resp.ok) {
      console.error(`[Email] DO returned ${resp.status}: ${await resp.text()}`);
    } else {
      console.log(`[Email] stored successfully: ${await resp.text()}`);
      const threadId = await deriveThreadId(
        env.DB,
        emailPayload.messageId,
        emailPayload.references,
        emailPayload.inReplyTo,
      );
      await appendEmailEvent(env, projectSlug, threadId, "email-received", {
        from: emailPayload.from,
        to: emailPayload.to,
        subject: emailPayload.subject,
        streamName,
        messageId: emailPayload.messageId,
        date: emailPayload.date,
        text: emailPayload.text,
        html: emailPayload.html || undefined,
      });
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isWs = req.headers.get("Upgrade") === "websocket";
    console.log(`[Worker] ${req.method} ${url.hostname}${url.pathname} ws=${isWs}`);

    if (url.pathname.startsWith("/admin/api/")) return handleAdminAPI(req, url, env as any);

    const parsed = await parseHost(url.hostname, env.DB);
    if (!parsed) return new Response("Unknown host", { status: 404 });

    // Level 1: Admin
    if (parsed.level === "admin") {
      const projects = await env.DB.prepare(
        "SELECT * FROM projects ORDER BY created_at DESC",
      ).all<ProjectRow>();
      return new Response(adminHTML(projects.results), {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
      });
    }

    // events.<project>.iterate-dev-jonas.app → proxy to <project>.events.iterate.com
    if (parsed.level === "app" && (parsed as any).app === "events") {
      const target = `https://${parsed.project}.events.iterate.com${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("host", `${parsed.project}.events.iterate.com`);
      return fetch(target, { method: req.method, headers, body: req.body });
    }

    // Route to Project DO
    const id = env.PROJECT.idFromName(parsed.project);
    const stub = env.PROJECT.get(id);
    const project = await env.DB.prepare(
      "SELECT slug, artifacts_remote, artifacts_repo, canonical_hostname FROM projects WHERE slug = ?",
    )
      .bind(parsed.project)
      .first<{
        slug: string;
        artifacts_remote: string | null;
        artifacts_repo: string | null;
        canonical_hostname: string | null;
      }>();
    if (project?.artifacts_remote && project?.artifacts_repo) {
      await stub.setup(
        project.slug,
        project.artifacts_remote,
        project.artifacts_repo,
        project.canonical_hostname,
      );
    }
    return stub.fetch(req);
  },
};

// ── Project DO ────────────────────────────────────────────────────────────────

type BuildState = "idle" | "building" | "ready" | "error";

export class Project extends DurableObject<Env> {
  #buildStates: Record<string, BuildState> = {};
  #logBuffer: Array<{ ts: number; message: string }> = [];
  #facetsTableReady = false;
  #metaReady = false;

  // ── DO stubs for WorkspaceDO and RepoDO ──────────────────────────────

  get ws(): WorkspaceDO {
    return this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(this.slug),
    ) as unknown as WorkspaceDO;
  }

  get repo(): RepoDO {
    return this.env.REPO.get(this.env.REPO.idFromName(this.slug)) as unknown as RepoDO;
  }

  // ── Project metadata in SQLite ──────────────────────────────────────

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

  async setup(
    slug: string,
    artifactsRemote: string,
    artifactsRepo: string,
    canonicalHostname?: string | null,
  ) {
    this.#setMeta("slug", slug);
    this.#setMeta("artifacts_remote", artifactsRemote);
    this.#setMeta("artifacts_repo", artifactsRepo);
    if (canonicalHostname) this.#setMeta("canonical_hostname", canonicalHostname);
    // Initialize RepoDO with repo name
    await this.repo.init(artifactsRepo);
    console.log(
      `[Project DO] setup: slug=${slug} repo=${artifactsRepo} host=${canonicalHostname ?? "none"}`,
    );
  }

  get slug(): string {
    return this.#getMeta("slug") ?? "unknown";
  }
  get remote(): string | null {
    return this.#getMeta("artifacts_remote");
  }
  get repoName(): string | null {
    return this.#getMeta("artifacts_repo");
  }

  #parseLevel(host: string): { level: "project" | "app"; app: string | null } {
    if (host.endsWith(PLATFORM_SUFFIX)) {
      const prefix = host.slice(0, -PLATFORM_SUFFIX.length);
      const dot = prefix.indexOf(".");
      if (dot !== -1) return { level: "app", app: prefix.slice(0, dot) };
    }
    const canonicalHostname = this.#getMeta("canonical_hostname");
    if (canonicalHostname && host.endsWith(`.${canonicalHostname}`)) {
      const appName = host.slice(0, -(canonicalHostname.length + 1));
      if (appName) return { level: "app", app: appName };
    }
    return { level: "project", app: null };
  }

  ensureFacetsTable() {
    if (this.#facetsTableReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS _facets (
        name TEXT PRIMARY KEY,
        class_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_fetch_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    this.#facetsTableReady = true;
  }

  upsertFacet(name: string, className: string) {
    this.ensureFacetsTable();
    this.ctx.storage.sql.exec(
      "INSERT INTO _facets (name, class_name) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_fetch_at = datetime('now')",
      name,
      className,
    );
  }

  // ── Ensure workspace is cloned ──────────────────────────────────────

  async ensureCloned(): Promise<void> {
    const remote = this.remote;
    const repoName = this.repoName;
    if (!remote || !repoName) return;
    const token = await this.repo.getToken("write", 3600);
    await this.ws.ensureCloned(remote, token);
  }

  // ── Build helpers ──────────────────────────────────────────────────

  setBuildState(app: string, state: BuildState) {
    this.#buildStates[app] = state;
  }

  getBuildState(app: string): BuildState {
    return this.#buildStates[app] ?? "idle";
  }

  log(message: string) {
    const entry = { ts: Date.now(), message };
    console.log(`[Project DO] ${message}`);
    this.#logBuffer.push(entry);
    if (this.#logBuffer.length > 100) this.#logBuffer.shift();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: "log", ...entry }));
      } catch {}
    }
  }

  async commitAndPush(message: string): Promise<string | null> {
    const token = await this.repo.getToken("write", 3600);
    return this.ws.commitAndPush(message, token);
  }

  // Build an app in a sandbox container using esbuild
  async buildInSandbox(app: string, buildConfig: Record<string, any>): Promise<Response> {
    this.log(`[Sandbox] Building ${app}...`);
    this.setBuildState(app, "building");

    try {
      const sandbox = getSandbox(this.env.BUILD_SANDBOX, `esbuild-${app}`);

      // Write source files to sandbox
      const entries = await this.ws.globAppDir(app);
      const appDir = `apps/${app}`;
      const sourceFiles = entries.filter(
        (e: any) =>
          e.type === "file" && !e.path.includes("/dist/") && !e.path.includes("/node_modules/"),
      );
      for (const entry of sourceFiles) {
        const relPath = entry.path.replace(/^\/repo\/apps\/[^/]+\//, "");
        const content = await this.ws.readFile(`${appDir}/${relPath}`);
        if (content !== null) {
          await sandbox.writeFile(`/workspace/${relPath}`, content);
        }
      }
      this.log(`[Sandbox] Wrote ${sourceFiles.length} files`);

      const install = await sandbox.exec("npm install --legacy-peer-deps 2>&1", {
        timeout: 120_000,
        cwd: "/workspace",
      });
      if (!install.success) {
        throw new Error(`npm install failed: ${(install.stdout + install.stderr).slice(-500)}`);
      }
      this.log("[Sandbox] npm install done");

      const conditions = (buildConfig.esbuildConditions ?? [])
        .map((c: string) => `--conditions=${c}`)
        .join(" ");
      const platform = buildConfig.esbuildPlatform ?? "neutral";
      const externals = '--external:"cloudflare:*" --external:"node:*" --external:path';
      const esbuildCmd = [
        "npx esbuild worker.ts",
        "--bundle --format=esm --target=es2022",
        `--platform=${platform}`,
        "--tree-shaking=true",
        externals,
        conditions,
        "--define:process.env.NODE_ENV='\"production\"'",
        "--jsx=automatic --jsx-import-source=react",
        "--outfile=dist/bundle.js",
        "2>&1",
      ].join(" ");
      this.log(`[Sandbox] esbuild: ${esbuildCmd}`);
      const build = await sandbox.exec(esbuildCmd, { timeout: 60_000, cwd: "/workspace" });
      if (!build.success) {
        throw new Error(`esbuild failed: ${(build.stdout + build.stderr).slice(-1000)}`);
      }
      this.log("[Sandbox] esbuild done");

      const hasClient = sourceFiles.some(
        (e: any) => e.path.endsWith("/client.tsx") || e.path.endsWith("/client.ts"),
      );
      const assetFiles: string[] = [];
      if (hasClient) {
        const clientCmd = [
          "npx esbuild client.tsx",
          "--bundle --format=esm --target=es2022",
          "--platform=browser --splitting",
          "--jsx=automatic --jsx-import-source=react",
          '--outdir=dist/assets --chunk-names="[name]-[hash]"',
          "2>&1",
        ].join(" ");
        const clientBuild = await sandbox.exec(clientCmd, { timeout: 60_000, cwd: "/workspace" });
        if (!clientBuild.success) {
          throw new Error(
            `client esbuild failed: ${(clientBuild.stdout + clientBuild.stderr).slice(-500)}`,
          );
        }

        const lsAssets = await sandbox.exec("ls dist/assets/ 2>/dev/null || echo ''", {
          cwd: "/workspace",
        });
        for (const f of lsAssets.stdout.trim().split("\n").filter(Boolean)) {
          const file = await sandbox.readFile(`/workspace/dist/assets/${f}`);
          await this.ws.writeFile(`apps/${app}/dist/assets/${f}`, file.content);
          assetFiles.push(`assets/${f}`);
        }

        const htmlSrc = sourceFiles.find((e: any) => e.path.endsWith("/index.html"));
        let html = htmlSrc
          ? ((await this.ws.readFile(
              `${appDir}/${htmlSrc.path.replace(/^\/repo\/apps\/[^/]+\//, "")}`,
            )) ?? "<html><body><div id='root'></div></body></html>")
          : "<html><body><div id='root'></div></body></html>";
        html = html.replace(
          "</body>",
          '<script type="module" src="/assets/client.js"></script></body>',
        );
        await this.ws.writeFile(`apps/${app}/dist/assets/index.html`, html);
        assetFiles.push("assets/index.html");
        this.log("[Sandbox] client build done");
      }

      const serverBundle = await sandbox.readFile("/workspace/dist/bundle.js");
      await this.ws.writeFile(`apps/${app}/dist/bundle.js`, serverBundle.content);

      const manifest = {
        builtAt: new Date().toISOString(),
        builtBy: "sandbox-esbuild",
        mainModule: "bundle.js",
        moduleFiles: ["bundle.js"],
        assetFiles,
      };
      await this.ws.writeManifest(app, manifest);

      try {
        await sandbox.destroy();
      } catch {}

      this.setBuildState(app, "ready");
      this.log(`[Sandbox] Build complete: ${app}`);

      try {
        await this.commitAndPush(`Build ${app} (esbuild)`);
      } catch (e: any) {
        this.log(`Commit/push failed: ${e.message}`);
      }

      const files = await this.ws.listFiles();
      return Response.json({
        ok: true,
        app,
        builtBy: "sandbox-esbuild",
        moduleFiles: manifest.moduleFiles,
        assetFiles,
        files,
        buildOutput: build.stdout.slice(-300),
      });
    } catch (e: any) {
      this.setBuildState(app, "error");
      this.log(`[Sandbox] Build failed: ${app}: ${e.message}`);
      return Response.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  // ── App serving (ported from AppRunner) ───────────────────────────────

  async #serveApp(app: string, req: Request): Promise<Response> {
    const url = new URL(req.url);

    // SQL Studio at app level
    if (url.pathname === "/_studio") {
      return new Response(studioHTML(`App: ${app}`), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (req.method === "POST" && url.pathname === "/_sql") {
      return execSQL(this.ctx.storage.sql, req);
    }

    // WebSocket upgrade — accept at Project DO and dispatch messages via webSocketMessage
    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [`ws:${url.pathname}`, `app:${app}`]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Read manifest
    const manifestStr = await this.ws.readFile(`apps/${app}/dist/manifest.json`);
    if (!manifestStr) {
      return new Response(`App "${app}" has no dist — needs building`, { status: 404 });
    }
    const meta = JSON.parse(manifestStr);

    // Asset serving
    if (url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
      const cleanPath = url.pathname.replace(/^\/+/, "");
      for (const dir of ["dist/client/", "dist/assets/", "dist/"]) {
        const content = await this.ws.readFile(`apps/${app}/${dir}${cleanPath}`);
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

    // SPA fallback
    if (
      !url.pathname.includes(".") &&
      !url.pathname.startsWith("/api/") &&
      !url.pathname.includes("/_studio") &&
      !url.pathname.includes("/_sql") &&
      !url.pathname.startsWith("/streams/")
    ) {
      for (const dir of ["dist/client/", "dist/assets/", "dist/"]) {
        const content = await this.ws.readFile(`apps/${app}/${dir}index.html`);
        if (content !== null) {
          return new Response(content, {
            headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
          });
        }
      }
    }

    // Dynamic worker (API routes, SSR)
    return this.#dispatchToFacet(app, meta, req);
  }

  async #dispatchToFacet(
    app: string,
    meta: { mainModule: string; moduleFiles: string[] },
    req: Request,
  ): Promise<Response> {
    const modules: Record<string, string> = {};
    for (const f of meta.moduleFiles) {
      const content = await this.ws.readFile(`apps/${app}/dist/${f}`);
      if (content) modules[f] = content;
    }

    const mainModule = meta.mainModule;
    if (!modules[mainModule]) {
      return new Response(`App ${app} missing main module: ${mainModule}`, { status: 500 });
    }

    const appPkgStr = await this.ws.readFile(`apps/${app}/package.json`);
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
    // Stable facet key (survives rebuilds, keeps WebSocket connections)
    // Hash in LOADER key (picks up new code on rebuild)
    const facet = ctx.facets.get(`app:${app}`, async () => {
      const worker = this.env.LOADER.get(`app:${app}:${sourceHash}`, async () => ({
        compatibilityDate: "2026-04-01",
        compatibilityFlags: appCompatFlags,
        mainModule,
        modules,
        globalOutbound: this.env.EGRESS_GATEWAY,
        env: {
          AI: this.env.AI_PROXY,
          EXEC: this.env.CODE_EXECUTOR,
          EVENTS_API_BASE: this.env.EVENTS_BASE_URL.replace("://", `://${this.slug}.`),
        },
      }));
      return { class: (worker as any).getDurableObjectClass("App") };
    });
    return facet.fetch(req);
  }

  // ── Main fetch handler ──────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.hostname;
    const doId = this.ctx.id.toString();

    const { level, app } = this.#parseLevel(host);

    const slug = this.slug;
    const remote = this.remote;
    const repoName = this.repoName;

    console.log(
      `[Project DO] id=${doId} slug=${slug} level=${level} app=${app} path=${url.pathname}`,
    );

    // Ensure artifact is cloned in workspace
    try {
      await this.ensureCloned();
    } catch (e: any) {
      console.error(`[Project DO] clone failed: ${e.message}`);
    }

    // Rebase from base-template
    if (req.method === "POST" && url.pathname === "/api/rebase") {
      if (!repoName || !remote)
        return Response.json({ error: "no artifacts repo" }, { status: 400 });
      const force = url.searchParams.get("force") === "1";
      try {
        const ownToken = await this.repo.getToken("write", 3600);
        // Get base-template token + remote
        const baseRepo = await this.env.ARTIFACTS.get("base-template");
        const baseTokenResult = await baseRepo.createToken("read", 3600);
        const baseToken =
          baseTokenResult.plaintext ?? baseTokenResult.token ?? String(baseTokenResult);
        const baseRemote = remote.replace(`/${repoName}.git`, "/base-template.git");

        const result = await this.ws.rebaseFromBase(remote, ownToken, baseRemote, baseToken, force);
        const files = await this.ws.listFiles();
        return Response.json({ ok: true, ...result, files, doId });
      } catch (e: any) {
        console.error(`[Project DO] rebase failed: ${e.message}`);
        return Response.json(
          { error: e.message, hint: "Try ?force=1 to discard local changes" },
          { status: 500 },
        );
      }
    }

    // Debug endpoint
    if (url.pathname === "/debug") {
      const hasGit = await this.ws.exists(".git/config");
      const files = await this.ws.listFiles();
      return Response.json({
        doId,
        slug,
        level,
        app,
        remote,
        repoName,
        hasGit,
        filesBefore: files,
      });
    }

    // ── Level 2: Artifact editor ────────────────────────────────────────
    if (level === "project") {
      // SQL Studio (Project DO)
      if (url.pathname === "/_studio") {
        this.ensureFacetsTable();
        return new Response(studioHTML(`Project: ${slug}`), {
          headers: { "content-type": "text/html;charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/_sql") {
        this.ensureFacetsTable();
        return execSQL(this.ctx.storage.sql, req);
      }

      // GET /api/files — list files
      if (req.method === "GET" && url.pathname === "/api/files") {
        const files = await this.ws.listFiles();
        return Response.json({ files, doId });
      }

      // GET /api/files/:path — read file
      if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
        const path = decodeURIComponent(url.pathname.replace("/api/files/", ""));
        const content = await this.ws.readFile(path);
        if (content === null) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ path, content, doId });
      }

      // PUT /api/files/:path — write file + commit + push
      if (req.method === "PUT" && url.pathname.startsWith("/api/files/")) {
        const path = decodeURIComponent(url.pathname.replace("/api/files/", ""));
        const body = (await req.json()) as { content: string };
        await this.ws.writeFile(path, body.content);
        let oid: string | null = null;
        try {
          oid = await this.commitAndPush(`Update ${path}`);
        } catch (e: any) {
          console.error(`[Project DO] commit/push failed: ${e.message}`);
        }
        return Response.json({ ok: true, path, oid, doId });
      }

      // POST /api/build/:app — bundle an app
      const buildMatch = url.pathname.match(/^\/api\/build\/([a-z0-9-]+)$/);
      if (req.method === "POST" && buildMatch) {
        const buildApp = buildMatch[1];

        const buildPkgStr = await this.ws.readFile(`apps/${buildApp}/package.json`);
        const buildPkg = buildPkgStr ? JSON.parse(buildPkgStr) : {};
        if (buildPkg.buildConfig?.localBuildOnly || buildPkg.buildConfig?.sandboxBuild) {
          if (buildPkg.buildConfig?.sandboxBuild) {
            return this.buildInSandbox(buildApp, buildPkg.buildConfig);
          }
          const hasDist = await this.ws.readFile(`apps/${buildApp}/dist/manifest.json`);
          if (hasDist) {
            return Response.json({
              ok: true,
              app: buildApp,
              localBuildOnly: true,
              message: "Using existing dist (app requires local build)",
            });
          }
          return Response.json(
            {
              ok: false,
              error: `App "${buildApp}" requires local build (buildConfig.localBuildOnly). Run: npx tsx scripts/build-local.ts ${buildApp}`,
            },
            { status: 400 },
          );
        }

        this.log(`Building ${buildApp}...`);
        this.setBuildState(buildApp, "building");

        try {
          const fs = await this.ws.snapshotAppFiles(buildApp);
          this.log(`Snapshotted source files for ${buildApp}`);

          const clientEntry = fs.read("client.tsx")
            ? "client.tsx"
            : fs.read("client.ts")
              ? "client.ts"
              : fs.read("client.jsx")
                ? "client.jsx"
                : null;

          this.log(`Client entry: ${clientEntry ?? "none (server-only)"}`);

          const pkgStr = fs.read("package.json");
          const pkg = pkgStr ? JSON.parse(pkgStr) : {};
          const buildCfg = pkg.buildConfig ?? {};
          const externals: string[] = buildCfg.externals ?? [];

          const result = clientEntry
            ? await createApp({
                files: fs,
                client: clientEntry,
                server: fs.read("worker.ts") ? "worker.ts" : undefined,
                jsx: "automatic",
                jsxImportSource: "react",
                externals,
              })
            : await createWorker({
                files: fs,
                jsx: "automatic",
                jsxImportSource: "react",
                externals,
              });

          this.log(`Bundle complete, writing dist files...`);

          // Write dist using WorkspaceDO
          const assetKeys = await this.ws.writeDistFiles(
            buildApp,
            result.modules as Record<string, string>,
            "assets" in result
              ? (result.assets as Record<string, string | ArrayBuffer>)
              : undefined,
          );

          // Generate index.html if needed
          if ("assets" in result && !assetKeys.includes("/index.html")) {
            let html = await this.ws.readFile(`apps/${buildApp}/index.html`);
            if (!html) {
              html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${buildApp}</title></head><body><div id="root"></div></body></html>`;
            }
            const clientScripts = assetKeys
              .filter((k) => k.endsWith(".js"))
              .map((k) => `<script type="module" src="${k}"></script>`)
              .join("\n");
            if (clientScripts) {
              html = html.includes("</body>")
                ? html.replace("</body>", `${clientScripts}\n</body>`)
                : html + `\n${clientScripts}`;
            }
            await this.ws.writeFile(`apps/${buildApp}/dist/assets/index.html`, html);
            assetKeys.push("/index.html");
          }

          // Write manifest
          const manifest = {
            mainModule: result.mainModule,
            moduleFiles: Object.keys(result.modules),
            assetFiles: assetKeys,
            builtAt: new Date().toISOString(),
          };
          await this.ws.writeManifest(buildApp, manifest);

          let oid: string | null = null;
          try {
            oid = await this.commitAndPush(`Build ${buildApp}`);
            this.log(`Pushed build commit: ${oid?.slice(0, 8)}`);
          } catch (e: any) {
            this.log(`Commit/push failed: ${e.message}`);
          }

          this.setBuildState(buildApp, "ready");
          this.log(`Build complete: ${buildApp}`);

          const files = await this.ws.listFiles();
          return Response.json({
            ok: true,
            app: buildApp,
            oid,
            files,
            moduleFiles: Object.keys(result.modules),
            warnings: result.warnings ?? [],
          });
        } catch (e: any) {
          this.setBuildState(buildApp, "error");
          this.log(`Build failed: ${buildApp}: ${e.message}`);
          return Response.json({ ok: false, error: e.message, stack: e.stack }, { status: 500 });
        }
      }

      // POST /api/build-vite/:app
      const viteBuildMatch = url.pathname.match(/^\/api\/build-vite\/([a-z0-9-]+)$/);
      if (req.method === "POST" && viteBuildMatch) {
        const buildApp = viteBuildMatch[1];
        this.log(`[Vite] Building ${buildApp} in sandbox...`);
        this.setBuildState(buildApp, "building");

        try {
          const sandbox = getSandbox(this.env.BUILD_SANDBOX, `vite-build-${buildApp}`);
          const entries = await this.ws.globAppDir(buildApp);
          const sourceFiles = entries.filter(
            (e: any) =>
              e.type === "file" && !e.path.includes("/dist/") && !e.path.includes("/node_modules/"),
          );
          this.log(`[Vite] Writing ${sourceFiles.length} files...`);
          for (const entry of sourceFiles) {
            const relPath = entry.path.replace(/^\/repo\/apps\/[^/]+\//, "");
            const content = await this.ws.readFile(`apps/${buildApp}/${relPath}`);
            if (content !== null) {
              await sandbox.writeFile(`/workspace/${relPath}`, content);
            }
          }

          this.log(`[Vite] npm install...`);
          const install = await sandbox.exec("npm install --legacy-peer-deps 2>&1", {
            timeout: 120000,
            cwd: "/workspace",
          });
          if (!install.success)
            throw new Error(`npm install failed: ${install.stdout.slice(-500)}`);

          this.log(`[Vite] vite build...`);
          const build = await sandbox.exec("npx vite build 2>&1", {
            timeout: 180000,
            cwd: "/workspace",
          });
          if (!build.success)
            throw new Error(
              `vite build failed: ${(build.stderr + "\n" + build.stdout).slice(-2000)}`,
            );
          this.log(`[Vite] Build done`);

          const serverEntry = await sandbox.readFile("/workspace/dist/server/index.js");
          const serverAssets = await sandbox.exec(
            "ls /workspace/dist/server/assets/ 2>/dev/null || echo ''",
          );
          const clientAssets = await sandbox.exec(
            "ls /workspace/dist/client/assets/ 2>/dev/null || echo ''",
          );

          const modules: Record<string, string> = {};
          modules["index.js"] = serverEntry.content;
          for (const f of serverAssets.stdout.trim().split("\n").filter(Boolean)) {
            const file = await sandbox.readFile(`/workspace/dist/server/assets/${f}`);
            modules[`assets/${f}`] = file.content;
          }

          const clientAssetFiles: string[] = [];
          for (const f of clientAssets.stdout.trim().split("\n").filter(Boolean)) {
            const file = await sandbox.readFile(`/workspace/dist/client/assets/${f}`);
            await this.ws.writeFile(`apps/${buildApp}/dist/assets/${f}`, file.content);
            clientAssetFiles.push(`/${f}`);
          }

          for (const [name, content] of Object.entries(modules)) {
            await this.ws.writeFile(`apps/${buildApp}/dist/${name}`, content);
          }

          const manifest = {
            builtAt: new Date().toISOString(),
            builtBy: "sandbox-vite",
            mainModule: "index.js",
            moduleFiles: Object.keys(modules),
            assetFiles: clientAssetFiles,
          };
          await this.ws.writeManifest(buildApp, manifest);

          this.setBuildState(buildApp, "ready");
          this.log(
            `[Vite] Done: ${manifest.moduleFiles.length} modules, ${clientAssetFiles.length} assets`,
          );

          try {
            await this.commitAndPush(`Build ${buildApp} (vite)`);
          } catch (e: any) {
            this.log(`Commit/push failed: ${e.message}`);
          }

          try {
            await sandbox.destroy();
          } catch {}

          return Response.json({
            ok: true,
            app: buildApp,
            builtBy: "sandbox-vite",
            moduleFiles: manifest.moduleFiles,
            assetFiles: clientAssetFiles,
            buildOutput: build.stdout.slice(-500),
          });
        } catch (e: any) {
          this.setBuildState(buildApp, "error");
          this.log(`[Vite] Failed: ${e.message}`);
          return Response.json({ ok: false, error: e.message, stack: e.stack }, { status: 500 });
        }
      }

      // GET /api/build-state
      if (req.method === "GET" && url.pathname === "/api/build-state") {
        return Response.json({ states: this.#buildStates, doId });
      }

      // WebSocket: log streaming
      if (req.headers.get("Upgrade") === "websocket" && url.pathname === "/api/logs") {
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].send(JSON.stringify({ type: "history", logs: this.#logBuffer }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      // GET / — editor UI
      const files = await this.ws.listFiles();
      const config = await this.ws.readFile("config.json");
      return new Response(editorHTML(slug, doId, files, config), {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
      });
    }

    // ── Level 3: App ────────────────────────────────────────────────────
    if (!app) return new Response("No app specified", { status: 400 });

    // Read config to check if app is enabled
    const configStr = (await this.ws.readFile("config.json")) ?? '{"apps":[]}';
    const config = JSON.parse(configStr) as { apps: string[] };
    if (!config.apps.includes(app)) {
      return new Response(`App "${app}" not enabled. Enabled: ${config.apps.join(", ")}`, {
        status: 404,
      });
    }

    // Runner debug UI
    if (url.pathname.startsWith("/__runner")) {
      return this.handleRunnerUI(app, url, req, slug);
    }

    // Serve app directly from shared workspace
    console.log(`[Project DO] serving app ${slug}:${app}`);
    const appResp = await this.#serveApp(app, req);
    return this.#interceptEmailReply(req, url, appResp, slug);
  }

  // Intercept email reply responses
  async #interceptEmailReply(
    req: Request,
    url: URL,
    resp: Response,
    slug: string,
  ): Promise<Response> {
    if (!(req.method === "POST" && url.pathname.match(/\/emails\/\d+\/reply$/))) return resp;
    try {
      const cloned = resp.clone();
      const body = (await cloned.json()) as any;
      if (!body.needsSend || !body.sendPayload) return resp;
      const sp = body.sendPayload;
      const threadId = await deriveThreadId(this.env.DB, sp.inReplyTo, sp.references);
      const inboxUrl = `https://agents.${slug}${PLATFORM_SUFFIX}`;
      const streamUrl = `https://${slug}.events.iterate.com/streams/agents/email/${threadId}/?renderer=raw-pretty`;
      const replyText = [
        sp.text,
        "",
        "---",
        `Inbox: ${inboxUrl}`,
        `Event stream: ${streamUrl}`,
      ].join("\n");
      const replyHtml = [
        `<p>${sp.text}</p>`,
        `<hr style="border:none;border-top:1px solid #ccc;margin:16px 0">`,
        `<p style="font-size:13px;color:#888"><a href="${inboxUrl}">Inbox</a> · <a href="${streamUrl}">Event stream</a></p>`,
      ].join("\n");
      console.log(`[Project DO] sending reply email from=${sp.from} to=${sp.to}`);
      const result = await this.env.EMAIL.send({
        from: sp.from,
        to: sp.to,
        subject: sp.subject,
        text: replyText,
        html: replyHtml,
      });
      console.log(`[Project DO] reply email sent! messageId=${result.messageId}`);
      const threadRootMessageId =
        sp.inReplyTo ?? sp.references?.match(/<[^>]+>/)?.[0] ?? result.messageId;
      await storeThreadMapping(this.env.DB, result.messageId, threadRootMessageId, slug);
      await appendEmailEvent(this.env, slug, threadId, "email-sent", {
        from: sp.from,
        to: sp.to,
        subject: sp.subject,
        inReplyTo: sp.inReplyTo,
        outboundMessageId: result.messageId,
        text: sp.text,
      });
      const { sendPayload: _, ...rest } = body;
      return Response.json(rest);
    } catch (e: any) {
      console.error(`[Project DO] email send failed: ${e.message}\n${e.stack}`);
      return resp;
    }
  }

  async handleRunnerUI(app: string, url: URL, req: Request, slug: string): Promise<Response> {
    const appDir = `apps/${app}`;
    const manifest = await this.ws.readFile(`${appDir}/dist/manifest.json`);
    const pkg = await this.ws.readFile(`${appDir}/package.json`);
    const buildState = this.getBuildState(app);

    // POST /__runner/rebuild
    if (req.method === "POST" && url.pathname === "/__runner/rebuild") {
      const buildReq = new Request(`https://internal/api/build-vite/${app}`, {
        method: "POST",
      });
      await this.fetch(buildReq);
      return Response.redirect(new URL("/__runner", req.url).toString(), 302);
    }

    // GET /__runner/files
    if (url.pathname === "/__runner/files") {
      const files = await this.ws.listFiles(appDir);
      return Response.json({ files });
    }

    // GET /__runner — debug dashboard
    const files = await this.ws.listFiles(appDir);
    const prefix = appDir + "/";
    const stripped = files.map((f: string) => (f.startsWith(prefix) ? f.slice(prefix.length) : f));
    const srcFiles = stripped.filter(
      (f: string) => !f.startsWith("dist/") && !f.includes("node_modules"),
    );
    const distFiles = stripped.filter((f: string) => f.startsWith("dist/"));
    const meta = manifest ? JSON.parse(manifest) : null;
    const pkgData = pkg ? JSON.parse(pkg) : {};
    const isBuilding = buildState === "building";

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>App Runner: ${app}</title>
${isBuilding ? '<meta http-equiv="refresh" content="5">' : ""}
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:800px;margin:0 auto}
h1{font-size:1.3rem;margin-bottom:1rem}h2{font-size:1rem;color:#888;margin:1.5rem 0 .5rem;border-bottom:1px solid #222;padding-bottom:.3rem}
pre{background:#111;border:1px solid #222;border-radius:6px;padding:.75rem;font-size:.75rem;overflow:auto;max-height:300px;color:#4ade80;line-height:1.5}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.7rem;margin-left:.5rem}
.ready{background:#052e16;color:#4ade80}.building{background:#422006;color:#fbbf24}.idle{background:#1a1a1a;color:#888}.error{background:#450a0a;color:#fca5a5}
button{background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;padding:.4rem 1rem;border-radius:6px;cursor:pointer;font-size:.85rem}
button:hover{background:#1e40af}a{color:#60a5fa}</style></head><body>
<h1>App Runner: ${app} <span class="badge ${buildState}">${buildState}</span></h1>
<p style="color:#888;margin-bottom:1rem"><a href="/">← Back to app</a> · <a href="/__runner/files">Files API</a></p>
${meta ? `<p style="font-size:.85rem">Built: ${meta.builtAt} · ${meta.moduleFiles?.length ?? "?"} server modules · ${meta.assetFiles?.length ?? "?"} client assets</p>` : `<p style="color:#f59e0b">No dist — app needs building</p>`}
<form method="POST" action="/__runner/rebuild" style="margin:1rem 0"><button type="submit"${isBuilding ? " disabled" : ""}>Rebuild in Sandbox</button>${isBuilding ? ' <span style="color:#fbbf24;font-size:.85rem">Building... (auto-refreshing)</span>' : ""}</form>
<h2>Source (${srcFiles.length} files)</h2><pre>${srcFiles.join("\n")}</pre>
${distFiles.length ? `<h2>Dist (${distFiles.length} files)</h2><pre>${distFiles.join("\n")}</pre>` : ""}
<h2>package.json</h2><pre>${JSON.stringify(pkgData, null, 2)}</pre>
<h2>Build Logs</h2><pre>${this.#logBuffer.map((l) => `${new Date(l.ts).toISOString()} ${l.message}`).join("\n") || "(empty)"}</pre>
</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
  }

  // ── WebSocket handling (ported from AppRunner) ───────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws);
    const wsTag = tags.find((t) => t.startsWith("ws:"));
    if (!wsTag) return;

    const pathname = wsTag.slice(3);

    try {
      // Derive app from the tag (format: "ws:/path" with app from "app:<appname>")
      const appTag = tags.find((t) => t.startsWith("app:"));
      const app = appTag?.slice(4);
      if (!app) return;

      const manifestStr = await this.ws.readFile(`apps/${app}/dist/manifest.json`);
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
      console.error(`[Project DO] WS dispatch error: ${e.message}`);
      try {
        ws.send(JSON.stringify({ type: "error", message: e.message }));
      } catch {}
    }
  }

  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
