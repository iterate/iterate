import { spawnSync } from "node:child_process";
import process from "node:process";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

export type CreateOptions = {
  /** Project slug or prj_ ID to open. The resulting browser principal can access this project only. Mutually exclusive with --admin. */
  project?: string;
  /** Create a platform-wide operator session for /admin. Prefer --project for support and debugging. Mutually exclusive with --project. */
  admin?: boolean;
  /** Operator identity written to issuance and redemption audit events. This is attribution, not a customer identity. Defaults to OPERATOR_IDENTITY, GITHUB_ACTOR, USER, then "operator". */
  operator?: string;
  /** Session lifetime in seconds, from 60 through 3600 (default 900). */
  ttlSeconds?: number;
  /** Same-origin path opened after browser redemption. */
  returnTo?: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL or the live local dev server. */
  baseUrl?: string;
  /** Open the one-shot redemption URL in this machine's default browser. */
  open?: boolean;
};

type CreatedOperatorSession = {
  browserUrl: string;
  expiresAt: string;
  kind: "admin" | "project";
  project: { id: string; slug: string } | null;
  token: string;
};

/**
 * Create a short-lived browser session for one project, or an explicit
 * platform-wide operator session. The admin secret stays in this Node process;
 * the browser receives only the signed, expiring grant returned by OS.
 */
export async function create(options: CreateOptions = {}) {
  const isAdmin = options.admin === true;
  const project = options.project?.trim();
  if (isAdmin === Boolean(project)) {
    throw new Error("Pass exactly one of --project <slug-or-id> or --admin.");
  }
  const operatorId = resolveOperatorId(options.operator);

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const adminSecret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!adminSecret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");

  const body = isAdmin
    ? {
        kind: "admin" as const,
        operatorId,
        ...(options.returnTo ? { returnTo: options.returnTo } : {}),
        ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
      }
    : {
        kind: "project" as const,
        operatorId,
        project: project!,
        ...(options.returnTo ? { returnTo: options.returnTo } : {}),
        ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
      };

  const response = await fetch(new URL("/api/operator-sessions", baseUrl), {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${adminSecret}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Could not create operator session (${response.status}): ${(await response.text()).slice(0, 500)}`,
    );
  }
  const created = (await response.json()) as CreatedOperatorSession;
  if (options.open) {
    const { args, command } = openInvocation(created.browserUrl);
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Could not open the operator session URL.");
    const scope = created.kind === "project" ? `project ${created.project?.slug}` : "platform";
    console.info(`Opened ${scope} operator session; expires ${created.expiresAt}.`);
    return;
  }

  // URL only: easy to paste into a browser or consume from browser automation.
  // The signed grant lives after #, so it never reaches edge/request logs.
  console.info(created.browserUrl);
}

function resolveOperatorId(explicit: string | undefined) {
  return (
    explicit?.trim() ||
    process.env.OPERATOR_IDENTITY?.trim() ||
    process.env.GITHUB_ACTOR?.trim() ||
    process.env.USER?.trim() ||
    "operator"
  );
}

function resolveBaseUrl(explicit: string | undefined) {
  const configured = explicit?.trim() || process.env.APP_CONFIG_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/u, "");
  const info = readDevServerInfo(new URL("..", import.meta.url).pathname, { requireLive: true });
  if (info) return info.baseUrl.replace(/\/+$/u, "");
  throw new Error(
    "No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start the local dev server.",
  );
}

function openInvocation(url: string) {
  if (process.platform === "darwin") return { args: [url], command: "open" };
  if (process.platform === "win32") {
    return { args: ["url.dll,FileProtocolHandler", url], command: "rundll32.exe" };
  }
  return { args: [url], command: "xdg-open" };
}
