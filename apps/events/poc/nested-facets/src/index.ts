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
  WORKSPACE_R2: R2Bucket;
  AI: Ai;
  AI_PROXY: Service<typeof AiProxy>;
  CODE_EXECUTOR: Service<CodeExecutor>;
}

// ── Binding proxy ────────────────────────────────────────────────────────────
// Returns a WorkerEntrypoint subclass that proxies all property access / method
// calls to env[bindingName]. Expose as a self-referencing service binding, then
// pass it into a dynamic worker's env — the dynamic worker sees the real binding.

function createBindingProxy<E extends Record<string, unknown>>(bindingName: keyof E & string) {
  return class BindingProxy extends WorkerEntrypoint<E> {
    constructor(ctx: any, env: E) {
      super(ctx, env);
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          const binding = target.env[bindingName] as any;
          const val = binding[prop];
          if (typeof val === "function") return val.bind(binding);
          return val;
        },
      });
    }
  };
}

export const AiProxy = createBindingProxy<Env>("AI");

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

// ── Egress runtime wrapper ───────────────────────────────────────────────────
// Prepended to dynamically loaded app modules. Wraps globalThis.fetch so every
// outbound request includes x-iterate-project-slug, allowing the EgressGateway
// to look up and substitute secret references.

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

// ── Host parsing ──────────────────────────────────────────────────────────────

const PLATFORM_SUFFIX = ".iterate-dev-jonas.app";
const PLATFORM_BARE = "iterate-dev-jonas.app";

type Parsed =
  | { level: "admin" }
  | { level: "project"; project: string }
  | { level: "app"; project: string; app: string };

