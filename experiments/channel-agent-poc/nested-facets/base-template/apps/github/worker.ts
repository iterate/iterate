/**
 * GitHub App — bidirectional bridge between GitHub webhooks and agent streams.
 *
 * Flow:
 *   GitHub webhook → POST /api/webhook → events.iterate.com/agent/input-added → agent stream
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
import { Octokit } from "@octokit/rest";
import { implement, onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { z } from "zod";

// ── GitHub API ────────────────────────────────────────────────────────────────

class GitHubClient {
  #octokit: Octokit;

  constructor(token: string) {
    this.#octokit = new Octokit({
      auth: token,
      userAgent: "iterate-github-app",
    });
  }

  createIssueComment(owner: string, repo: string, issueNumber: number, body: string) {
    return this.#data(
      this.#octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body }),
    );
  }

  createReaction(owner: string, repo: string, issueNumber: number, content: string) {
    return this.#data(
      this.#octokit.rest.reactions.createForIssue({
        owner,
        repo,
        issue_number: issueNumber,
        content: content as any,
      }),
    );
  }

  createIssueCommentReaction(owner: string, repo: string, commentId: number, content: string) {
    return this.#data(
      this.#octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: content as any,
      }),
    );
  }

  createPullRequestReviewCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: string,
  ) {
    return this.#data(
      this.#octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: commentId,
        content: content as any,
      }),
    );
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
    return this.#data(
      this.#octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, ...updates }),
    );
  }

  createIssue(
    owner: string,
    repo: string,
    data: { title: string; body?: string; labels?: string[]; assignees?: string[] },
  ) {
    return this.#data(this.#octokit.rest.issues.create({ owner, repo, ...data }));
  }

  listIssues(owner: string, repo: string, params: { state?: string; per_page?: number }) {
    return this.#data(
      this.#octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: params.state as any,
        per_page: params.per_page,
      }),
    );
  }

  request(method: string, path: string, body?: any) {
    return this.#data(this.#octokit.request(`${method.toUpperCase()} ${path}`, body ?? {}));
  }

  async #data<T>(promise: Promise<{ data: T }>): Promise<T | { error: string; status?: number }> {
    try {
      return (await promise).data;
    } catch (error: any) {
      return { error: error?.message || String(error), status: error?.status };
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

const DEFAULT_EVENTS = [
  {
    type: "events.iterate.com/agent/system-prompt-updated",
    payload: {
      systemPrompt:
        "You are an Iterate GitHub App bot. Respond to GitHub notifications by writing exactly one fenced `js` codemode block containing the program body directly. Top-level `await` and `return` are valid. Do not write an `async () => { ... }` wrapper; the runtime supplies it. Use the `github` provider only. Do not call `webchat`. Keep the block short and complete. Never write prose outside the fence. For an issue_comment webhook, use `body.repository.owner.login` as owner, `body.repository.name` as repo, and `body.issue.number` as issueNumber. If you need multiple independent GitHub API calls in one response, run them concurrently with `Promise.all([...])`.",
    },
  },
  {
    type: "events.iterate.com/agent/input-added",
    payload: {
      role: "user",
      content:
        "GitHub policy: read the raw `events.iterate.com/github/webhook-received` YAML. Respond with GitHub App actions only. For PR or issue comments, normally call `github.createIssueComment(owner, repo, issueNumber, body)` using `payload.body.repository.owner.login`, `payload.body.repository.name`, and `payload.body.issue.number`. This provider is backed by `@octokit/rest`. For lower-level GitHub REST access, use `github.octokit.request({ owner, repo, method, path, body })`, which maps to Octokit.request; `body` is the Octokit route parameters / JSON body, and the tool returns Octokit's `response.data` directly. Do not send a separate webchat confirmation. There is no `event` global in codemode; copy exact IDs from the YAML into constants. Always return the tool promise or result. If you perform multiple independent actions, use `Promise.all`.",
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
      commentId: number;
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
        commentId: comment.id,
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

function agentInputForGitHubEvent(args: {
  meta: WebhookMeta;
  parsed: Exclude<ParsedEvent, { case: "ignored" }>;
  rawEvent: { type: string; payload?: unknown; idempotencyKey?: string };
}) {
  return {
    type: "events.iterate.com/agent/input-added",
    idempotencyKey: `${args.rawEvent.idempotencyKey || crypto.randomUUID()}:agent-input`,
    payload: {
      role: "user",
      source: "github",
      content: eventToYaml(args.rawEvent),
    },
  };
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

function githubWebhookReceivedEvent(args: {
  meta: WebhookMeta;
  payload: any;
  receivedAt: string;
  host: string;
}) {
  return {
    type: "events.iterate.com/github/webhook-received",
    payload: {
      meta: args.meta,
      body: args.payload,
      receivedAt: args.receivedAt,
      host: args.host,
    },
    idempotencyKey: `github-webhook:${args.meta.deliveryId || `${args.meta.eventType}:${Date.now()}`}`,
  };
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

  createIssueCommentReaction: oc
    .route({
      method: "POST",
      path: "/rpc/createIssueCommentReaction",
      description:
        "React to an issue or PR conversation comment. Valid reactions: +1, -1, laugh, confused, heart, hooray, rocket, eyes.",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        commentId: z.number().describe("Issue comment ID"),
        content: z
          .string()
          .describe("Reaction type: +1, -1, laugh, confused, heart, hooray, rocket, eyes"),
      }),
    )
    .output(z.any()),

  createPullRequestReviewCommentReaction: oc
    .route({
      method: "POST",
      path: "/rpc/createPullRequestReviewCommentReaction",
      description:
        "React to a pull request review comment. Valid reactions: +1, -1, laugh, confused, heart, hooray, rocket, eyes.",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        commentId: z.number().describe("Pull request review comment ID"),
        content: z
          .string()
          .describe("Reaction type: +1, -1, laugh, confused, heart, hooray, rocket, eyes"),
      }),
    )
    .output(z.any()),

  request: oc
    .route({
      method: "POST",
      path: "/rpc/request",
      description:
        "Thin GitHub REST API proxy using the installed GitHub App credentials. Docs: https://docs.github.com/rest",
      tags: ["github"],
    })
    .input(
      z.object({
        owner: z.string().describe("Repository owner used to resolve the installation token"),
        repo: z.string().describe("Repository name used to resolve the installation token"),
        method: z.string().describe("HTTP method, e.g. GET, POST, PATCH"),
        path: z.string().describe("GitHub REST path, e.g. /repos/OWNER/REPO/issues/1"),
        body: z.any().optional().describe("JSON request body"),
      }),
    )
    .output(z.any()),

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
      return new GitHubClient(await this.#githubInstallationToken(owner, repo));
    }

    const token = this.#config("githubToken");
    if (!token) throw new Error("No GitHub token — run /api/install");
    return new GitHubClient(token);
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
    const agentsHost = host.replace(/^github\./, "agents.");
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
        idempotencyKey: events[i].idempotencyKey ?? `default-event:github:${hash}:${i}`,
      });
    }
    this.#setConfig(key, hash);
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

  async #octokitRequest(req: Request): Promise<Response> {
    const input = (await req.json()) as {
      owner?: string;
      repo?: string;
      method?: string;
      path?: string;
      body?: unknown;
    };
    if (!input.owner || !input.repo || !input.method || !input.path) {
      return Response.json(
        { error: "owner, repo, method, and path are required" },
        { status: 400 },
      );
    }
    const client = await this.#githubClient(input.owner, input.repo);
    return Response.json(await client.request(input.method, input.path, input.body));
  }

  async #openApiJson(req: Request): Promise<Response> {
    const handler = this.#getApiHandler();
    const { matched, response } = await handler.handle(req, {
      prefix: "/api",
      context: {
        githubClient: (owner: string, repo: string) => this.#githubClient(owner, repo),
      },
    });
    if (!matched || !response) return Response.json({ error: "not found" }, { status: 404 });
    const spec = (await response.json()) as any;
    spec.paths ??= {};
    spec.paths["/rpc/octokit/request"] = {
      post: {
        operationId: "octokit.request",
        tags: ["github", "octokit"],
        description:
          "@octokit/rest Octokit.request, authenticated as the installed GitHub App for the provided owner/repo. Docs: https://octokit.github.io/rest.js/v21/#octokit-request and https://docs.github.com/rest. Use GitHub REST route paths like `/repos/{owner}/{repo}` plus route parameters in `body`. This tool returns Octokit's `response.data` directly, not the full `{ data, status, headers }` response object.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["owner", "repo", "method", "path"],
                properties: {
                  owner: {
                    type: "string",
                    description:
                      "Repository owner used to resolve the GitHub App installation token.",
                  },
                  repo: {
                    type: "string",
                    description:
                      "Repository name used to resolve the GitHub App installation token.",
                  },
                  method: {
                    type: "string",
                    description:
                      "HTTP method for Octokit.request, e.g. GET, POST, PATCH, PUT, DELETE.",
                  },
                  path: {
                    type: "string",
                    description:
                      "GitHub REST route path for Octokit.request, e.g. `/repos/{owner}/{repo}/issues/{issue_number}`.",
                  },
                  body: {
                    type: "object",
                    description:
                      "Route parameters or JSON request body passed to Octokit.request after the method/path string. Example for GET /repos/{owner}/{repo}: `{ owner, repo }`.",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Octokit response data.",
            content: {
              "application/json": {
                schema: {
                  description:
                    "The `response.data` value returned by @octokit/rest for the requested GitHub REST endpoint.",
                },
              },
            },
          },
        },
      },
    };
    return Response.json(spec);
  }

  async fetch(req: Request): Promise<Response> {
    this.#ensureTables();
    const path = getPathname(req.url);

    if (path === "/" && req.method === "GET") {
      return new Response(defaultEventsEditorHtml("GitHub"), {
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
    if (path === "/api/openapi.json" && req.method === "GET") return this.#openApiJson(req);
    if (path === "/api/rpc/octokit/request" && req.method === "POST") {
      return this.#octokitRequest(req);
    }
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

    const meta: WebhookMeta = { eventType, deliveryId };
    const rawWebhookEvent = githubWebhookReceivedEvent({
      meta,
      payload,
      receivedAt: new Date().toISOString(),
      host: req.headers.get("host") || "",
    });

    try {
      await this.#appendToStream("/github/webhooks", rawWebhookEvent);
    } catch (e: any) {
      console.error(`[GitHub] raw webhook append failed: ${e.message}`);
    }

    // Dedup by delivery ID
    if (deliveryId) {
      const seen = this.ctx.storage.sql
        .exec("SELECT 1 FROM config WHERE key = ?", `seen:${deliveryId}`)
        .toArray();
      if (seen.length) return Response.json({ ok: true, duplicate: true });
      this.#setConfig(`seen:${deliveryId}`, "1");
    }

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

    try {
      const client = await this.#githubClient(parsed.owner, parsed.repo);
      if (parsed.case === "issue_comment") {
        await client.createIssueCommentReaction(
          parsed.owner,
          parsed.repo,
          parsed.commentId,
          "eyes",
        );
      } else {
        await client.createPullRequestReviewCommentReaction(
          parsed.owner,
          parsed.repo,
          parsed.commentId,
          "eyes",
        );
      }
    } catch (e: any) {
      console.error(`[GitHub] reaction failed: ${e.message}`);
    }

    await this.#ensureDefaultEvents(agentPath);

    try {
      await this.#appendToStream(agentPath, rawWebhookEvent);
    } catch (e: any) {
      console.error(`[GitHub] stream append failed: ${e.message}`);
    }

    const agentInputEvent = agentInputForGitHubEvent({
      meta,
      parsed,
      rawEvent: rawWebhookEvent,
    });
    let appendedInput = agentInputEvent;
    try {
      appendedInput = await this.#appendToStream(agentPath, agentInputEvent);
    } catch (e: any) {
      console.error(`[GitHub] agent-input append failed: ${e.message}`);
    }

    // Also POST directly to the agents processor to trigger the AI loop.
    try {
      await this.#processAgentEvent(agentPath, appendedInput);
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

  createIssueCommentReaction: os.createIssueCommentReaction.handler(async ({ context, input }) => {
    const client = await context.githubClient(input.owner, input.repo);
    return client.createIssueCommentReaction(
      input.owner,
      input.repo,
      input.commentId,
      input.content,
    );
  }),

  createPullRequestReviewCommentReaction: os.createPullRequestReviewCommentReaction.handler(
    async ({ context, input }) => {
      const client = await context.githubClient(input.owner, input.repo);
      return client.createPullRequestReviewCommentReaction(
        input.owner,
        input.repo,
        input.commentId,
        input.content,
      );
    },
  ),

  request: os.request.handler(async ({ context, input }) => {
    const client = await context.githubClient(input.owner, input.repo);
    return client.request(input.method, input.path, input.body);
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
