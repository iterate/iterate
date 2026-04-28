/**
 * GitHub App — bidirectional bridge between GitHub webhooks and agent streams.
 *
 * Flow:
 *   GitHub webhook → POST /api/webhook → agent-input-added → agent stream
 *   Agent (CodeMode) → POST /api/rpc/createIssueComment → issues comments API → GitHub
 *   Agent (CodeMode) → POST /api/rpc/createReaction → reactions API → GitHub
 *   Agent (CodeMode) → POST /api/rpc/updateIssue → issues API → GitHub
 *   Agent (CodeMode) → POST /api/rpc/createIssue → issues API → GitHub
 *   Agent (CodeMode) → POST /api/rpc/listIssues → issues API → GitHub
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

// ── GitHub API ────────────────────────────────────────────────────────────────

class GitHubClient {
  constructor(private authHeader: string) {}

  createIssueComment(owner: string, repo: string, issueNumber: number, body: string) {
    return this.#call("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
  }

  createReaction(owner: string, repo: string, issueNumber: number, content: string) {
    return this.#call("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/reactions`, {
      content,
    });
  }

  updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    updates: {
      title?: string;
      body?: string;
      state?: string;
      labels?: string[];
      assignees?: string[];
    },
  ) {
    return this.#call("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, updates);
  }

  createIssue(
    owner: string,
    repo: string,
    data: { title: string; body?: string; labels?: string[]; assignees?: string[] },
  ) {
    return this.#call("POST", `/repos/${owner}/${repo}/issues`, data);
  }

  listIssues(owner: string, repo: string, params: { state?: string; per_page?: number }) {
    const qs = new URLSearchParams();
    if (params.state) qs.set("state", params.state);
    if (params.per_page) qs.set("per_page", String(params.per_page));
    const query = qs.toString();
    return this.#call("GET", `/repos/${owner}/${repo}/issues${query ? `?${query}` : ""}`);
  }

  async #call(method: string, path: string, body?: any): Promise<any> {
    const resp = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: this.authHeader,
        accept: "application/vnd.github+json",
        "user-agent": "iterate-github-app",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { error: raw.slice(0, 200) };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPathname(urlStr: string): string {
  const afterProto = urlStr.replace(/^https?:\/\//, "");
  const slashIdx = afterProto.indexOf("/");
  if (slashIdx === -1) return "/";
  const qIdx = afterProto.indexOf("?", slashIdx);
  return qIdx === -1 ? afterProto.slice(slashIdx) : afterProto.slice(slashIdx, qIdx);
}

function sanitizeRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function redactConfigRows(rows: any[]) {
  return rows.map((row) => {
    const key = String(row.key ?? "");
    const value = String(row.value ?? "");
    if (/token|secret|private|pem|key|clientid|client_id|installation/i.test(key)) {
      return { ...row, value: `<redacted:${value.length}>` };
    }
    return row;
  });
}

// ── Webhook parsing ──────────────────────────────────────────────────────────

interface WebhookMeta {
  eventType: string;
  deliveryId: string;
}

type ParsedEvent =
  | {
      case: "issue";
      owner: string;
      repo: string;
      issueNumber: number;
      action: string;
      title: string;
      body: string;
      htmlUrl: string;
      sender: string;
    }
  | {
      case: "issue_comment";
      owner: string;
      repo: string;
      issueNumber: number;
      commentId: number;
      action: string;
      commentBody: string;
      commentUser: string;
      isPullRequest: boolean;
      issueTitle: string;
      htmlUrl: string;
      sender: string;
    }
  | {
      case: "pull_request";
      owner: string;
      repo: string;
      prNumber: number;
      action: string;
      title: string;
      body: string;
      htmlUrl: string;
      sender: string;
    }
  | {
      case: "pull_request_review_comment";
      owner: string;
      repo: string;
      prNumber: number;
      action: string;
      commentBody: string;
      commentUser: string;
      prTitle: string;
      htmlUrl: string;
      sender: string;
    }
  | {
      case: "push";
      owner: string;
      repo: string;
      ref: string;
      pusher: string;
      commits: Array<{ message: string; id: string }>;
      sender: string;
    }
  | { case: "ignored"; reason: string };

function parseWebhookPayload(meta: WebhookMeta, payload: any): ParsedEvent {
  // Filter out bot actions
  if (payload.sender?.type === "Bot") return { case: "ignored", reason: "bot sender" };

  const repo = payload.repository;
  const owner: string = repo?.owner?.login ?? "";
  const repoName: string = repo?.name ?? "";
  const sender: string = payload.sender?.login ?? "unknown";

  switch (meta.eventType) {
    case "issues": {
      const issue = payload.issue;
      if (!issue) return { case: "ignored", reason: "no issue object" };
      return {
        case: "issue",
        owner,
        repo: repoName,
        issueNumber: issue.number,
        action: payload.action ?? "",
        title: issue.title ?? "",
        body: issue.body ?? "",
        htmlUrl: issue.html_url ?? "",
        sender,
      };
    }

    case "issue_comment": {
      const issue = payload.issue;
      const comment = payload.comment;
      if (!issue || !comment) return { case: "ignored", reason: "no issue/comment object" };
      return {
        case: "issue_comment",
        owner,
        repo: repoName,
        issueNumber: issue.number,
        commentId: comment.id,
        action: payload.action ?? "",
        commentBody: comment.body ?? "",
        commentUser: comment.user?.login ?? "unknown",
        isPullRequest: Boolean(issue.pull_request),
        issueTitle: issue.title ?? "",
        htmlUrl: comment.html_url ?? "",
        sender,
      };
    }

    case "pull_request": {
      const pr = payload.pull_request;
      if (!pr) return { case: "ignored", reason: "no pull_request object" };
      return {
        case: "pull_request",
        owner,
        repo: repoName,
        prNumber: pr.number,
        action: payload.action ?? "",
        title: pr.title ?? "",
        body: pr.body ?? "",
        htmlUrl: pr.html_url ?? "",
        sender,
      };
    }

    case "pull_request_review_comment": {
      const pr = payload.pull_request;
      const comment = payload.comment;
      if (!pr || !comment) return { case: "ignored", reason: "no pr/comment object" };
      return {
        case: "pull_request_review_comment",
        owner,
        repo: repoName,
        prNumber: pr.number,
        action: payload.action ?? "",
        commentBody: comment.body ?? "",
        commentUser: comment.user?.login ?? "unknown",
        prTitle: pr.title ?? "",
        htmlUrl: comment.html_url ?? "",
        sender,
      };
    }

    case "push": {
      if (!payload.ref) return { case: "ignored", reason: "no ref" };
      const commits = (payload.commits ?? []).map((c: any) => ({
        message: c.message ?? "",
        id: c.id ?? "",
      }));
      if (commits.length === 0) return { case: "ignored", reason: "push with no commits" };
      return {
        case: "push",
        owner,
        repo: repoName,
        ref: payload.ref,
        pusher: payload.pusher?.name ?? sender,
        commits,
        sender,
      };
    }

    default:
      return { case: "ignored", reason: `unhandled event type: ${meta.eventType}` };
  }
}

function getAgentPath(parsed: Exclude<ParsedEvent, { case: "ignored" }>): string {
  switch (parsed.case) {
    case "issue":
      return `/agents/github/issue-${parsed.owner}-${parsed.repo}-${parsed.issueNumber}`;
    case "issue_comment":
      if (parsed.isPullRequest) {
        return `/agents/github/pr-${parsed.owner}-${parsed.repo}-${parsed.issueNumber}`;
      }
      return `/agents/github/issue-${parsed.owner}-${parsed.repo}-${parsed.issueNumber}`;
    case "pull_request":
      return `/agents/github/pr-${parsed.owner}-${parsed.repo}-${parsed.prNumber}`;
    case "pull_request_review_comment":
      return `/agents/github/pr-${parsed.owner}-${parsed.repo}-${parsed.prNumber}`;
    case "push":
      return `/agents/github/push-${parsed.owner}-${parsed.repo}-${sanitizeRef(parsed.ref)}`;
  }
}

function formatMessageForAgent(
  meta: WebhookMeta,
  parsed: Exclude<ParsedEvent, { case: "ignored" }>,
): string {
  switch (parsed.case) {
    case "issue":
      return [
        `You received a GitHub notification.`,
        `Event: ${meta.eventType} (${parsed.action})`,
        `Repository: ${parsed.owner}/${parsed.repo}`,
        `Issue #${parsed.issueNumber}: ${parsed.title}`,
        `URL: ${parsed.htmlUrl}`,
        `From: ${parsed.sender}`,
        parsed.body ? `\nBody:\n${parsed.body}` : "",
        "",
        `To respond, call github.createIssueComment with:`,
        `  owner: "${parsed.owner}"`,
        `  repo: "${parsed.repo}"`,
        `  issueNumber: ${parsed.issueNumber}`,
      ]
        .filter(Boolean)
        .join("\n");

    case "issue_comment":
      return [
        `You received a GitHub notification.`,
        `Event: ${meta.eventType} (${parsed.action})`,
        `Repository: ${parsed.owner}/${parsed.repo}`,
        `${parsed.isPullRequest ? "PR" : "Issue"} #${parsed.issueNumber}: ${parsed.issueTitle}`,
        `Comment by: ${parsed.commentUser}`,
        `URL: ${parsed.htmlUrl}`,
        `\nComment:\n${parsed.commentBody}`,
        "",
        `To respond, call github.createIssueComment with:`,
        `  owner: "${parsed.owner}"`,
        `  repo: "${parsed.repo}"`,
        `  issueNumber: ${parsed.issueNumber}`,
      ].join("\n");

    case "pull_request":
      return [
        `You received a GitHub notification.`,
        `Event: ${meta.eventType} (${parsed.action})`,
        `Repository: ${parsed.owner}/${parsed.repo}`,
        `PR #${parsed.prNumber}: ${parsed.title}`,
        `URL: ${parsed.htmlUrl}`,
        `From: ${parsed.sender}`,
        parsed.body ? `\nBody:\n${parsed.body}` : "",
        "",
        `To respond, call github.createIssueComment with:`,
        `  owner: "${parsed.owner}"`,
        `  repo: "${parsed.repo}"`,
        `  issueNumber: ${parsed.prNumber}`,
      ]
        .filter(Boolean)
        .join("\n");

    case "pull_request_review_comment":
      return [
        `You received a GitHub notification.`,
        `Event: ${meta.eventType} (${parsed.action})`,
        `Repository: ${parsed.owner}/${parsed.repo}`,
        `PR #${parsed.prNumber}: ${parsed.prTitle}`,
        `Review comment by: ${parsed.commentUser}`,
        `URL: ${parsed.htmlUrl}`,
        `\nComment:\n${parsed.commentBody}`,
        "",
        `To respond, call github.createIssueComment with:`,
        `  owner: "${parsed.owner}"`,
        `  repo: "${parsed.repo}"`,
        `  issueNumber: ${parsed.prNumber}`,
      ].join("\n");

    case "push":
      return [
        `You received a GitHub notification.`,
        `Event: ${meta.eventType}`,
        `Repository: ${parsed.owner}/${parsed.repo}`,
        `Ref: ${parsed.ref}`,
        `Pushed by: ${parsed.pusher}`,
        "",
        `Commits:`,
        ...parsed.commits.map((c) => `  - ${c.id.slice(0, 7)}: ${c.message}`),
      ].join("\n");
  }
}

// ── oRPC contract ────────────────────────────────────────────────────────────

const githubContract = oc.router({
  createIssueComment: oc
    .route({
      method: "POST",
      path: "/rpc/createIssueComment",
      description: "Comment on an issue or pull request.",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner (e.g. octocat)"),
        repo: z.string().describe("Repository name (e.g. hello-world)"),
        issueNumber: z.number().describe("Issue or PR number"),
        body: z.string().describe("Comment body (Markdown)"),
      }),
    )
    .output(
      z.object({
        id: z.number().optional(),
        html_url: z.string().optional(),
        error: z.string().optional(),
      }),
    ),

  createReaction: oc
    .route({
      method: "POST",
      path: "/rpc/createReaction",
      description:
        "React to an issue. Valid reactions: +1, -1, laugh, confused, heart, hooray, rocket, eyes.",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        issueNumber: z.number().describe("Issue or PR number"),
        content: z
          .string()
          .describe("Reaction type: +1, -1, laugh, confused, heart, hooray, rocket, eyes"),
      }),
    )
    .output(
      z.object({
        id: z.number().optional(),
        content: z.string().optional(),
        error: z.string().optional(),
      }),
    ),

  updateIssue: oc
    .route({
      method: "POST",
      path: "/rpc/updateIssue",
      description: "Update an issue (title, body, state, labels, assignees).",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        issueNumber: z.number().describe("Issue number"),
        title: z.string().optional().describe("New title"),
        body: z.string().optional().describe("New body"),
        state: z.string().optional().describe("State: open or closed"),
        labels: z.array(z.string()).optional().describe("Labels to set"),
        assignees: z.array(z.string()).optional().describe("Assignees to set"),
      }),
    )
    .output(
      z.object({
        id: z.number().optional(),
        html_url: z.string().optional(),
        error: z.string().optional(),
      }),
    ),

  createIssue: oc
    .route({
      method: "POST",
      path: "/rpc/createIssue",
      description: "Create a new issue.",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        title: z.string().describe("Issue title"),
        body: z.string().optional().describe("Issue body (Markdown)"),
        labels: z.array(z.string()).optional().describe("Labels to add"),
        assignees: z.array(z.string()).optional().describe("Assignees to add"),
      }),
    )
    .output(
      z.object({
        id: z.number().optional(),
        number: z.number().optional(),
        html_url: z.string().optional(),
        error: z.string().optional(),
      }),
    ),

  listIssues: oc
    .route({
      method: "GET",
      path: "/rpc/listIssues",
      description: "List issues for a repository.",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        state: z.string().optional().describe("Filter by state: open, closed, all (default: open)"),
        per_page: z.number().optional().describe("Results per page (max 100, default 30)"),
      }),
    )
    .output(z.any()),
});

// ── App DO ────────────────────────────────────────────────────────────────────

export class App extends DurableObject {
  #apiHandler: OpenAPIHandler<typeof githubRouter, GitHubContext> | null = null;

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

  async #githubClient(owner?: string, repo?: string): Promise<GitHubClient> {
    const appId = this.#config("githubAppId");
    const privateKey = this.#config("githubAppPrivateKey");
    if (appId && privateKey) {
      return new GitHubClient(`Bearer ${await this.#githubInstallationToken(owner, repo)}`);
    }

    const token = this.#config("githubToken");
    if (!token) throw new Error("No GitHub token — run /api/install");
    return new GitHubClient(`token ${token}`);
  }

  async #githubAppJwt(): Promise<string> {
    const appId = this.#config("githubAppId");
    const privateKey = this.#config("githubAppPrivateKey");
    if (!appId || !privateKey) throw new Error("GitHub App credentials missing");

    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64UrlEncode(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: appId,
      }),
    );
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
    return `${unsigned}.${base64UrlEncode(signature)}`;
  }

  async #githubInstallationToken(owner?: string, repo?: string): Promise<string> {
    const configuredInstallationId = this.#config("githubAppInstallationId");
    const installationId =
      configuredInstallationId ||
      (owner && repo ? await this.#lookupInstallationId(owner, repo) : "");
    if (!installationId) throw new Error("GitHub App installation ID missing");

    const tokenKey = `githubAppInstallationToken:${installationId}`;
    const expiresAtKey = `githubAppInstallationTokenExpiresAt:${installationId}`;
    const cachedToken = this.#config(tokenKey);
    const expiresAt = Number(this.#config(expiresAtKey) || "0");
    if (cachedToken && expiresAt && Date.now() < expiresAt - 300_000) return cachedToken;

    const jwt = await this.#githubAppJwt();
    const resp = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "user-agent": "iterate-github-app",
        },
      },
    );
    const result: any = await resp.json();
    if (!resp.ok || !result.token)
      throw new Error(`GitHub installation token failed: ${JSON.stringify(result)}`);
    this.#setConfig(tokenKey, result.token);
    this.#setConfig(expiresAtKey, String(Date.parse(result.expires_at)));
    if (!configuredInstallationId)
      this.#setConfig("githubAppInstallationId", String(installationId));
    return result.token;
  }

  async #lookupInstallationId(owner: string, repo: string): Promise<string> {
    const jwt = await this.#githubAppJwt();
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "iterate-github-app",
      },
    });
    const result: any = await resp.json();
    if (!resp.ok || !result.id)
      throw new Error(`GitHub installation lookup failed: ${JSON.stringify(result)}`);
    return String(result.id);
  }

  #mentionsBot(text: string): boolean {
    const mentions = (this.#config("githubBotMentionNames") || "jonasland-iterate-bot")
      .split(",")
      .map((v) => v.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean);
    const body = text.toLowerCase();
    return mentions.some((mention) =>
      new RegExp(`(^|\\s)@${escapeRegExp(mention)}(?=\\s|$|[.,!?;:])`).test(body),
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
    this.#apiHandler = new OpenAPIHandler(githubRouter, {
      plugins: [
        new OpenAPIReferencePlugin({
          docsProvider: "scalar",
          docsPath: "/docs",
          specPath: "/openapi.json",
          schemaConverters: [new ZodToJsonSchemaConverter()],
          specGenerateOptions: {
            info: {
              title: "GitHub App API",
              version: "1.0.0",
              description:
                "GitHub integration tools for agents. Comment on issues, react, create issues, and more.",
            },
          },
        }),
      ],
      interceptors: [onError((error) => console.error("[GitHub API]", error))],
    });
    return this.#apiHandler;
  }

  async fetch(req: Request): Promise<Response> {
    this.#ensureTables();
    const path = getPathname(req.url);

    if (path === "/api/webhook" && req.method === "POST") return this.#webhook(req);
    if (path === "/api/install") return this.#install(req);
    if (path === "/api/config")
      return Response.json(
        redactConfigRows(this.ctx.storage.sql.exec("SELECT * FROM config").toArray()),
      );

    // oRPC handles /api/rpc/*, /api/docs, /api/openapi.json
    if (path.startsWith("/api/")) {
      try {
        const handler = this.#getApiHandler();
        const { matched, response } = await handler.handle(req, {
          prefix: "/api",
          context: {
            githubClient: (owner: string, repo: string) => this.#githubClient(owner, repo),
            markGeneratedComment: (commentId: number) => {
              this.#setConfig(`generatedComment:${commentId}`, "1");
            },
          },
        });
        if (matched && response) return response;
      } catch (e: any) {
        // If GitHub token not configured, docs/spec still fail gracefully
        if (path === "/api/docs" || path === "/api/openapi.json") {
          return new Response("Run /api/install first to configure the GitHub token", {
            status: 500,
          });
        }
      }
    }

    return new Response("GitHub App — /api/install to set up, /api/docs for API reference");
  }

  async #webhook(req: Request): Promise<Response> {
    const eventType = req.headers.get("x-github-event") || "";
    const deliveryId = req.headers.get("x-github-delivery") || "";

    let payload: any;
    try {
      payload = JSON.parse(await req.text());
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }

    if (!eventType)
      return Response.json({ error: "missing x-github-event header" }, { status: 400 });

    // Dedup by delivery ID
    if (deliveryId) {
      const seen = this.ctx.storage.sql
        .exec("SELECT 1 FROM config WHERE key = ?", `seen:${deliveryId}`)
        .toArray();
      if (seen.length) return Response.json({ ok: true, duplicate: true });
      this.#setConfig(`seen:${deliveryId}`, "1");
    }

    const meta: WebhookMeta = { eventType, deliveryId };
    const parsed = parseWebhookPayload(meta, payload);
    if (parsed.case === "ignored")
      return Response.json({ ok: true, ignored: true, reason: parsed.reason });

    if (parsed.case !== "issue_comment" && parsed.case !== "pull_request_review_comment") {
      return Response.json({ ok: true, ignored: true, reason: "not a bot mention comment" });
    }

    const commentBody =
      parsed.case === "issue_comment" || parsed.case === "pull_request_review_comment"
        ? parsed.commentBody
        : "";
    if (!this.#mentionsBot(commentBody)) {
      return Response.json({ ok: true, ignored: true, reason: "missing bot mention" });
    }

    if (parsed.case === "issue_comment") {
      const generated = this.ctx.storage.sql
        .exec("SELECT 1 FROM config WHERE key = ?", `generatedComment:${parsed.commentId}`)
        .toArray();
      if (generated.length)
        return Response.json({ ok: true, ignored: true, reason: "generated comment echo" });
    }

    const agentPath = getAgentPath(parsed);
    const content = formatMessageForAgent(meta, parsed);

    const agentEvent = {
      type: "agent-input-added",
      payload: { role: "user", content, source: "github" },
      idempotencyKey: `agent-input:${deliveryId || Date.now()}`,
    };

    try {
      await this.#appendToStream(agentPath, agentEvent);
    } catch (e: any) {
      console.error(`[GitHub] stream append failed: ${e.message}`);
    }

    // Also POST directly to the agents processor to trigger the AI loop.
    const host = this.#config("hostHeader") || "";
    const agentsHost = host.replace(/^github\./, "agents.");
    try {
      await fetch(`https://${agentsHost}/streams/${encodeURIComponent(agentPath)}/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agentEvent),
      });
    } catch (e: any) {
      console.error(`[GitHub] direct agent trigger failed: ${e.message}`);
    }

    return Response.json({ ok: true, deliveryId });
  }

  async #install(req: Request): Promise<Response> {
    const host = req.headers.get("host") || "localhost";
    const params: Record<string, string> = {};
    const qIdx = req.url.indexOf("?");
    if (qIdx !== -1)
      for (const p of req.url.slice(qIdx + 1).split("&")) {
        const [k, v] = p.split("=");
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
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
    if (params.githubToken) {
      this.#setConfig("githubToken", params.githubToken);
      this.#apiHandler = null;
    }
    if (params.githubAppId) this.#setConfig("githubAppId", params.githubAppId);
    if (params.githubAppPrivateKey)
      this.#setConfig("githubAppPrivateKey", params.githubAppPrivateKey);
    if (params.githubAppInstallationId)
      this.#setConfig("githubAppInstallationId", params.githubAppInstallationId);
    if (params.githubWebhookSecret)
      this.#setConfig("githubWebhookSecret", params.githubWebhookSecret);
    if (params.githubBotMentionNames)
      this.#setConfig("githubBotMentionNames", params.githubBotMentionNames);

    return Response.json({
      ok: true,
      webhookUrl: `https://${host}/api/webhook`,
      authMode: this.#config("githubAppId") ? "github-app" : "token",
    });
  }
}

// ── oRPC router (implemented outside the class, receives context) ────────────

type GitHubContext = {
  githubClient: (owner: string, repo: string) => Promise<GitHubClient>;
  markGeneratedComment?: (commentId: number) => void;
};

const os = implement(githubContract).$context<GitHubContext>();

const githubRouter = os.router({
  createIssueComment: os.createIssueComment.handler(async ({ context, input }) => {
    const client = await context.githubClient(input.owner, input.repo);
    const result = await client.createIssueComment(
      input.owner,
      input.repo,
      input.issueNumber,
      input.body,
    );
    if (result?.id) context.markGeneratedComment?.(result.id);
    return result;
  }),

  createReaction: os.createReaction.handler(async ({ context, input }) => {
    const client = await context.githubClient(input.owner, input.repo);
    return client.createReaction(input.owner, input.repo, input.issueNumber, input.content);
  }),

  updateIssue: os.updateIssue.handler(async ({ context, input }) => {
    const { owner, repo, issueNumber, ...updates } = input;
    const client = await context.githubClient(owner, repo);
    return client.updateIssue(owner, repo, issueNumber, updates);
  }),

  createIssue: os.createIssue.handler(async ({ context, input }) => {
    const { owner, repo, ...data } = input;
    const client = await context.githubClient(owner, repo);
    return client.createIssue(owner, repo, data);
  }),

  listIssues: os.listIssues.handler(async ({ context, input }) => {
    const { owner, repo, ...params } = input;
    const client = await context.githubClient(owner, repo);
    return client.listIssues(owner, repo, params);
  }),
});