async function parseHost(host: string, db: D1Database): Promise<Parsed | null> {
  if (host === PLATFORM_BARE || host === `www.${PLATFORM_BARE}` || host.endsWith(".workers.dev")) {
    return { level: "admin" };
  }
  if (host.endsWith(PLATFORM_SUFFIX)) {
    const prefix = host.slice(0, -PLATFORM_SUFFIX.length);
    const dot = prefix.indexOf(".");
    if (dot === -1) return { level: "project", project: prefix };
    return { level: "app", app: prefix.slice(0, dot), project: prefix.slice(dot + 1) };
  }
  const projects = await db
    .prepare("SELECT slug, canonical_hostname FROM projects WHERE canonical_hostname IS NOT NULL")
    .all<ProjectRow>();
  for (const p of projects.results) {
    const domain = p.canonical_hostname!;
    if (host === domain) return { level: "project", project: p.slug };
    if (host.endsWith(`.${domain}`)) {
      return { level: "app", app: host.slice(0, -(domain.length + 1)), project: p.slug };
    }
  }
  return null;
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
    console.log(`[Worker] ${req.method} ${url.hostname}${url.pathname}`);

    if (url.pathname.startsWith("/admin/api/")) return handleAdminAPI(req, url, env);

    const parsed = await parseHost(url.hostname, env.DB);
    if (!parsed) return new Response("Unknown host", { status: 404 });

    // Level 1: Admin
    if (parsed.level === "admin") {
      // /base and /base/* — route to a special Project DO for base-template editing
      if (url.pathname === "/base" || url.pathname.startsWith("/base/")) {
        // Derive base-template remote from any existing project's artifacts_remote
        let baseRemote: string | null = null;
        const anyProject = await env.DB.prepare(
          "SELECT artifacts_remote, artifacts_repo FROM projects WHERE artifacts_remote IS NOT NULL LIMIT 1",
        ).first<ProjectRow>();
        if (anyProject?.artifacts_remote && anyProject?.artifacts_repo) {
          baseRemote = anyProject.artifacts_remote.replace(
            `/${anyProject.artifacts_repo}.git`,
            "/base-template.git",
          );
        }
        if (!baseRemote) {
          return new Response("No projects exist yet — cannot derive base-template remote URL", {
            status: 400,
          });
        }

        const id = env.PROJECT.idFromName("__base");
        const stub = env.PROJECT.get(id);

        // Rewrite path: strip /base prefix so the DO sees / and /api/...
        const rewrittenPath = url.pathname === "/base" ? "/" : url.pathname.slice("/base".length);
        const rewrittenUrl = new URL(rewrittenPath + url.search, url.origin);

        const headers = new Headers(req.headers);
        headers.set("x-level", "project");
        headers.set("x-project-slug", "__base");
        headers.set("x-artifacts-remote", baseRemote);
        headers.set("x-artifacts-repo", "base-template");
        headers.set("x-config", JSON.stringify({ apps: [] }));

        const fwdInit: RequestInit = { method: req.method, headers };
        if (req.method !== "GET" && req.method !== "HEAD") fwdInit.body = req.body;
        return stub.fetch(new Request(rewrittenUrl.toString(), fwdInit));
      }

      const projects = await env.DB.prepare(
        "SELECT * FROM projects ORDER BY created_at DESC",
      ).all<ProjectRow>();
      return new Response(adminHTML(projects.results), {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
      });
    }

    const project = await env.DB.prepare("SELECT * FROM projects WHERE slug = ?")
      .bind(parsed.project)
      .first<ProjectRow>();
    if (!project) return new Response(`Project "${parsed.project}" not found`, { status: 404 });

    // Redirect platform→custom domain if configured
    if (project.canonical_hostname && url.hostname.endsWith(PLATFORM_SUFFIX)) {
      const target =
        parsed.level === "app"
          ? `https://${(parsed as any).app}.${project.canonical_hostname}${url.pathname}${url.search}`
          : `https://${project.canonical_hostname}${url.pathname}${url.search}`;
      return Response.redirect(target, 302);
    }

    // Everything under a project goes through the Project DO
    const id = env.PROJECT.idFromName(parsed.project);
    const stub = env.PROJECT.get(id);

    // For WebSocket: routing info goes in query params (overriding headers loses the
    // internal WebSocket upgrade flag). For normal requests: use headers as before.
    let doResp: Response;
    if (req.headers.get("Upgrade") === "websocket") {
      const wsUrl = new URL(req.url);
      wsUrl.searchParams.set("_level", parsed.level);
      wsUrl.searchParams.set("_slug", parsed.project);
      if (parsed.level === "app") wsUrl.searchParams.set("_app", (parsed as any).app);
      if (project.artifacts_remote) wsUrl.searchParams.set("_remote", project.artifacts_remote);
      if (project.artifacts_repo) wsUrl.searchParams.set("_repo", project.artifacts_repo);
      wsUrl.searchParams.set("_config", project.config_json);
      doResp = await stub.fetch(new Request(wsUrl.toString(), req));
    } else {
      const headers = new Headers(req.headers);
      headers.set("x-level", parsed.level);
      headers.set("x-project-slug", parsed.project);
      if (parsed.level === "app") headers.set("x-app", (parsed as any).app);
      if (project.artifacts_remote) headers.set("x-artifacts-remote", project.artifacts_remote);
      if (project.artifacts_repo) headers.set("x-artifacts-repo", project.artifacts_repo);
      headers.set("x-config", project.config_json);
      doResp = await stub.fetch(new Request(req, { headers }));
    }

    // Intercept reply responses that need outbound email sending
    // (the facet can't access SEND_EMAIL, so the outer worker handles it)
    if (req.method === "POST" && url.pathname.match(/\/emails\/\d+\/reply$/)) {
      try {
        const cloned = doResp.clone();
        const body = (await cloned.json()) as any;
        console.log(`[Worker] reply intercept: needsSend=${body.needsSend}`);
        if (body.needsSend && body.sendPayload) {
          const sp = body.sendPayload;
          // Derive thread root before sending so we can include deep links
          const threadId = await deriveThreadId(env.DB, sp.inReplyTo, sp.references);
          const inboxUrl = `https://agents.${parsed.project}${PLATFORM_SUFFIX}`;
          const streamUrl = `https://${parsed.project}.events.iterate.com/streams/agents/email/${threadId}/?renderer=raw-pretty`;
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
            `<p style="font-size:13px;color:#888">`,
            `<a href="${inboxUrl}">Inbox</a> · <a href="${streamUrl}">Event stream</a>`,
            `</p>`,
          ].join("\n");
          console.log(`[Worker] sending reply email from=${sp.from} to=${sp.to}`);
          const result = await env.EMAIL.send({
            from: sp.from,
            to: sp.to,
            subject: sp.subject,
            text: replyText,
            html: replyHtml,
          });
          console.log(`[Worker] reply email sent! messageId=${result.messageId}`);
          // Store mapping: outbound message ID → thread root, so future replies resolve correctly
          const threadRootMessageId =
            sp.inReplyTo ?? sp.references?.match(/<[^>]+>/)?.[0] ?? result.messageId;
          await storeThreadMapping(env.DB, result.messageId, threadRootMessageId, parsed.project);
          await appendEmailEvent(env, parsed.project, threadId, "email-sent", {
            from: sp.from,
            to: sp.to,
            subject: sp.subject,
            inReplyTo: sp.inReplyTo,
            outboundMessageId: result.messageId,
            text: sp.text,
          });
          const { sendPayload: _, ...rest } = body;
          return Response.json(rest);
        }
      } catch (e: any) {
        console.error(`[Worker] email send failed: ${e.message}\n${e.stack}`);
        // Return the original DO response on failure
      }
    }

    return doResp;
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

    // Write assets if present (createApp result) — supports binary via writeFileBytes
    if ("assets" in result && result.assets) {
      for (const [name, content] of Object.entries(result.assets)) {
        const fullPath = `${REPO_DIR}/apps/${app}/dist/assets${name}`;
        const dir = fullPath.split("/").slice(0, -1).join("/");
        await this.workspace.mkdir(dir, { recursive: true });
        if (typeof content === "string") {
          await this.workspace.writeFile(fullPath, content);
        } else {
          // ArrayBuffer from bundler → write as binary
          await this.workspace.writeFileBytes(fullPath, new Uint8Array(content as ArrayBuffer));
        }
        assetKeys.push(name);
      }
    }

    // Generate index.html if not already in assets — inject client bundle script tags
    if ("assets" in result && !assetKeys.includes("/index.html")) {
      // Read source index.html from the app
      let html = await this.readFile(`apps/${app}/index.html`);
      if (!html) {
        html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${app}</title></head><body><div id="root"></div></body></html>`;
      }
      // Inject client bundle script tags before </body>
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

  inferContentType(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      js: "application/javascript",
      mjs: "application/javascript",
      css: "text/css",
      html: "text/html;charset=utf-8",
      json: "application/json",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      ico: "image/x-icon",
      woff2: "font/woff2",
      woff: "font/woff",
      ttf: "font/ttf",
      otf: "font/otf",
      mp4: "video/mp4",
      webm: "video/webm",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      wasm: "application/wasm",
      pdf: "application/pdf",
      txt: "text/plain",
      xml: "application/xml",
    };
    return map[ext] ?? "application/octet-stream";
  }

  isTextContentType(ct: string): boolean {
    return (
      ct.startsWith("text/") ||
      ct.includes("json") ||
      ct.includes("javascript") ||
      ct.includes("xml") ||
      ct.includes("svg")
    );
  }

  async serveDistAsset(app: string, meta: any, req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    let assetPath = url.pathname === "/" ? "/index.html" : url.pathname;

    // Try exact match in asset files
    for (const af of meta.assetFiles) {
      if (assetPath === af || assetPath === `/assets${af}` || `/assets${af}` === assetPath) {
        const ct = this.inferContentType(af);
        if (this.isTextContentType(ct)) {
          const content = await this.readFile(`apps/${app}/dist/assets${af}`);
          if (content)
            return new Response(content, {
              headers: { "content-type": ct, "cache-control": "no-cache" },
            });
        } else {
          const bytes = await this.workspace.readFileBytes(
            `${REPO_DIR}/apps/${app}/dist/assets${af}`,
          );
          if (bytes)
            return new Response(bytes, {
              headers: { "content-type": ct, "cache-control": "no-cache" },
            });
        }
      }
    }

    // SPA fallback: serve index.html for non-API paths
    if (!assetPath.startsWith("/api/") && !assetPath.includes(".")) {
      const indexHtml =
        (await this.readFile(`apps/${app}/dist/assets/index.html`)) ??
        (await this.readFile(`apps/${app}/dist/index.html`));
      if (indexHtml) {
        return new Response(indexHtml, {
          headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
        });
      }
    }

    return null;
  }

  // Serve static files from apps/{app}/public/ with binary support
  async servePublicFile(app: string, req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    // Only serve paths that look like file requests (have an extension)
    if (!url.pathname.includes(".") || url.pathname.startsWith("/api/")) return null;

    // Map URL path to public dir: /images/logo.png → apps/{app}/public/images/logo.png
    const publicPath = `${REPO_DIR}/apps/${app}/public${url.pathname}`;
    const ct = this.inferContentType(url.pathname);
    // Public assets aren't hashed — use moderate caching (1 hour)
    const cc = "public, max-age=3600";

    if (this.isTextContentType(ct)) {
      const content = await this.workspace.readFile(publicPath);
      if (content)
        return new Response(content, {
          headers: { "content-type": ct, "cache-control": cc },
        });
    } else {
      const bytes = await this.workspace.readFileBytes(publicPath);
      if (bytes)
        return new Response(bytes, {
          headers: { "content-type": ct, "cache-control": cc },
        });
    }

    return null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Routing info: headers for normal requests, query params for WebSocket
    const level = req.headers.get("x-level") ?? url.searchParams.get("_level") ?? "app";
    const slug = req.headers.get("x-project-slug") ?? url.searchParams.get("_slug") ?? "unknown";
    const app = req.headers.get("x-app") ?? url.searchParams.get("_app") ?? null;
    const remote = req.headers.get("x-artifacts-remote") ?? url.searchParams.get("_remote") ?? null;
    const repoName = req.headers.get("x-artifacts-repo") ?? url.searchParams.get("_repo") ?? null;
    const doId = this.ctx.id.toString();

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

        // Check if app requires local build (too heavy for DO-based bundler)
        const buildPkgStr = await this.readFile(`apps/${buildApp}/package.json`);
        const buildPkg = buildPkgStr ? JSON.parse(buildPkgStr) : {};
        if (buildPkg.buildConfig?.localBuildOnly) {
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

      // POST /api/build-vite/:app — build a Vite/TanStack Start app in a Sandbox container
      const viteBuildMatch = url.pathname.match(/^\/api\/build-vite\/([a-z0-9-]+)$/);
      if (req.method === "POST" && viteBuildMatch) {
        const buildApp = viteBuildMatch[1];
        this.log(`[Vite] Building ${buildApp} in sandbox container...`);
        this.setBuildState(buildApp, "building");

        try {
          // 1. Read source files from artifact repo
          const appDir = `${REPO_DIR}/apps/${buildApp}`;
          const entries = await this.workspace.glob(`${appDir}/**/*`);
          const sourceFiles = entries.filter(
            (e: any) =>
              e.type === "file" &&
              !e.path.includes("/dist/") &&
              !e.path.includes("/node_modules/") &&
              !e.path.includes("/.git/"),
          );
          this.log(`[Vite] Found ${sourceFiles.length} source files`);

          // 2. Get or create a sandbox
          const sandbox = getSandbox(this.env.BUILD_SANDBOX, `vite-build-${buildApp}`);

          // 3. Write source files to the sandbox
          for (const entry of sourceFiles) {
            const content = await this.workspace.readFile(entry.path);
            if (content !== null) {
              const relPath = entry.path.replace(appDir + "/", "");
              await sandbox.writeFile(`/workspace/${relPath}`, content);
            }
          }
          this.log(`[Vite] Wrote ${sourceFiles.length} files to sandbox`);

          // 4. Create vite.config.ts + wrangler.jsonc for CF Workers build
          await sandbox.writeFile(
            "/workspace/vite.config.ts",
            `
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    react(),
  ],
})
`,
          );
          await sandbox.writeFile(
            "/workspace/wrangler.jsonc",
            JSON.stringify({
              name: buildApp,
              compatibility_date: "2026-04-01",
              compatibility_flags: ["nodejs_compat"],
              main: "@tanstack/react-start/server-entry",
            }),
          );

          // 5. Install dependencies + build
          this.log(`[Vite] Installing dependencies...`);
          const install = await sandbox.exec("npm install --legacy-peer-deps", {
            timeout: 120000,
            cwd: "/workspace",
          });
          if (!install.success) {
            throw new Error(`npm install failed: ${install.stderr}`);
          }
          this.log(`[Vite] Dependencies installed`);

          this.log(`[Vite] Running vite build...`);
          const build = await sandbox.exec("npx vite build", {
            timeout: 60000,
            cwd: "/workspace",
          });
          if (!build.success) {
            throw new Error(`vite build failed: ${build.stderr}`);
          }
          this.log(`[Vite] Build complete: ${build.stdout.slice(-200)}`);

          // 6. Read build output from sandbox
          const serverEntry = await sandbox.readFile("/workspace/dist/server/index.js");
          const serverAssetList = await sandbox.exec("ls /workspace/dist/server/assets/", {
            cwd: "/workspace",
          });
          const clientAssetList = await sandbox.exec("ls /workspace/dist/client/assets/", {
            cwd: "/workspace",
          });

          // Collect server modules
          const modules: Record<string, string> = {};
          modules["server-entry.js"] = serverEntry.content;
          for (const f of serverAssetList.stdout.trim().split("\n").filter(Boolean)) {
            if (f.endsWith(".js")) {
              const file = await sandbox.readFile(`/workspace/dist/server/assets/${f}`);
              modules[`assets/${f}`] = file.content;
            }
          }

          // DO wrapper
          modules["bundle.js"] = `
