import { spawnSync } from "node:child_process";
import process from "node:process";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

export type CreateOptions = {
  /** Project slug or prj_ id. Mutually exclusive with --admin. */
  project?: string;
  /** Mint a platform-wide admin session. Mutually exclusive with --project. */
  admin?: boolean;
  /** Audited principal to impersonate, such as an email or usr_ id. Required for project sessions. */
  as?: string;
  /** Display email when --as is a non-email user id. */
  email?: string;
  /** Session lifetime in seconds, from 60 through 3600 (default 900). */
  ttlSeconds?: number;
  /** Same-origin path opened after browser redemption. */
  returnTo?: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL or the live local dev server. */
  baseUrl?: string;
  /** Open the one-shot browser URL instead of printing it. */
  open?: boolean;
};

type CreatedOperatorSession = {
  browserUrl: string;
  expiresAt: string;
  kind: "admin" | "project";
  project: { id: string; slug: string } | null;
  token: string;
};

/** Mint a short-lived project impersonation or platform-admin browser session. */
export async function create(options: CreateOptions = {}) {
  const isAdmin = options.admin === true;
  const project = options.project?.trim();
  if (isAdmin === Boolean(project)) {
    throw new Error("Pass exactly one of --project <slug-or-id> or --admin.");
  }
  const subject =
    options.as?.trim() ||
    (isAdmin
      ? process.env.USER?.trim()
        ? `operator:${process.env.USER.trim()}`
        : "operator"
      : "");
  if (!subject) throw new Error("Project sessions require --as <email-or-user-id>.");

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const adminSecret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!adminSecret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");

  const body = isAdmin
    ? {
        kind: "admin" as const,
        subject,
        ...(options.returnTo ? { returnTo: options.returnTo } : {}),
        ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
      }
    : {
        kind: "project" as const,
        project: project!,
        subject,
        ...(options.email ? { email: options.email } : {}),
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
    console.info(`Opened ${created.kind} operator session; expires ${created.expiresAt}.`);
    return;
  }

  // URL only: easy to paste into a browser or consume from browser automation.
  // The signed grant lives after #, so it never reaches edge/request logs.
  console.info(created.browserUrl);
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
