// GitHub REST proxy for one named connection. The token never leaves its
// Secret Durable Object: the request carries a getSecret placeholder and
// traverses project egress, which substitutes it inside the DO and lands the
// use on the audit trail — the same shape as slack-api.ts.

import { itxEnv } from "../../env.ts";
import type { GithubRequestInput } from "../../types.ts";
import { projectStub } from "../projects/egress.ts";
import { githubTokenSecretPath } from "./utils.ts";

export async function callGithubApi(input: {
  connection: string;
  projectId: string;
  request: GithubRequestInput;
}) {
  const method = (input.request.method ?? "GET").trim().toUpperCase();
  const url = githubUrl(input.request);
  const placeholder = `getSecret("${githubTokenSecretPath(input.connection)}")`;
  const request = new Request(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${placeholder}`,
      "user-agent": "iterate-os",
      ...(input.request.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.request.body === undefined || method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(input.request.body) }),
  });
  const response = await projectStub(itxEnv.PROJECT, input.projectId).fetch(request);
  if (response.status === 404 || response.status === 400) {
    const errorBody = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (errorBody?.error?.startsWith("secret_")) {
      throw new Error(
        `GitHub API ${method} ${url.pathname} failed: connection "${input.connection}" has no usable token secret (${errorBody.error}). Use itx.integrations.list() to see connections.`,
      );
    }
  }

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${url.pathname} failed with HTTP ${response.status}: ${formatErrorData(data)}`,
    );
  }
  return {
    data,
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
    statusText: response.statusText,
  };
}

function githubUrl(input: GithubRequestInput) {
  const path = input.path.trim();
  if (!path) throw new Error("github api.request requires a non-empty path.");
  const base = "https://api.github.com";
  const url = path.startsWith("https://api.github.com/")
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
