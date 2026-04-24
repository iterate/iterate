// Nested Facets POC — App source code lives in Cloudflare Artifacts
//
// URL hierarchy:
//   1. iterate-dev-jonas.app              → Platform admin (CRUD projects)
//   2. <project>.iterate-dev-jonas.app    → Artifact editor (edit app source, config)
//   3. <app>.<project-or-custom-host>     → App UI (loaded from artifact source code)

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DynamicWorkerExecutor, type ToolDispatcher } from "@cloudflare/codemode";
import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import PostalMime from "postal-mime";
import { createEventsClient } from "@iterate-com/events-contract/sdk";
import {
  createApp,
  createWorker,
  InMemoryFileSystem,
  type CreateWorkerResult,
  type CreateAppResult,
} from "@cloudflare/worker-bundler";
import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import { adminHTML } from "./admin.ts";
import { editorHTML } from "./editor.ts";
export { EgressGateway } from "./egress-gateway.ts";
export { AppRunner } from "./app-runner.ts";
import { parseHost, PLATFORM_SUFFIX, PLATFORM_BARE } from "./host-parser.ts";

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
  APP_RUNNER: DurableObjectNamespace;
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
// Dynamic workers can't hold LOADER directly (DurableObjectClass handles don't
// survive RPC). This entrypoint owns the real LOADER and executes scripts on
// behalf of dynamic workers. The script is embedded as module source code.

// ResolvedProvider shape — the fns may be RPC stubs from the calling isolate.
// DynamicWorkerExecutor wraps them in ToolDispatchers which JSON-serialize args,
// so double-hop RPC (sandbox → host → caller isolate) works transparently.
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

// ── SQL Studio helpers ───────────────────────────────────────────────────────
// Embeds LibSQL Studio as an iframe and bridges postMessage ↔ DO SQLite.

function studioHTML(name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${name} — SQL Studio</title>
<style>*{margin:0;padding:0}body,html{height:100%;overflow:hidden}iframe{width:100%;height:100%;border:none}</style>
</head><body>
<iframe id="studio" src="https://libsqlstudio.com/embed/sqlite?name=${encodeURIComponent(name)}"></iframe>
<script>
window.addEventListener("message", async function(e) {
  if (e.source !== document.getElementById("studio").contentWindow) return;
  var msg = e.data;
  if (!msg || (msg.type !== "query" && msg.type !== "transaction")) return;
  try {
    var resp = await fetch("_sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg)
    });
    var result = await resp.json();
    e.source.postMessage(result, "*");
  } catch (err) {
    e.source.postMessage({ type: msg.type, id: msg.id, error: err.message }, "*");
  }
});
</script></body></html>`;
}

interface StudioQueryResult {
  rows: Record<string, unknown>[];
  headers: { name: string; displayName: string; originalType: null; type: number }[];
  stat: { rowsAffected: number; rowsRead: number; rowsWritten: number; queryDurationMs: number };
  lastInsertRowid: number;
}

function runStudioQuery(sql: SqlStorage, statement: string): StudioQueryResult {
  const cursor = sql.exec(statement);
  const cols = cursor.columnNames;
  const rows = cursor.toArray();
  const headers = cols.map((n) => ({
    name: n,
    displayName: n,
    originalType: null as null,
    type: 1,
  }));
  return {
    rows,
    headers,
    stat: {
      rowsAffected: cursor.rowsWritten,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      queryDurationMs: 0,
    },
    lastInsertRowid: 0,
  };
}

async function execSQL(sql: SqlStorage, req: Request): Promise<Response> {
  const msg = (await req.json()) as {
    type: string;
    id: number;
    statement?: string;
    statements?: string[];
  };
  try {
    if (msg.type === "query") {
      const result = runStudioQuery(sql, msg.statement!);
      return Response.json({ type: "query", id: msg.id, data: result });
    }
    if (msg.type === "transaction") {
      const results = (msg.statements ?? []).map((s) => runStudioQuery(sql, s));
      return Response.json({ type: "transaction", id: msg.id, data: results });
    }
    return Response.json({ error: "unknown type" }, { status: 400 });
  } catch (err: any) {
    return Response.json({ type: msg.type, id: msg.id, error: err.message });
  }
}

// ── Events helpers ───────────────────────────────────────────────────────────

function slugifyMessageId(messageId: string): string {
  const cleaned = messageId.replace(/^<|>$/g, "").split("@")[0];
  return cleaned
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, 64);
}

// Extract all message IDs from References and In-Reply-To headers
function extractMessageIds(references?: string | null, inReplyTo?: string | null): string[] {
  const ids: string[] = [];
  if (references) {
    const refs = references.match(/<[^>]+>/g);
    if (refs) ids.push(...refs);
  }
  if (inReplyTo) {
    const cleaned = inReplyTo.trim();
    if (cleaned && !ids.includes(cleaned)) ids.push(cleaned);
  }
  return ids;
}

// Derive thread ID, checking D1 for outbound message ID → thread root mapping.
// This handles the case where someone replies to the worker's outbound email:
// their References/In-Reply-To points to the worker's message ID, which we map
// back to the original thread root.
async function deriveThreadId(
  db: D1Database,
  messageId: string | null,
  references?: string | null,
  inReplyTo?: string | null,
): Promise<string> {
  const refIds = extractMessageIds(references, inReplyTo);

  // Check if any referenced message ID maps to a known thread root
  for (const refId of refIds) {
    const cleaned = refId.replace(/^<|>$/g, "");
    const row = await db
      .prepare("SELECT thread_root_message_id FROM email_thread_map WHERE outbound_message_id = ?")
      .bind(cleaned)
      .first<{ thread_root_message_id: string }>();
    if (row) {
      console.log(`[Thread] resolved outbound ${cleaned} → root ${row.thread_root_message_id}`);
      return slugifyMessageId(row.thread_root_message_id);
    }
  }

  // Fall back: first reference is the thread root
  if (refIds.length > 0) return slugifyMessageId(refIds[0]);
  if (messageId) return slugifyMessageId(messageId);
  return "unknown";
}

// Store mapping from outbound message ID to thread root
async function storeThreadMapping(
  db: D1Database,
  outboundMessageId: string,
  threadRootMessageId: string,
  projectSlug: string,
) {
  const cleaned = outboundMessageId.replace(/^<|>$/g, "");
  await db
    .prepare(
      "INSERT OR REPLACE INTO email_thread_map (outbound_message_id, thread_root_message_id, project_slug) VALUES (?, ?, ?)",
    )
    .bind(cleaned, threadRootMessageId, projectSlug)
    .run();
  console.log(`[Thread] stored mapping: ${cleaned} → ${threadRootMessageId}`);
}

function getEventsClient(env: Env, projectSlug: string) {
  const baseUrl = env.EVENTS_BASE_URL ?? "https://events.iterate.com";
  return createEventsClient(`https://${projectSlug}.${baseUrl.replace(/^https?:\/\//, "")}`);
}

