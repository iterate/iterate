import { WorkerEntrypoint } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import { parseConfig } from "~/config.ts";
import { getFreshGoogleAccessToken } from "~/domains/secrets/oauth.ts";

type GmailCapabilityEnv = {
  DB?: D1Database;
};

type GmailCapabilityProps = {
  projectId?: string;
};

type GmailRequestInput = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  path: string;
  query?: Record<string, boolean | number | string | null | undefined>;
};

export class GmailCapability extends WorkerEntrypoint<GmailCapabilityEnv, GmailCapabilityProps> {
  async request(request: GmailRequestInput) {
    const token = await this.readToken();
    return await callGmailApi({ request, token });
  }

  private async readToken() {
    if (!this.env.DB) {
      throw new Error("GmailCapability requires the DB binding.");
    }
    const projectId = this.ctx.props.projectId;
    if (!projectId) {
      throw new Error("GmailCapability requires ctx.props.projectId.");
    }

    const config = parseConfig(this.env);
    return await getFreshGoogleAccessToken({
      config,
      db: createD1Client(this.env.DB),
      projectId,
    });
  }
}

async function callGmailApi(input: { request: GmailRequestInput; token: string }) {
  const method = (input.request.method ?? "GET").trim().toUpperCase();
  const url = gmailUrl(input.request);
  const response = await fetch(url, {
    method,
    headers: {
      ...(input.request.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.request.headers ?? {}),
      authorization: `Bearer ${input.token}`,
    },
    ...(input.request.body === undefined || method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(input.request.body) }),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw new Error(
      `Gmail API ${method} ${url.pathname} failed with HTTP ${response.status}: ${formatErrorData(data)}`,
    );
  }

  return {
    data,
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
    statusText: response.statusText,
  };
}

function gmailUrl(input: GmailRequestInput) {
  const path = input.path.trim();
  if (!path) throw new Error("gmail.request requires a non-empty path.");
  const base = "https://gmail.googleapis.com/gmail/v1";
  const url = path.startsWith("https://gmail.googleapis.com/gmail/v1/")
    ? new URL(path)
    : new URL(path.startsWith("/") ? `${base}${path}` : `${base}/${path}`);

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }

  return url;
}

function formatErrorData(value: unknown) {
  if (typeof value === "string") return value.slice(0, 1000);
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return String(value);
  }
}
