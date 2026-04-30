/**
 * Linear App — bidirectional bridge between Linear and agent streams.
 *
 * Flow:
 *   Linear webhook → POST /api/webhook → events.iterate.com/agent/input-added → agent stream
 *   Agent (CodeMode) → POST /api/rpc/createComment → GraphQL → Linear
 *   Agent (CodeMode) → POST /api/rpc/updateIssueState → GraphQL → Linear
 *   Agent (CodeMode) → POST /api/rpc/createIssue → GraphQL → Linear
 *   Agent (CodeMode) → POST /api/rpc/listIssues → GraphQL → Linear
 *
 * Single class: App DO. oRPC for the API, Scalar for docs.
 */

import { DurableObject } from "cloudflare:workers";
import { oc } from "@orpc/contract";
import { implement, onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { z } from "zod";

// ── Linear GraphQL API ──────────────────────────────────────────────────────

class LinearClient {
  constructor(private authHeader: string) {}

  async createComment(issueId: string, body: string) {
    return this.#mutation(
      `mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id body url }
        }
      }`,
      { issueId, body },
    );
  }

  async updateIssueState(issueId: string, stateId: string) {
    return this.#mutation(
      `mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
          issue { id title state { id name } }
        }
      }`,
      { issueId, stateId },
    );
  }

  async createIssue(teamId: string, title: string, description?: string, priority?: number) {
    return this.#mutation(
      `mutation($teamId: String!, $title: String!, $description: String, $priority: Int) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description, priority: $priority }) {
          success
          issue { id identifier title url }
        }
      }`,
      { teamId, title, description, priority },
    );
  }

  async listIssues(teamId: string, first = 20) {
    return this.#query(
      `query($teamId: String!, $first: Int!) {
        team(id: $teamId) {
          issues(first: $first, orderBy: updatedAt) {
            nodes { id identifier title state { id name } priority url assignee { name } }
          }
        }
      }`,
      { teamId, first },
    );
  }

  async viewer() {
    return this.#query(`query { viewer { id name displayName } }`, {});
  }

  async graphql(query: string, variables: Record<string, any> = {}) {
    return this.#call(query, variables);
  }

  async #mutation(query: string, variables: Record<string, any>): Promise<any> {
    return this.#call(query, variables);
  }

  async #query(query: string, variables: Record<string, any>): Promise<any> {
    return this.#call(query, variables);
  }

  async #call(query: string, variables: Record<string, any>): Promise<any> {
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: this.authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { errors: [{ message: raw.slice(0, 200) }] };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPathname(urlStr: string): string {
  const afterProto = urlStr.replace(/^https?:\/\//, "");
  const slashIdx = afterProto.indexOf("/");
  if (slashIdx === -1) return "/";
  const qIdx = afterProto.indexOf("?", slashIdx);
  return qIdx === -1 ? afterProto.slice(slashIdx) : afterProto.slice(slashIdx, qIdx);
}

function parseQuery(urlStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  const qIdx = urlStr.indexOf("?");
  if (qIdx === -1) return params;
  for (const p of urlStr.slice(qIdx + 1).split("&")) {
    const [k, v] = p.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return params;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactConfigRows(rows: any[]) {
  return rows.map((row) => {
    const key = String(row.key ?? "");
    const value = String(row.value ?? "");
    if (/token|secret|apikey|api_key|clientid|client_id/i.test(key)) {
      return { ...row, value: `<redacted:${value.length}>` };
    }
    return row;
  });
}

const DEFAULT_EVENTS = [
  {
    type: "events.iterate.com/agent/system-prompt-updated",
    payload: {
      systemPrompt:
        "You are an Iterate Linear bot. Respond to Linear notifications by writing exactly one fenced `js` codemode block containing the program body directly. Top-level `await` and `return` are valid. Do not write an `async () => { ... }` wrapper; the runtime supplies it. Use the `linear` provider only. Do not call `webchat`. Keep the block short and complete. Never write prose outside the fence. For Linear comment webhooks, use the issue id from the raw webhook payload. If you need multiple independent Linear API calls in one response, run them concurrently with `Promise.all([...])`.",
    },
  },
  {
    type: "events.iterate.com/agent/input-added",
    payload: {
      role: "user",
      content:
        "Linear policy: read the filtered `events.iterate.com/linear/webhook-received` YAML. Reply on Linear with `linear.createComment` using `event.response.createComment.issueId`. Do not send a separate webchat confirmation. There is no `event` global in codemode; copy exact IDs from the YAML into constants. Always return the tool promise or result. If you perform multiple independent actions, use `Promise.all`.",
      triggerLlmRequest: { behaviour: "dont-trigger-request" },
    },
  },
];

function defaultEventsText(): string {
  return JSON.stringify(DEFAULT_EVENTS, null, 2);
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = Math.imul(31, hash) + value.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function parseDefaultEvents(text: string): any[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Default events must be a JSON array");
  return parsed;
}

function defaultEventsEditorHtml(appName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${appName} default events</title><style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#f7f7f4;color:#111827}main{padding:16px;height:100vh;box-sizing:border-box;display:grid;grid-template-rows:auto 1fr auto;gap:12px}h1{font-size:16px;margin:0}textarea{width:100%;height:100%;box-sizing:border-box;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:12px;border:1px solid #d4d4d0;border-radius:6px;resize:none}button{border:1px solid #111827;background:#111827;color:white;border-radius:6px;padding:8px 12px}#status{font-size:12px;color:#4b5563}</style></head><body><main><h1>${appName} default events</h1><textarea id="events" spellcheck="false"></textarea><div><button id="save">Save</button> <span id="status"></span></div></main><script>const textarea=document.getElementById("events");const status=document.getElementById("status");async function load(){const response=await fetch("/api/default-events");const data=await response.json();textarea.value=data.eventsText||""}document.getElementById("save").addEventListener("click",async()=>{status.textContent="Saving...";const response=await fetch("/api/default-events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({eventsText:textarea.value})});const data=await response.json();status.textContent=data.ok?"Saved":data.error||"Failed"});load().catch((error)=>status.textContent=error.message);</script></body></html>`;
}

// ── Webhook parsing ─────────────────────────────────────────────────────────

interface LinearWebhookPayload {
  type: string; // "Issue", "Comment", "IssueLabel", "Project", etc.
  action: string; // "create", "update", "remove"
  data: Record<string, any>;
  url?: string;
  organizationId?: string;
  webhookId?: string;
  webhookTimestamp?: number;
  createdAt?: string;
}

interface ParsedLinearEvent {
  issueId: string;
  type: string;
  action: string;
  title: string;
  url: string;
  data: Record<string, any>;
}

function parseWebhookPayload(payload: LinearWebhookPayload): ParsedLinearEvent | null {
  const { type, action, data, url } = payload;
  if (!type || !action || !data) return null;

  let issueId: string;
  let title: string;

  if (type === "Comment") {
    // Comments: route to the parent issue
    issueId = data.issueId || data.issue?.id || "";
    title = data.body ? data.body.slice(0, 100) : "(no body)";
  } else if (type === "Issue") {
    issueId = data.id || "";
    title = data.title || "(no title)";
  } else {
    // Other types (IssueLabel, Project, etc.): use data.id as fallback
    issueId = data.issueId || data.issue?.id || data.id || "";
    title = data.title || data.name || data.body?.slice(0, 100) || `(${type})`;
  }

  if (!issueId) return null;

  return { issueId, type, action, title, url: url || "", data };
}

function yamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const stringValue = String(value);
  if (/^[a-zA-Z0-9._/@:-]+$/.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

function yamlKeyValue(key: string, value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (typeof value === "string" && value.includes("\n")) {
    return [`${pad}${key}: |-`, ...value.split("\n").map((line) => `${pad}  ${line}`)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    return [`${pad}${key}:`, ...yamlValue(value, indent + 2)];
  }
  if (value != null && typeof value === "object") {
    if (Object.keys(value).length === 0) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...yamlValue(value, indent + 2)];
  }
  return [`${pad}${key}: ${yamlScalar(value)}`];
}

function yamlValue(value: unknown, indent = 0): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    return value.flatMap((item) =>
      item != null && typeof item === "object"
        ? [`${pad}-`, ...yamlValue(item, indent + 2)]
        : [`${pad}- ${yamlScalar(item)}`],
    );
  }
  if (value != null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => yamlKeyValue(key, child, indent));
  }
  return [`${pad}${yamlScalar(value)}`];
}

function eventToYaml(event: unknown): string {
  return ["```yaml", ...yamlValue({ event }), "```"].join("\n");
}

function agentInputForLinearEvent(args: {
  parsed: ParsedLinearEvent;
  rawEvent: { type: string; payload?: unknown; idempotencyKey?: string };
}) {
  const data = args.parsed.data;
  return {
    type: "events.iterate.com/agent/input-added",
    idempotencyKey: `${args.rawEvent.idempotencyKey || crypto.randomUUID()}:agent-input`,
    payload: {
      role: "user",
      source: "linear",
      content: eventToYaml({
        type: args.rawEvent.type,
        idempotencyKey: args.rawEvent.idempotencyKey,
        filtered: true,
        payload: {
          webhookType: args.parsed.type,
          action: args.parsed.action,
          issueId: args.parsed.issueId,
          issueIdentifier: data.issue?.identifier || data.issueIdentifier,
          title: args.parsed.title,
          text: data.body || data.description || data.title || "",
          actor: data.user?.name || data.creator?.name || data.createdBy?.name || "unknown",
          url: args.parsed.url,
          commentId: args.parsed.type === "Comment" ? data.id : undefined,
        },
        response: {
          createComment: {
            issueId: args.parsed.issueId,
            body: "<your reply>",
          },
        },
      }),
    },
  };
}

function linearWebhookReceivedEvent(args: { payload: any; receivedAt: string; host: string }) {
  const idempotencyBase = [
    args.payload.webhookId,
    args.payload.type,
    args.payload.action,
    args.payload.data?.id,
    args.payload.webhookTimestamp,
  ]
    .filter(Boolean)
    .join(":");
  return {
    type: "events.iterate.com/linear/webhook-received",
    payload: {
      body: args.payload,
      receivedAt: args.receivedAt,
      host: args.host,
    },
    idempotencyKey: `linear-webhook:${idempotencyBase || Date.now()}`,
  };
}

// ── oRPC contract ───────────────────────────────────────────────────────────

const linearContract = oc.router({
  createComment: oc
    .route({
      method: "POST",
      path: "/rpc/createComment",
      description: "Add a comment to a Linear issue.",
      tags: ["linear"],
    })
    .input(
      z
        .object({
          issueId: z.string().describe("Linear issue ID"),
          body: z.string().optional().describe("Comment body (Markdown)"),
          text: z.string().optional().describe("Deprecated alias for body"),
        })
        .refine((input) => input.body || input.text, {
          message: "Either body or text is required",
          path: ["body"],
        }),
    )
    .output(z.object({ data: z.any().optional(), errors: z.any().optional() })),

  updateIssueState: oc
    .route({
      method: "POST",
      path: "/rpc/updateIssueState",
      description: "Change the state of a Linear issue (e.g., mark as done).",
      tags: ["linear"],
    })
    .input(
      z.object({
        issueId: z.string().describe("Linear issue ID"),
        stateId: z.string().describe("Target workflow state ID"),
      }),
    )
    .output(z.object({ data: z.any().optional(), errors: z.any().optional() })),

  createIssue: oc
    .route({
      method: "POST",
      path: "/rpc/createIssue",
      description: "Create a new Linear issue.",
      tags: ["linear"],
    })
    .input(
      z.object({
        teamId: z.string().describe("Linear team ID"),
        title: z.string().describe("Issue title"),
        description: z.string().optional().describe("Issue description (Markdown)"),
        priority: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe("Priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low"),
      }),
    )
    .output(z.object({ data: z.any().optional(), errors: z.any().optional() })),

  listIssues: oc
    .route({
      method: "POST",
      path: "/rpc/listIssues",
      description: "List issues for a Linear team.",
      tags: ["linear"],
    })
    .input(
      z.object({
        teamId: z.string().describe("Linear team ID"),
        first: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Number of issues to return (default 20)"),
      }),
    )
    .output(z.object({ data: z.any().optional(), errors: z.any().optional() })),

  graphql: oc
    .route({
      method: "POST",
      path: "/rpc/graphql",
      description:
        "Thin Linear GraphQL proxy using the installed Linear app credentials. Docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
      tags: ["linear"],
    })
    .input(
      z.object({
        query: z.string().describe("Linear GraphQL query or mutation"),
        variables: z.record(z.string(), z.any()).optional().describe("GraphQL variables"),
      }),
    )
    .output(z.object({ data: z.any().optional(), errors: z.any().optional() })),
});

// ── App DO ───────────────────────────────────────────────────────────────────

export class App extends DurableObject {
  #linear: LinearClient | null = null;
  #apiHandler: OpenAPIHandler<typeof linearRouter, LinearContext> | null = null;

  #ensureTables() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`);
  }

  #config(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = ?", key).toArray();
    return rows.length ? (rows[0].value as string) : null;
  }

  #setConfig(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  async #linearClient(): Promise<LinearClient> {
    if (this.#linear) return this.#linear;
    const authHeader = await this.#linearAuthHeader();
    this.#linear = new LinearClient(authHeader);
    return this.#linear;
  }

  async #linearAuthHeader(): Promise<string> {
    const accessToken = this.#config("linearAccessToken");
    if (accessToken) {
      const expiresAt = Number(this.#config("linearAccessTokenExpiresAt") || "0");
      if (expiresAt && Date.now() > expiresAt - 300_000) await this.#refreshOAuthToken();
      return `Bearer ${this.#config("linearAccessToken") || accessToken}`;
    }

    const apiKey = this.#config("linearApiKey");
    if (apiKey) return apiKey;

    throw new Error("No Linear OAuth token or API key — run /api/oauth/start or /api/install");
  }

  #oauthRedirectUri(req: Request): string {
    const host = req.headers.get("host") || this.#config("hostHeader") || "localhost";
    return `https://${host}/api/oauth/callback`;
  }

  #oauthScopes(): string {
    return this.#config("linearOAuthScopes") || "read,comments:create,app:mentionable";
  }

  async #storeOAuthToken(tokenResult: any) {
    if (!tokenResult.access_token) throw new Error(JSON.stringify(tokenResult));
    this.#setConfig("linearAccessToken", tokenResult.access_token);
    if (tokenResult.refresh_token) this.#setConfig("linearRefreshToken", tokenResult.refresh_token);
    if (tokenResult.scope) this.#setConfig("linearOAuthGrantedScope", String(tokenResult.scope));
    const expiresIn = Number(tokenResult.expires_in || 86_399);
    this.#setConfig("linearAccessTokenExpiresAt", String(Date.now() + expiresIn * 1000));
    this.#linear = null;
    this.#apiHandler = null;

    try {
      const client = new LinearClient(`Bearer ${tokenResult.access_token}`);
      const viewer = await client.viewer();
      const id = (viewer as any)?.data?.viewer?.id;
      const name =
        (viewer as any)?.data?.viewer?.name || (viewer as any)?.data?.viewer?.displayName;
      if (id) this.#setConfig("linearOAuthActorId", id);
      if (name) this.#setConfig("linearOAuthActorName", name);
    } catch {}
  }

  async #refreshOAuthToken() {
    const refreshToken = this.#config("linearRefreshToken");
    const clientId = this.#config("linearOAuthClientId");
    const clientSecret = this.#config("linearOAuthClientSecret");
    if (!refreshToken || !clientId || !clientSecret) return;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const resp = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const result = await resp.json();
    await this.#storeOAuthToken(result);
  }

  async #oauthStart(req: Request) {
    const clientId = this.#config("linearOAuthClientId");
    if (!clientId)
      return Response.json({ ok: false, error: "linearOAuthClientId missing" }, { status: 400 });

    const state = crypto.randomUUID();
    this.#setConfig("linearOAuthState", state);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.#oauthRedirectUri(req),
      response_type: "code",
      scope: this.#oauthScopes(),
      actor: "app",
      state,
      prompt: "consent",
    });
    return Response.redirect(`https://linear.app/oauth/authorize?${params.toString()}`, 302);
  }

  async #oauthCallback(req: Request) {
    const query = parseQuery(req.url);
    if (query.error) return new Response(`Linear OAuth failed: ${query.error}`, { status: 400 });
    if (!query.code) return new Response("Missing code", { status: 400 });
    if (query.state !== this.#config("linearOAuthState"))
      return new Response("Bad state", { status: 400 });

    const clientId = this.#config("linearOAuthClientId");
    const clientSecret = this.#config("linearOAuthClientSecret");
    if (!clientId || !clientSecret)
      return new Response("Missing Linear OAuth client credentials", { status: 400 });

    const body = new URLSearchParams({
      code: query.code,
      redirect_uri: this.#oauthRedirectUri(req),
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
    });
    const resp = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenResult = await resp.json();
    try {
      await this.#storeOAuthToken(tokenResult);
    } catch (e: any) {
      return new Response(`Linear OAuth token exchange failed: ${e.message}`, { status: 400 });
    }
    return new Response("Linear OAuth app actor installed. You can close this tab.", {
      headers: { "content-type": "text/plain" },
    });
  }

  #commentMentionsBot(parsed: ParsedLinearEvent): boolean {
    if (parsed.type !== "Comment") return false;
    const body = String(parsed.data?.body || parsed.title || "").toLowerCase();
    const mentions = (this.#config("linearBotMentionNames") || "iterate")
      .split(",")
      .map((v) => v.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean);
    return mentions.some((mention) =>
      new RegExp(`(^|\\s)@${escapeRegExp(mention)}(\\b|\\s|$)`).test(body),
    );
  }

  async #appendToStream(path: string, event: any) {
    const eventsBase = this.#config("eventsBaseUrl");
    const slug = this.#config("projectSlug");
    if (!eventsBase || !slug) throw new Error("Not installed");
    const base = eventsBase.replace(/\/+$/, "").replace("://", `://${slug}.`);
    const resp = await fetch(`${base}/api/streams/${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
    if (!resp.ok) throw new Error(`stream append failed: ${resp.status}`);
    const json = (await resp.json()) as any;
    return json.event ?? event;
  }

  #defaultEventsText(): string {
    if (this.#config("defaultEventsCustom") === "1") {
      return this.#config("defaultEvents") || defaultEventsText();
    }
    return defaultEventsText();
  }

  async #processAgentEvent(path: string, event: any): Promise<void> {
    const host = this.#config("hostHeader") || "";
    const agentsHost = host.replace(/^linear\./, "agents.");
    await fetch(`https://${agentsHost}/streams/${encodeURIComponent(path)}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  }

  async #appendAndProcessAgentEvent(path: string, event: any): Promise<any> {
    const appendedEvent = await this.#appendToStream(path, event);
    await this.#processAgentEvent(path, appendedEvent);
    return appendedEvent;
  }

  async #ensureDefaultEvents(path: string): Promise<void> {
    const text = this.#defaultEventsText();
    const hash = simpleHash(text);
    const key = `defaultEventsApplied:${path}`;
    if (this.#config(key) === hash) return;
    const events = parseDefaultEvents(text);
    for (let i = 0; i < events.length; i++) {
      await this.#appendAndProcessAgentEvent(path, {
        ...events[i],
        idempotencyKey: events[i].idempotencyKey ?? `default-event:linear:${hash}:${i}`,
      });
    }
    this.#setConfig(key, hash);
  }

  #getApiHandler() {
    if (this.#apiHandler) return this.#apiHandler;
    this.#apiHandler = new OpenAPIHandler(linearRouter, {
      plugins: [
        new OpenAPIReferencePlugin({
          docsProvider: "scalar",
          docsPath: "/docs",
          specPath: "/openapi.json",
          schemaConverters: [new ZodToJsonSchemaConverter()],
          specGenerateOptions: {
            info: {
              title: "Linear App API",
              version: "1.0.0",
              description:
                "Linear integration tools for agents. Comment on issues, update states, create and list issues.",
            },
          },
        }),
      ],
      interceptors: [onError((error) => console.error("[Linear API]", error))],
    });
    return this.#apiHandler;
  }

  async fetch(req: Request): Promise<Response> {
    this.#ensureTables();
    const path = getPathname(req.url);

    if (path === "/" && req.method === "GET") {
      return new Response(defaultEventsEditorHtml("Linear"), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (path === "/api/default-events" && req.method === "GET") {
      return Response.json({ eventsText: this.#defaultEventsText() });
    }
    if (path === "/api/default-events" && req.method === "POST") {
      const body = (await req.json()) as { eventsText?: string };
      const eventsText = String(body.eventsText ?? "");
      try {
        parseDefaultEvents(eventsText);
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 400 });
      }
      this.#setConfig("defaultEvents", eventsText);
      this.#setConfig("defaultEventsCustom", "1");
      return Response.json({ ok: true });
    }

    if (path === "/api/webhook" && req.method === "POST") return this.#webhook(req);
    if (path === "/api/install") return this.#install(req);
    if (path === "/api/oauth/start") return this.#oauthStart(req);
    if (path === "/api/oauth/callback") return this.#oauthCallback(req);
    if (path === "/api/config")
      return Response.json(
        redactConfigRows(this.ctx.storage.sql.exec("SELECT * FROM config").toArray()),
      );

    // oRPC handles /api/rpc/*, /api/docs, /api/openapi.json
    if (path.startsWith("/api/")) {
      const handler = this.#getApiHandler();
      const context =
        path === "/api/docs" || path === "/api/openapi.json"
          ? {}
          : {
              linearClient: await this.#linearClient(),
              markGeneratedComment: (commentId: string) => {
                this.#setConfig(`generatedComment:${commentId}`, "1");
              },
            };
      const { matched, response } = await handler.handle(req, {
        prefix: "/api",
        context,
      });
      if (matched && response) return response;
    }

    return new Response("Linear App — /api/install to set up, /api/docs for API reference");
  }

  async #webhook(req: Request): Promise<Response> {
    let payload: any;
    try {
      payload = JSON.parse(await req.text());
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }

    const rawWebhookEvent = linearWebhookReceivedEvent({
      payload,
      receivedAt: new Date().toISOString(),
      host: req.headers.get("host") || "",
    });
    try {
      await this.#appendToStream("/linear/webhooks", rawWebhookEvent);
    } catch (e: any) {
      console.error(`[Linear] raw webhook append failed: ${e.message}`);
    }

    const parsed = parseWebhookPayload(payload);
    if (!parsed) return Response.json({ ok: true, ignored: true, reason: "unrecognized payload" });

    if (parsed.type === "Comment" && payload.data?.id) {
      const generated = this.ctx.storage.sql
        .exec("SELECT 1 FROM config WHERE key = ?", `generatedComment:${payload.data.id}`)
        .toArray();
      if (generated.length)
        return Response.json({ ok: true, ignored: true, reason: "generated comment echo" });
    }

    if (!this.#commentMentionsBot(parsed)) {
      return Response.json({ ok: true, ignored: true, reason: "missing bot mention" });
    }

    // Dedup by data.id + action
    const dedupKey = `seen:${parsed.type}:${payload.data?.id || ""}:${parsed.action}`;
    const seen = this.ctx.storage.sql
      .exec("SELECT 1 FROM config WHERE key = ?", dedupKey)
      .toArray();
    if (seen.length) return Response.json({ ok: true, duplicate: true });
    this.#setConfig(dedupKey, "1");

    const agentPath = `/agents/linear/issue-${parsed.issueId}`;

    await this.#ensureDefaultEvents(agentPath);

    try {
      await this.#appendToStream(agentPath, rawWebhookEvent);
    } catch (e: any) {
      console.error(`[Linear] stream append failed: ${e.message}`);
    }

    const agentInputEvent = agentInputForLinearEvent({ parsed, rawEvent: rawWebhookEvent });
    let appendedInput = agentInputEvent;
    try {
      appendedInput = await this.#appendToStream(agentPath, agentInputEvent);
    } catch (e: any) {
      console.error(`[Linear] agent-input append failed: ${e.message}`);
    }

    try {
      await this.#processAgentEvent(agentPath, appendedInput);
    } catch (e: any) {
      console.error(`[Linear] direct agent trigger failed: ${e.message}`);
    }

    return Response.json({ ok: true, type: parsed.type, action: parsed.action });
  }

  async #install(req: Request): Promise<Response> {
    const host = req.headers.get("host") || "localhost";
    const params: Record<string, string> = {};
    Object.assign(params, parseQuery(req.url));
    if (req.method === "POST")
      try {
        Object.assign(params, await req.json());
      } catch {}

    const projectSlug = params.projectSlug || this.#config("projectSlug") || "";
    if (!projectSlug) return Response.json({ error: "projectSlug required" }, { status: 400 });

    this.#setConfig(
      "eventsBaseUrl",
      params.eventsBaseUrl || this.#config("eventsBaseUrl") || "https://events.iterate.com",
    );
    this.#setConfig("projectSlug", projectSlug);
    this.#setConfig("hostHeader", host);
    if (params.linearApiKey) {
      this.#setConfig("linearApiKey", params.linearApiKey);
      this.#linear = null;
      this.#apiHandler = null;
    }
    if (params.linearOAuthClientId)
      this.#setConfig("linearOAuthClientId", params.linearOAuthClientId);
    if (params.linearOAuthClientSecret)
      this.#setConfig("linearOAuthClientSecret", params.linearOAuthClientSecret);
    if (params.linearOAuthScopes) this.#setConfig("linearOAuthScopes", params.linearOAuthScopes);
    if (params.linearBotMentionNames)
      this.#setConfig("linearBotMentionNames", params.linearBotMentionNames);
    if (params.linearAccessToken) {
      this.#setConfig("linearAccessToken", params.linearAccessToken);
      this.#setConfig(
        "linearAccessTokenExpiresAt",
        params.linearAccessTokenExpiresAt || String(Date.now() + 86_399_000),
      );
      this.#linear = null;
      this.#apiHandler = null;
    }
    if (params.linearRefreshToken) this.#setConfig("linearRefreshToken", params.linearRefreshToken);

    return Response.json({
      ok: true,
      webhookUrl: `https://${host}/api/webhook`,
      oauthStartUrl: `https://${host}/api/oauth/start`,
      oauthRedirectUri: `https://${host}/api/oauth/callback`,
    });
  }
}