async function appendEmailEvent(
  env: Env,
  projectSlug: string,
  threadId: string,
  type: "email-received" | "email-sent",
  payload: Record<string, unknown>,
) {
  try {
    const client = getEventsClient(env, projectSlug);
    const path = `/agents/email/${threadId}`;
    console.log(`[Events] appending ${type} to ${path}`);
    const result = await client.append({
      path,
      event: { type, payload },
    });
    console.log(`[Events] appended offset=${result.event.offset}`);
  } catch (e: any) {
    console.error(`[Events] append failed: ${e.message}`);
  }
}

interface ProjectRow {
  slug: string;
  canonical_hostname: string | null;
  config_json: string;
  artifacts_repo: string | null;
  artifacts_remote: string | null;
  created_at: string;
}

// ── CF provisioning ───────────────────────────────────────────────────────────

async function cfAPI(env: Env, method: string, path: string, body?: object): Promise<any> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return resp.json() as any;
}

async function provisionProject(env: Env, slug: string) {
  const zoneId = env.CF_ZONE_ID;
  const results = { dns: [] as string[], routes: [] as string[], mx: [] as string[] };
  for (const name of [`*.${slug}.iterate-dev-jonas.app`, `${slug}.iterate-dev-jonas.app`]) {
    const r = await cfAPI(env, "POST", `/zones/${zoneId}/dns_records`, {
      type: "AAAA",
      name,
      content: "100::",
      proxied: true,
    });
    results.dns.push(r.success ? `${name} ok` : `${name} ${r.errors?.[0]?.message}`);
  }
  // MX records for inbound email (explicit per-project, since wildcard MX is suppressed by explicit AAAA)
  for (const { content, priority } of [
    { content: "route1.mx.cloudflare.net", priority: 99 },
    { content: "route2.mx.cloudflare.net", priority: 69 },
    { content: "route3.mx.cloudflare.net", priority: 93 },
  ]) {
    const r = await cfAPI(env, "POST", `/zones/${zoneId}/dns_records`, {
      type: "MX",
      name: `${slug}.iterate-dev-jonas.app`,
      content,
      priority,
    });
    results.mx.push(r.success ? `${content} ok` : `${content} ${r.errors?.[0]?.message}`);
  }
  for (const pattern of [`*.${slug}.iterate-dev-jonas.app/*`, `${slug}.iterate-dev-jonas.app/*`]) {
    const r = await cfAPI(env, "POST", `/zones/${zoneId}/workers/routes`, {
      pattern,
      script: env.CF_WORKER_NAME,
    });
    results.routes.push(r.success ? `${pattern} ok` : `${pattern} ${r.errors?.[0]?.message}`);
  }
  return results;
}

