import { WorkerEntrypoint } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import { getProjectSecret } from "~/domains/secrets/secrets-store.ts";

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
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.join(".") !== "request") {
      throw new Error(
        `GmailCapability only implements gmail.request, not gmail.${input.functionPath.join(".")}`,
      );
    }
    if (input.args.length !== 1) {
      throw new Error(`gmail.request expects exactly one argument; received ${input.args.length}.`);
    }

    const request = parseGmailRequestInput(input.args[0]);
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

    const secret = await getProjectSecret(createD1Client(this.env.DB), {
      key: "google.access_token",
      projectId,
    });
    if (!secret) {
      throw new Error("GmailCapability requires a project google.access_token Secret.");
    }
    return secret.material;
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

function parseGmailRequestInput(value: unknown): GmailRequestInput {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gmail.request requires an object argument.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string") {
    throw new Error("gmail.request requires a string path.");
  }

  return {
    path: record.path,
    ...(record.method == null ? {} : { method: requireString(record.method, "method") }),
    ...(record.body === undefined ? {} : { body: record.body }),
    ...(record.headers == null ? {} : { headers: parseStringRecord(record.headers, "headers") }),
    ...(record.query == null ? {} : { query: parseQueryRecord(record.query) }),
  };
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new Error(`gmail.request ${field} must be a string.`);
  }
  return value;
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`gmail.request ${field} must be an object.`);
  }

  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      throw new Error(`gmail.request ${field}.${key} must be a string.`);
    }
    output[key] = item;
  }
  return output;
}

function parseQueryRecord(
  value: unknown,
): Record<string, boolean | number | string | null | undefined> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gmail.request query must be an object.");
  }

  const output: Record<string, boolean | number | string | null | undefined> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      item !== null &&
      item !== undefined &&
      typeof item !== "boolean" &&
      typeof item !== "number" &&
      typeof item !== "string"
    ) {
      throw new Error(
        `gmail.request query.${key} must be a string, number, boolean, null, or undefined.`,
      );
    }
    output[key] = item;
  }
  return output;
}

function formatErrorData(value: unknown) {
  if (typeof value === "string") return value.slice(0, 1000);
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return String(value);
  }
}