// ── oRPC router (implemented outside the class, receives context) ───────────

type LinearContext = {
  linearClient?: LinearClient;
  markGeneratedComment?: (commentId: string) => void;
};

const os = implement(linearContract).$context<LinearContext>();

const linearRouter = os.router({
  createComment: os.createComment.handler(async ({ context, input }) => {
    if (!context.linearClient) throw new Error("No Linear API key - run /api/install");
    const body = input.body ?? input.text;
    if (!body) throw new Error("Either body or text is required");
    const result = await context.linearClient.createComment(input.issueId, body);
    const commentId = result?.data?.commentCreate?.comment?.id;
    if (commentId) context.markGeneratedComment?.(commentId);
    return result;
  }),

  updateIssueState: os.updateIssueState.handler(async ({ context, input }) => {
    if (!context.linearClient) throw new Error("No Linear API key - run /api/install");
    return context.linearClient.updateIssueState(input.issueId, input.stateId);
  }),

  createIssue: os.createIssue.handler(async ({ context, input }) => {
    if (!context.linearClient) throw new Error("No Linear API key - run /api/install");
    return context.linearClient.createIssue(
      input.teamId,
      input.title,
      input.description,
      input.priority,
    );
  }),

  listIssues: os.listIssues.handler(async ({ context, input }) => {
    if (!context.linearClient) throw new Error("No Linear API key - run /api/install");
    return context.linearClient.listIssues(input.teamId, input.first);
  }),

  graphql: os.graphql.handler(async ({ context, input }) => {
    if (!context.linearClient) throw new Error("No Linear API key - run /api/install");
    return context.linearClient.graphql(input.query, input.variables ?? {});
  }),
});