async function deprovisionProject(env: Env, slug: string) {
  const zoneId = env.CF_ZONE_ID;
  for (const name of [`*.${slug}.iterate-dev-jonas.app`, `${slug}.iterate-dev-jonas.app`]) {
    const list = await cfAPI(
      env,
      "GET",
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    );
    for (const rec of list.result ?? [])
      await cfAPI(env, "DELETE", `/zones/${zoneId}/dns_records/${rec.id}`);
  }
  const routes = await cfAPI(env, "GET", `/zones/${zoneId}/workers/routes`);
  for (const route of routes.result ?? []) {
    if (route.pattern.includes(`${slug}.iterate-dev-jonas.app`))
      await cfAPI(env, "DELETE", `/zones/${zoneId}/workers/routes/${route.id}`);
  }
}

// ── Worker entry ──────────────────────────────────────────────────────────────

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const toAddr = message.to;
    console.log(`[Email] inbound from=${message.from} to=${toAddr}`);

    // Parse: <stream>@<project>.iterate-dev-jonas.app or <project>--<stream>@iterate-dev-jonas.app
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
      // Fallback format: <project>--<stream>@iterate-dev-jonas.app
      const sep = localPart.indexOf("--");
      if (sep === -1) {
        projectSlug = localPart;
        streamName = "default";
      } else {
        projectSlug = localPart.slice(0, sep);
        streamName = localPart.slice(sep + 2);
      }
    } else if (domain.endsWith(PLATFORM_SUFFIX)) {
      // <stream>@<project>.iterate-dev-jonas.app
      streamName = localPart;
      projectSlug = domain.slice(0, -PLATFORM_SUFFIX.length);
    } else {
      message.setReject("Unknown domain");
      return;
    }

    console.log(`[Email] project=${projectSlug} stream=${streamName}`);

    // Look up project
    const project = await env.DB.prepare("SELECT * FROM projects WHERE slug = ?")
      .bind(projectSlug)
      .first<ProjectRow>();
    if (!project) {
      message.setReject(`Project "${projectSlug}" not found`);
      return;
    }

    // Parse MIME
    const rawBytes = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(rawBytes);

    // Forward to Project DO
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

    // Extract References and In-Reply-To headers for thread tracking
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
      // Append email-received event — use References/In-Reply-To to find thread root
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

    if (url.pathname.startsWith("/admin/api/")) return handleAdminAPI(req, url, env);

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
    return env.PROJECT.get(id).fetch(req);
  },
};

// ── Admin API ─────────────────────────────────────────────────────────────────

