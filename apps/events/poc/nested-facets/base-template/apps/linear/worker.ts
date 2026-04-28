/**
 * Linear App — bidirectional bridge between Linear and agent streams.
 *
 * Flow:
 *   Linear webhook → POST /api/webhook → agent-input-added → agent stream
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

  async listIssues(teamId: string, first: number = 20) {
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

function formatMessageForAgent(parsed: ParsedLinearEvent): string {
  return [
    `You received a Linear notification.`,
    `Type: ${parsed.type} (${parsed.action})`,
    `Title: ${parsed.title}`,
    parsed.url ? `URL: ${parsed.url}` : "",
    "",
    "To respond, call linear.createComment with:",
    `  issueId: "${parsed.issueId}"`,
    `  body: "your reply"`,
  ]
    .filter(Boolean)
    .join("\n");
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
    await fetch(`${base}/api/streams/${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
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
    const content = formatMessageForAgent(parsed);
    const idempotencyBase = `${payload.data?.id || ""}:${parsed.action}:${payload.webhookTimestamp || ""}`;

    const agentEvent = {
      type: "agent-input-added",
      payload: { role: "user", content, source: "linear" },
      idempotencyKey: `agent-input:${idempotencyBase}`,
    };

    // Append event to the stream (for persistence/audit)
    try {
      await this.#appendToStream(agentPath, agentEvent);
    } catch (e: any) {
      console.error(`[Linear] stream append failed: ${e.message}`);
    }

    // Also POST directly to the agents processor to trigger the AI loop.
    // This avoids the subscription race (WebSocket not connected in time).
    const host = this.#config("hostHeader") || "";
    const agentsHost = host.replace(/^linear\./, "agents.");
    try {
      await fetch(`https://${agentsHost}/streams/${encodeURIComponent(agentPath)}/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agentEvent),
      });
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
});