import handler from "./server-entry.js";
export class App {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    try { return await handler.fetch(request); }
    catch (err) {
      console.error("[TanStack Facet] SSR error:", err.message, err.stack);
      return new Response("SSR Error: " + err.message, { status: 500 });
    }
  }
}
`;

          // Collect client assets
          const clientAssetFiles: string[] = [];
          for (const f of clientAssetList.stdout.trim().split("\n").filter(Boolean)) {
            const file = await sandbox.readFile(`/workspace/dist/client/assets/${f}`);
            await this.writeFile(`apps/${buildApp}/dist/assets/${f}`, file.content);
            clientAssetFiles.push(`/${f}`);
          }

          // 7. Write server modules to dist
          for (const [name, content] of Object.entries(modules)) {
            await this.writeFile(`apps/${buildApp}/dist/${name}`, content);
          }

          // 8. Write manifest
          const manifest = {
            builtAt: new Date().toISOString(),
            builtBy: "sandbox-vite",
            mainModule: "bundle.js",
            moduleFiles: Object.keys(modules),
            assetFiles: clientAssetFiles,
          };
          await this.writeFile(
            `apps/${buildApp}/dist/manifest.json`,
            JSON.stringify(manifest, null, 2),
          );

          this.setBuildState(buildApp, "ready");
          this.log(
            `[Vite] Build complete: ${buildApp} (${manifest.moduleFiles.length} server modules, ${clientAssetFiles.length} client assets)`,
          );

          // Clean up sandbox
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
          this.log(`[Vite] Build failed: ${buildApp}: ${e.message}`);
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

    // ── WebSocket at Project level (facets can't receive webSocketMessage) ──
    // Accept here, tag with app + path, dispatch messages via POST to facet
    if (req.headers.get("Upgrade") === "websocket" && app) {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [`ws:${app}:${slug}:${url.pathname}`]);
      console.log(`[Project DO] accepting WebSocket for app=${app} path=${url.pathname}`);
      pair[1].send(JSON.stringify({ type: "connected", app, path: url.pathname }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // ── Level 3: App ────────────────────────────────────────────────────
    if (!app) return new Response("No app specified", { status: 400 });

    // Read config to check if app is enabled
    const configStr =
      (await this.readFile("config.json")) ?? req.headers.get("x-config") ?? '{"apps":[]}';
    const config = JSON.parse(configStr) as { apps: string[] };
    if (!config.apps.includes(app)) {
      return new Response(`App "${app}" not enabled. Enabled: ${config.apps.join(", ")}`, {
        status: 404,
      });
    }

    // Read app-level build config (externals, compatibilityFlags, etc.)
    const appPkgStr = await this.readFile(`apps/${app}/package.json`);
    const appPkg = appPkgStr ? JSON.parse(appPkgStr) : {};
    const appBuildConfig = appPkg.buildConfig ?? {};
    const appCompatFlags: string[] = appBuildConfig.compatibilityFlags ?? [];

    // Check for built dist first
    const manifestStr = await this.readFile(`apps/${app}/dist/manifest.json`);
    if (manifestStr) {
      const meta = JSON.parse(manifestStr);
      console.log(`[Project DO] app=${app} has dist (built at ${meta.builtAt})`);

      // Serve static assets from dist (skip for /api/* and POST — those go to the facet)
      const isApiOrPost =
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/_studio") ||
        url.pathname.startsWith("/_sql") ||
        url.pathname.startsWith("/streams/") ||
        req.method === "POST" ||
        req.headers.get("Upgrade") === "websocket";
      if (!isApiOrPost) {
        // 1. Check dist assets (bundler output)
        if (meta.assetFiles?.length > 0) {
          const assetResponse = await this.serveDistAsset(app, meta, req);
          if (assetResponse) return assetResponse;
        }
        // 2. Check public/ dir (images, fonts, etc. — served with binary support)
        const publicResponse = await this.servePublicFile(app, req);
        if (publicResponse) return publicResponse;
      }

      // Load server modules from dist into LOADER
      const modules: Record<string, string> = {};
      for (const f of meta.moduleFiles) {
        const content = await this.readFile(`apps/${app}/dist/${f}`);
        if (content) modules[f] = content;
      }

      const mainModule = meta.mainModule;
      if (!modules[mainModule]) {
        return new Response(`Built app ${app} missing main module: ${mainModule}`, { status: 500 });
      }

      // Prepend fetch wrapper to inject project slug header on all outbound requests
      const runtimePrefix = egressRuntimeWrapper(slug);
      modules[mainModule] = runtimePrefix + modules[mainModule];

      const sourceHash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(modules[mainModule])),
        ),
      )
        .slice(0, 4)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      console.log(
        `[Project DO] loading built app=${app} mainModule=${mainModule} hash=${sourceHash} modules=${Object.keys(modules).join(",")}`,
      );

      this.upsertFacet(app, "App");
      const facet = this.ctx.facets.get(`app:${app}:${sourceHash}`, async () => {
        const worker = this.env.LOADER.get(`code:${app}:${sourceHash}`, async () => ({
          compatibilityDate: "2026-04-01",
          compatibilityFlags: appCompatFlags,
          mainModule,
          modules,
          globalOutbound: this.env.EGRESS_GATEWAY,
          env: { AI: this.env.AI_PROXY, EXEC: this.env.CODE_EXECUTOR },
        }));
        return { class: worker.getDurableObjectClass("App") };
      });

      console.log(`[Project DO] forwarding to built App facet`);
      return facet.fetch(req);
    }

    // Serve public files for unbundled apps too (images, etc.)
    if (req.method === "GET" && url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
      const publicResponse = await this.servePublicFile(app, req);
      if (publicResponse) return publicResponse;
    }

    // Fallback: read apps/{app}/index.js directly (unbundled plain JS)
    const appSource = await this.readFile(`apps/${app}/index.js`);
    if (!appSource) {
      return new Response(`No source found at apps/${app}/index.js (and no dist/) in artifact`, {
        status: 404,
      });
    }

    const hasAppExport = /export class App\s+extends/.test(appSource);
    const userClassName = hasAppExport
      ? "App"
      : ((appSource.match(/export class (\w+) extends DurableObject/) ?? [])[1] ?? "App");
    const wrappedSource = hasAppExport
      ? appSource
      : appSource + `\n;export { ${userClassName} as App };`;
    const runtimePrefix = egressRuntimeWrapper(slug);
    const finalSource = runtimePrefix + wrappedSource;
    const sourceHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(finalSource))),
    )
      .slice(0, 4)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    console.log(
      `[Project DO] loading app=${app} class=${userClassName} hash=${sourceHash} source=${appSource.length}bytes`,
    );

    this.upsertFacet(app, "App");
    const facet = this.ctx.facets.get(`app:${app}:${sourceHash}`, async () => {
      const worker = this.env.LOADER.get(`code:${app}:${sourceHash}`, async () => ({
        compatibilityDate: "2026-04-01",
        compatibilityFlags: appCompatFlags,
        mainModule: "index.js",
        modules: { "index.js": finalSource },
        globalOutbound: this.env.EGRESS_GATEWAY,
      }));
      return { class: worker.getDurableObjectClass("App") };
    });

    console.log(`[Project DO] forwarding to App facet`);
    return facet.fetch(req);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws);
    const wsTag = tags.find((t) => t.startsWith("ws:"));
    if (!wsTag) return; // Log WS or unknown — ignore

    // Parse tag: "ws:<app>:<slug>:<pathname>"
    const [, tagApp, tagSlug, ...pathParts] = wsTag.split(":");
    const pathname = pathParts.join(":"); // rejoin in case pathname had colons
    console.log(`[Project DO] WS message for app=${tagApp} path=${pathname}`);

    try {
      // Load the app and forward the message as a POST /_ws-message to the facet
      const configStr = (await this.readFile("config.json")) ?? '{"apps":[]}';
      const config = JSON.parse(configStr) as { apps: string[] };
      if (!config.apps.includes(tagApp)) return;

      // Reconstruct the app loading (same as Level 3 fetch)
      const manifestStr = await this.readFile(`apps/${tagApp}/dist/manifest.json`);
      if (!manifestStr) return;
      const meta = JSON.parse(manifestStr);
      const modules: Record<string, string> = {};
      for (const f of meta.moduleFiles) {
        const content = await this.readFile(`apps/${tagApp}/dist/${f}`);
        if (content) modules[f] = content;
      }
      const mainModule = meta.mainModule;
      if (!modules[mainModule]) return;

      const runtimePrefix = egressRuntimeWrapper(tagSlug);
      modules[mainModule] = runtimePrefix + modules[mainModule];
      const sourceHash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(modules[mainModule])),
        ),
      )
        .slice(0, 4)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const facet = this.ctx.facets.get(`app:${tagApp}:${sourceHash}`, async () => {
        const worker = this.env.LOADER.get(`code:${tagApp}:${sourceHash}`, async () => ({
          compatibilityDate: "2026-04-01",
          compatibilityFlags: appCompatFlags,
          mainModule,
          modules,
          globalOutbound: this.env.EGRESS_GATEWAY,
          env: { AI: this.env.AI_PROXY, EXEC: this.env.CODE_EXECUTOR },
        }));
        return { class: worker.getDurableObjectClass("App") };
      });

      // Forward message to the app facet as POST /_ws-message with pathname context
      const resp = await facet.fetch(
        new Request("http://localhost/_ws-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pathname, message: typeof message === "string" ? message : "" }),
        }),
      );
      const result = (await resp.json()) as { appends?: any[] };

      // Send any append events back through the WebSocket
      if (result.appends) {
        for (const appendEvent of result.appends) {
          ws.send(JSON.stringify({ type: "append", event: appendEvent }));
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