async function handleAdminAPI(req: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname.replace("/admin/api/", "");

  if (req.method === "POST" && path === "projects") {
    const body = (await req.json()) as {
      slug: string;
      canonical_hostname?: string | null;
      apps?: string[];
    };
    const slug = body.slug?.trim();
    if (!slug || !/^[a-z0-9-]+$/.test(slug))
      return Response.json({ error: "Invalid slug" }, { status: 400 });
    const config = { apps: body.apps ?? ["agents"] };
    console.log(`[Admin] creating project ${slug}`);

    // Fork base-template artifact
    let artifactsRepo: string | null = null;
    let artifactsRemote: string | null = null;
    try {
      const baseRepo = await env.ARTIFACTS.get("base-template");
      const forked = await baseRepo.fork(`project-${slug}`);
      artifactsRepo = forked.name;
      artifactsRemote = forked.remote;
      console.log(`[Admin] forked base-template → ${artifactsRepo}`);
    } catch (e: any) {
      console.error("[Admin] fork failed:", e.message);
      // Fallback: create empty repo
      try {
        const repo = await env.ARTIFACTS.create(`project-${slug}`);
        artifactsRepo = repo.name;
        artifactsRemote = repo.remote;
      } catch (e2: any) {
        console.error("[Admin] create failed too:", e2.message);
      }
    }

    const provision = await provisionProject(env, slug);
    await env.DB.prepare(
      "INSERT INTO projects (slug, canonical_hostname, config_json, artifacts_repo, artifacts_remote) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        slug,
        body.canonical_hostname ?? null,
        JSON.stringify(config),
        artifactsRepo,
        artifactsRemote,
      )
      .run();

    // Store artifact info in the Project DO's own SQLite
    if (artifactsRepo && artifactsRemote) {
      const id = env.PROJECT.idFromName(slug);
      const stub = env.PROJECT.get(id);
      await stub.setup(slug, artifactsRemote, artifactsRepo);
      // AppRunners are set up lazily on first request per app
    }

    return Response.json(
      { ok: true, slug, config, artifactsRepo, artifactsRemote, provision },
      { status: 201 },
    );
  }

  const deleteMatch = path.match(/^projects\/([a-z0-9-]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const slug = deleteMatch[1];
    try {
      await env.ARTIFACTS.delete(`project-${slug}`);
    } catch (e: any) {
      console.error(e.message);
    }
    await deprovisionProject(env, slug);
    await env.DB.prepare("DELETE FROM projects WHERE slug = ?").bind(slug).run();
    return new Response("deleted");
  }

  // ── Secrets API ──

  if (req.method === "GET" && path === "secrets") {
    const project = url.searchParams.get("project");
    if (!project) return Response.json({ error: "project query param required" }, { status: 400 });
    const rows = await env.DB.prepare(
      "SELECT name, created_at FROM secrets WHERE project_slug = ? ORDER BY name",
    )
      .bind(project)
      .all<{ name: string; created_at: string }>();
    return Response.json({ secrets: rows.results });
  }

  if (req.method === "POST" && path === "secrets") {
    const body = (await req.json()) as { project_slug: string; name: string; value: string };
    if (!body.project_slug || !body.name || !body.value) {
      return Response.json({ error: "project_slug, name, and value required" }, { status: 400 });
    }
    const key = `${body.project_slug}:${body.name}`;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO secrets (key, project_slug, name, value) VALUES (?, ?, ?, ?)",
    )
      .bind(key, body.project_slug, body.name, body.value)
      .run();
    return Response.json({ ok: true, key }, { status: 201 });
  }

  const secretDeleteMatch = path.match(/^secrets\/([a-z0-9-]+)\/(.+)$/);
  if (req.method === "DELETE" && secretDeleteMatch) {
    const [, project, name] = secretDeleteMatch;
    const key = `${project}:${name}`;
    await env.DB.prepare("DELETE FROM secrets WHERE key = ?").bind(key).run();
    return Response.json({ ok: true, deleted: key });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

// ── Project DO ────────────────────────────────────────────────────────────────

const REPO_DIR = "/repo";
const GIT_AUTHOR = { name: "POC Editor", email: "poc@iterate.com" };

type BuildState = "idle" | "building" | "ready" | "error";

export class Project extends DurableObject<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.WORKSPACE_R2,
    name: () => `project-${this.ctx.id}`,
  });
  fs = new WorkspaceFileSystem(this.workspace);
  git = createGit(this.fs, REPO_DIR);

  #cloned = false;
  #bundleVersion = 0;
  #buildStates: Record<string, BuildState> = {};
  #logBuffer: Array<{ ts: number; message: string }> = [];
  #facetsTableReady = false;
  #metaReady = false;

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

  // Called by admin API after project creation to store artifact info
  async setup(slug: string, artifactsRemote: string, artifactsRepo: string) {
    this.#setMeta("slug", slug);
    this.#setMeta("artifacts_remote", artifactsRemote);
    this.#setMeta("artifacts_repo", artifactsRepo);
    console.log(`[Project DO] setup: slug=${slug} repo=${artifactsRepo}`);
  }

  #notifyAppRunner(slug: string, app: string) {
    try {
      const runnerId = this.env.APP_RUNNER.idFromName(`${slug}:${app}`);
      const runner = this.env.APP_RUNNER.get(runnerId) as unknown as {
        notifyBuild(): Promise<void>;
      };
      this.ctx.waitUntil(runner.notifyBuild());
    } catch (e: any) {
      console.error(`[Project DO] notifyAppRunner failed: ${e.message}`);
    }
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

  // Derive level + app from hostname. Only uses the platform suffix pattern —
  // the worker already resolved custom domains before proxying here.
  #parseLevel(host: string): { level: "project" | "app"; app: string | null } {
    if (host.endsWith(PLATFORM_SUFFIX)) {
      const prefix = host.slice(0, -PLATFORM_SUFFIX.length);
      const dot = prefix.indexOf(".");
      if (dot !== -1) return { level: "app", app: prefix.slice(0, dot) };
    }
    // Custom domains: the slug portion is already handled by the worker routing.
    // If the host has a subdomain before the project's custom domain, it's an app.
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

  async ensureCloned(remote: string, repoName: string): Promise<void> {
    if (this.#cloned) return;
    const hasGit = await this.workspace.exists(`${REPO_DIR}/.git/config`);
    if (hasGit) {
      console.log(`[Project DO] repo already cloned in SQLite`);
      this.#cloned = true;
      return;
    }
    console.log(`[Project DO] cloning ${repoName} from artifacts...`);
    const token = await this.#getWriteToken(repoName);
    await this.workspace.mkdir(REPO_DIR, { recursive: true });
    await this.git.clone({
      url: remote,
      dir: REPO_DIR,
      ...this.#gitAuth(token),
    });
    this.#cloned = true;
    console.log(`[Project DO] clone complete`);
  }

  async #getWriteToken(repoName: string): Promise<string> {
    // Workers binding .get() returns the repo handle directly
    const repo = await this.env.ARTIFACTS.get(repoName);
    const tokenResult = await repo.createToken("write", 3600);
    const token = tokenResult.plaintext ?? tokenResult.token ?? String(tokenResult);
    console.log(`[Project DO] got token for ${repoName}: ${String(token).slice(0, 15)}...`);
    return token;
  }

  #gitAuth(token: string) {
    if (!token || typeof token !== "string") {
      console.error(`[Project DO] invalid token: ${typeof token}`);
      return { username: "x", password: "" };
    }
    const secret = token.split("?expires=")[0];
    return { username: "x", password: secret };
  }

  async readFile(path: string): Promise<string | null> {
    return this.workspace.readFile(`${REPO_DIR}/${path}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = `${REPO_DIR}/${path}`;
    const dir = fullPath.split("/").slice(0, -1).join("/");
    await this.workspace.mkdir(dir, { recursive: true });
    await this.workspace.writeFile(fullPath, content);
  }

  async commitAndPush(message: string, repoName: string): Promise<string> {
    await this.git.add({ filepath: ".", dir: REPO_DIR });
    const result = await this.git.commit({ message, author: GIT_AUTHOR, dir: REPO_DIR });
    const token = await this.#getWriteToken(repoName);
    await this.git.push({ dir: REPO_DIR, remote: "origin", ...this.#gitAuth(token) });
    this.#bundleVersion++;
    console.log(`[Project DO] pushed commit ${result.oid}`);
    return result.oid;
  }

  async rebaseFromBase(
    repoName: string,
    ownRemote: string,
    force = false,
  ): Promise<{ pulled: boolean; oid: string | null; forced: boolean }> {
    console.log(`[Project DO] rebasing from base-template...`);
    const baseRepo = await this.env.ARTIFACTS.get("base-template");
    const baseTokenResult = await baseRepo.createToken("read", 3600);
    const baseTokenStr =
      baseTokenResult.plaintext ?? baseTokenResult.token ?? String(baseTokenResult);
    // Derive base remote from our own remote URL (same account/namespace, different repo name)
    const baseRemote = ownRemote.replace(`/${repoName}.git`, "/base-template.git");
    console.log(`[Project DO] base remote: ${baseRemote}`);
    const baseAuth = this.#gitAuth(baseTokenStr);

    if (force) {
      // Force rebase: nuke workspace, clone from base-template, push to origin
      console.log(`[Project DO] force rebase: resetting to base-template`);
      await this.workspace.rm(REPO_DIR, { force: true, recursive: true });
      this.#cloned = false;
      await this.workspace.mkdir(REPO_DIR, { recursive: true });
      await this.git.clone({ url: baseRemote, dir: REPO_DIR, ...baseAuth });

      // Re-point origin to our repo (plain URL, no embedded token) and force-push
      try {
        await this.git.remote({ dir: REPO_DIR, remove: "origin" });
      } catch {}
      await this.git.remote({ dir: REPO_DIR, add: { name: "origin", url: ownRemote } });
      const ownToken = await this.#getWriteToken(repoName);
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
    console.log(`[Project DO] pull result: pulled=${pullResult.pulled}`);

    let oid: string | null = null;
    if (pullResult.pulled) {
      const token = await this.#getWriteToken(repoName);
      await this.git.push({ dir: REPO_DIR, remote: "origin", ...this.#gitAuth(token) });
      const log = await this.git.log({ dir: REPO_DIR, depth: 1 });
      oid = log[0]?.oid ?? null;
      console.log(`[Project DO] pushed rebased result: ${oid}`);
    }

    return { pulled: pullResult.pulled, oid, forced: false };
  }

  async listFiles(dir = ""): Promise<string[]> {
    const fullDir = dir ? `${REPO_DIR}/${dir}` : REPO_DIR;
    const entries = await this.workspace.glob(`${fullDir}/**/*`);
    return entries
      .filter((e: any) => e.type === "file" && !e.path.includes("/.git/"))
      .map((e: any) => e.path.replace(`${REPO_DIR}/`, ""));
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

  async writeDistFiles(app: string, result: CreateWorkerResult | CreateAppResult): Promise<void> {
    // Clean old dist
    const distDir = `${REPO_DIR}/apps/${app}/dist`;
    try {
      await this.workspace.rm(distDir, { force: true, recursive: true });
    } catch {}
    await this.workspace.mkdir(distDir, { recursive: true });

    // Write modules
    for (const [name, content] of Object.entries(result.modules)) {
      const value =
        typeof content === "string"
          ? content
          : ((content as any).js ?? (content as any).text ?? "");
      await this.writeFile(`apps/${app}/dist/${name}`, value);
    }

    // Collect asset file keys
    const assetKeys: string[] = [];

    // Write assets if present (createApp result) — to workspace only
    if ("assets" in result && result.assets) {
      for (const [name, content] of Object.entries(result.assets)) {
        const fullPath = `${REPO_DIR}/apps/${app}/dist/assets${name}`;
        const dir = fullPath.split("/").slice(0, -1).join("/");
        await this.workspace.mkdir(dir, { recursive: true });
        if (typeof content === "string") {
          await this.workspace.writeFile(fullPath, content);
        } else {
          const bytes = new Uint8Array(content as ArrayBuffer);
          await this.workspace.writeFileBytes(fullPath, bytes);
        }
        assetKeys.push(name);
      }
    }

    // Generate index.html if not already in assets
    if ("assets" in result && !assetKeys.includes("/index.html")) {
      let html = await this.readFile(`apps/${app}/index.html`);
      if (!html) {
        html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${app}</title></head><body><div id="root"></div></body></html>`;
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
      await this.writeFile(`apps/${app}/dist/assets/index.html`, html);
      assetKeys.push("/index.html");
    }

    // Write manifest
    const manifest = {
      mainModule: result.mainModule,
      moduleFiles: Object.keys(result.modules),
      assetFiles: assetKeys,
      builtAt: new Date().toISOString(),
    };
    await this.writeFile(`apps/${app}/dist/manifest.json`, JSON.stringify(manifest, null, 2));
  }

  // Build an app in a sandbox container using esbuild (for heavy deps like agents SDK)
  async buildInSandbox(app: string, buildConfig: Record<string, any>): Promise<Response> {
    this.log(`[Sandbox] Building ${app}...`);
    this.setBuildState(app, "building");

    try {
      const sandbox = getSandbox(this.env.BUILD_SANDBOX, `esbuild-${app}`);

      // Write source files to sandbox
      const appDir = `${REPO_DIR}/apps/${app}`;
      const entries = await this.workspace.glob(`${appDir}/**/*`);
      const sourceFiles = entries.filter(
        (e: any) =>
          e.type === "file" && !e.path.includes("/dist/") && !e.path.includes("/node_modules/"),
      );
      for (const entry of sourceFiles) {
        const content = await this.workspace.readFile(entry.path);
        if (content !== null) {
          const relPath = entry.path.replace(appDir + "/", "");
          await sandbox.writeFile(`/workspace/${relPath}`, content);
        }
      }
      this.log(`[Sandbox] Wrote ${sourceFiles.length} files`);

      // Install npm deps
      const install = await sandbox.exec("npm install --legacy-peer-deps 2>&1", {
        timeout: 120_000,
        cwd: "/workspace",
      });
      if (!install.success) {
        throw new Error(`npm install failed: ${(install.stdout + install.stderr).slice(-500)}`);
      }
      this.log("[Sandbox] npm install done");

      // Build server (worker.ts) with esbuild
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

      // Build client (if client.tsx exists)
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

        // Read client assets
        const lsAssets = await sandbox.exec("ls dist/assets/ 2>/dev/null || echo ''", {
          cwd: "/workspace",
        });
        for (const f of lsAssets.stdout.trim().split("\n").filter(Boolean)) {
          const file = await sandbox.readFile(`/workspace/dist/assets/${f}`);
          await this.writeFile(`apps/${app}/dist/assets/${f}`, file.content);
          assetFiles.push(`assets/${f}`);
        }

        // Generate index.html
        const htmlSrc = sourceFiles.find((e: any) => e.path.endsWith("/index.html"));
        let html = htmlSrc
          ? ((await this.workspace.readFile(htmlSrc.path)) ??
            "<html><body><div id='root'></div></body></html>")
          : "<html><body><div id='root'></div></body></html>";
        html = html.replace(
          "</body>",
          '<script type="module" src="/assets/client.js"></script></body>',
        );
        await this.writeFile(`apps/${app}/dist/assets/index.html`, html);
        assetFiles.push("assets/index.html");
        this.log("[Sandbox] client build done");
      }

      // Read server bundle
      const serverBundle = await sandbox.readFile("/workspace/dist/bundle.js");
      await this.writeFile(`apps/${app}/dist/bundle.js`, serverBundle.content);

      // Write manifest
      const manifest = {
        builtAt: new Date().toISOString(),
        builtBy: "sandbox-esbuild",
        mainModule: "bundle.js",
        moduleFiles: ["bundle.js"],
        assetFiles,
      };
      await this.writeFile(`apps/${app}/dist/manifest.json`, JSON.stringify(manifest, null, 2));

      // Cleanup
      try {
        await sandbox.destroy();
      } catch {}

      this.setBuildState(app, "ready");
      this.log(`[Sandbox] Build complete: ${app}`);

      // Commit dist to artifact repo + notify AppRunner
      if (this.repoName) {
        try {
          await this.commitAndPush(`Build ${app} (esbuild)`, this.repoName);
        } catch (e: any) {
          this.log(`Commit/push failed: ${e.message}`);
        }
      }
      this.#notifyAppRunner(this.slug, app);

      const files = await this.listFiles();
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

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.hostname;
    const doId = this.ctx.id.toString();

    // Derive level/app from Host header (no D1 — uses platform suffix only)
    const { level, app } = this.#parseLevel(host);

    // Read artifact info from own SQLite (set by admin API via setup())
    const slug = this.slug;
    const remote = this.remote;
    const repoName = this.repoName;

    console.log(
      `[Project DO] id=${doId} slug=${slug} level=${level} app=${app} path=${url.pathname}`,
    );

    // Ensure artifact is cloned
    if (remote && repoName) {
      try {
        await this.ensureCloned(remote, repoName);
      } catch (e: any) {
        console.error(`[Project DO] clone failed: ${e.message}`);
      }
    }

    // Rebase from base-template
    if (req.method === "POST" && url.pathname === "/api/rebase") {
      if (!repoName || !remote)
        return Response.json({ error: "no artifacts repo" }, { status: 400 });
      const force = url.searchParams.get("force") === "1";
      try {
        const result = await this.rebaseFromBase(repoName, remote, force);
        const files = await this.listFiles();
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
      const hasGit = await this.workspace.exists(`${REPO_DIR}/.git/config`);
      const files = await this.listFiles();
      let cloneError: string | null = null;
      if (!hasGit && remote && repoName) {
        try {
          await this.ensureCloned(remote, repoName);
        } catch (e: any) {
          cloneError = e.message + "\n" + e.stack;
        }
      }
      const filesAfter = await this.listFiles();
      return Response.json({
        doId,
        slug,
        level,
        app,
        remote,
        repoName,
        hasGit,
        cloned: this.#cloned,
        filesBefore: files,
        filesAfter,
        cloneError,
      });
    }

    // ── Level 2: Artifact editor ────────────────────────────────────────
    if (level === "project") {
      // ── SQL Studio (Project DO) ──
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
        const files = await this.listFiles();
        return Response.json({ files, doId });
      }

      // GET /api/files/:path — read file
      if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
        const path = decodeURIComponent(url.pathname.replace("/api/files/", ""));
        const content = await this.readFile(path);
        if (content === null) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ path, content, doId });
      }

      // PUT /api/files/:path — write file + commit + push
      if (req.method === "PUT" && url.pathname.startsWith("/api/files/")) {
        const path = decodeURIComponent(url.pathname.replace("/api/files/", ""));
        const body = (await req.json()) as { content: string };
        await this.writeFile(path, body.content);
        let oid: string | null = null;
        if (repoName) {
          try {
            oid = await this.commitAndPush(`Update ${path}`, repoName);
          } catch (e: any) {
            console.error(`[Project DO] commit/push failed: ${e.message}`);
          }
        }
        return Response.json({ ok: true, path, oid, doId });
      }

      // POST /api/build/:app — bundle an app
      const buildMatch = url.pathname.match(/^\/api\/build\/([a-z0-9-]+)$/);
      if (req.method === "POST" && buildMatch) {
        const buildApp = buildMatch[1];

        // Check if app needs sandbox build (too heavy for DO-based bundler)
        const buildPkgStr = await this.readFile(`apps/${buildApp}/package.json`);
        const buildPkg = buildPkgStr ? JSON.parse(buildPkgStr) : {};
        if (buildPkg.buildConfig?.localBuildOnly || buildPkg.buildConfig?.sandboxBuild) {
          // Redirect to sandbox build if configured, otherwise use existing dist
          if (buildPkg.buildConfig?.sandboxBuild) {
            return this.buildInSandbox(buildApp, buildPkg.buildConfig);
          }
          const hasDist = await this.readFile(`apps/${buildApp}/dist/manifest.json`);
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
          const fs = await this.snapshotAppFiles(buildApp);
          this.log(`Snapshotted source files for ${buildApp}`);

          // Detect if this is a full-stack app (has client entry)
          const clientEntry = fs.read("client.tsx")
            ? "client.tsx"
            : fs.read("client.ts")
              ? "client.ts"
              : fs.read("client.jsx")
                ? "client.jsx"
                : null;

          this.log(`Client entry: ${clientEntry ?? "none (server-only)"}`);

          // Read app-level build config from package.json
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
          await this.writeDistFiles(buildApp, result);

          let oid: string | null = null;
          if (repoName) {
            try {
              oid = await this.commitAndPush(`Build ${buildApp}`, repoName);
              this.log(`Pushed build commit: ${oid?.slice(0, 8)}`);
            } catch (e: any) {
              this.log(`Commit/push failed: ${e.message}`);
            }
          }

          this.setBuildState(buildApp, "ready");
          this.log(`Build complete: ${buildApp}`);

          // Notify AppRunner to pull latest
          this.#notifyAppRunner(slug, buildApp);

          const files = await this.listFiles();
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

      // POST /api/build-vite/:app — build a Vite app in a Sandbox container.
      // Uses the app's own vite.config.ts/wrangler.jsonc/package.json.
      // The server entry (index.js) exports `class App` directly — no wrapper generated.
      const viteBuildMatch = url.pathname.match(/^\/api\/build-vite\/([a-z0-9-]+)$/);
      if (req.method === "POST" && viteBuildMatch) {
        const buildApp = viteBuildMatch[1];
        this.log(`[Vite] Building ${buildApp} in sandbox...`);
        this.setBuildState(buildApp, "building");

        try {
          const sandbox = getSandbox(this.env.BUILD_SANDBOX, `vite-build-${buildApp}`);
          const appDir = `${REPO_DIR}/apps/${buildApp}`;

          // 1. Write source files to sandbox (app's own configs are used as-is)
          const entries = await this.workspace.glob(`${appDir}/**/*`);
          const sourceFiles = entries.filter(
            (e: any) =>
              e.type === "file" && !e.path.includes("/dist/") && !e.path.includes("/node_modules/"),
          );
          this.log(`[Vite] Writing ${sourceFiles.length} files...`);
          for (const entry of sourceFiles) {
            const content = await this.workspace.readFile(entry.path);
            if (content !== null) {
              const relPath = entry.path.replace(appDir + "/", "");
              await sandbox.writeFile(`/workspace/${relPath}`, content);
            }
          }

          // 2. Install + build
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

          // 3. Read build output — index.js exports App directly, no wrapper needed
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
            await this.writeFile(`apps/${buildApp}/dist/assets/${f}`, file.content);
            clientAssetFiles.push(`/${f}`);
          }

          for (const [name, content] of Object.entries(modules)) {
            await this.writeFile(`apps/${buildApp}/dist/${name}`, content);
          }

          const manifest = {
            builtAt: new Date().toISOString(),
            builtBy: "sandbox-vite",
            mainModule: "index.js",
            moduleFiles: Object.keys(modules),
            assetFiles: clientAssetFiles,
          };
          await this.writeFile(
            `apps/${buildApp}/dist/manifest.json`,
            JSON.stringify(manifest, null, 2),
          );

          this.setBuildState(buildApp, "ready");
          this.log(
            `[Vite] Done: ${manifest.moduleFiles.length} modules, ${clientAssetFiles.length} assets`,
          );

          // Commit dist to artifact repo + notify AppRunner
          if (repoName) {
            try {
              await this.commitAndPush(`Build ${buildApp} (vite)`, repoName);
            } catch (e: any) {
              this.log(`Commit/push failed: ${e.message}`);
            }
          }
          this.#notifyAppRunner(slug, buildApp);

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

      // GET /api/build-state — get build states for all apps
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
      const files = await this.listFiles();
      const config = await this.readFile("config.json");
      return new Response(editorHTML(slug, doId, files, config), {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
      });
    }

    // ── Level 3: App ────────────────────────────────────────────────────
    if (!app) return new Response("No app specified", { status: 400 });

    // Read config to check if app is enabled
    const configStr = (await this.readFile("config.json")) ?? '{"apps":[]}';
    const config = JSON.parse(configStr) as { apps: string[] };
    if (!config.apps.includes(app)) {
      return new Response(`App "${app}" not enabled. Enabled: ${config.apps.join(", ")}`, {
        status: 404,
      });
    }

    // ── App Runner debug UI at /__runner/* ──
    if (url.pathname.startsWith("/__runner")) {
      return this.handleRunnerUI(app, url, req, slug, remote, repoName);
    }

    // Delegate to AppRunner DO — it owns its own workspace + facets
    const runnerId = this.env.APP_RUNNER.idFromName(`${slug}:${app}`);
    const runner = this.env.APP_RUNNER.get(runnerId) as unknown as {
      setup(remote: string, repoName: string, app: string): Promise<void>;
      fetch(req: Request): Promise<Response>;
    };
    if (remote && repoName) await runner.setup(remote, repoName, app);
    console.log(`[Project DO] → AppRunner ${slug}:${app}`);
    const appResp = await runner.fetch(req);
    return this.#interceptEmailReply(req, url, appResp, slug);
  }

  // Intercept email reply responses — sends outbound email via env.EMAIL
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

  async handleRunnerUI(
    app: string,
    url: URL,
    req: Request,
    slug: string,
    remote: string | null,
    repoName: string | null,
  ): Promise<Response> {
    const appDir = `apps/${app}`;
    const manifest = await this.readFile(`${appDir}/dist/manifest.json`);
    const pkg = await this.readFile(`${appDir}/package.json`);
    const buildState = this.getBuildState(app);

    // POST /__runner/rebuild — trigger a rebuild via the project-level endpoint
    if (req.method === "POST" && url.pathname === "/__runner/rebuild") {
      const headers = new Headers();
      headers.set("x-level", "project");
      headers.set("x-project-slug", slug);
      if (remote) headers.set("x-artifacts-remote", remote);
      if (repoName) headers.set("x-artifacts-repo", repoName);
      const buildReq = new Request(`https://internal/api/build-vite/${app}`, {
        method: "POST",
        headers,
      });
      const resp = await this.fetch(buildReq);
      // Redirect back to runner UI after triggering
      return Response.redirect(new URL("/__runner", req.url).toString(), 302);
    }

    // GET /__runner/files — list source files as JSON
    if (url.pathname === "/__runner/files") {
      const files = await this.listFiles(appDir);
      return Response.json({ files });
    }

    // GET /__runner — debug dashboard
    const files = await this.listFiles(appDir);
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

  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
