// GitHub Web API access for itx — a real Octokit, wrapped so its transport
// rides one named connection's secret. The installation token never leaves its
// Secret Durable Object: every request Octokit makes carries a
// `getSecret(path, "accessToken")` placeholder Authorization header and is
// dispatched through the connection secret's own `fetch()`, which mints the
// installation token on first use, refreshes it on a 401 (the in-jail
// github-install worker), substitutes the placeholder, and pins the host. The
// caller (itx.integrations.github["<conn>"]) replays its dotted path straight
// onto this instance (rpc-targets.ts), so it IS Octokit — `rest.repos.get(...)`,
// `request("GET /...")`, `graphql(...)` — never a hand-mapped surface. Mirrors
// the Slack WebClient wrapping in slack-api.ts.

import { Octokit } from "@octokit/rest";
import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { githubConnectionSecretPath } from "./utils.ts";

/**
 * A connection-scoped Octokit whose every request is routed through the GitHub
 * connection secret's `fetch()` with the access-token placeholder — so the token
 * stays in the jail and every call lands on the secret's audit trail.
 *
 * `baseUrl` overrides the GitHub API origin (a petshop stand-in in e2e);
 * omitted, Octokit uses `https://api.github.com`.
 */
export function connectionOctokit(input: {
  baseUrl?: string;
  connection: string;
  projectId: string;
}): Octokit {
  const secretPath = githubConnectionSecretPath(input.connection);
  const placeholder = `Bearer getSecret({ path: "${secretPath}", field: "accessToken" })`;
  const stub = itxEnv.SECRET.getByName(
    DurableObjectNameCodec.stringify({ path: secretPath, projectId: input.projectId }),
  );
  return new Octokit({
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    userAgent: "iterate-os",
    // No `auth`: Octokit emits no Authorization of its own; our fetch sets the
    // placeholder, which the secret pipeline substitutes and pins.
    request: {
      fetch: (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", placeholder);
        return stub.fetch(new Request(url, { ...init, headers }));
      },
    },
  });
}

/**
 * Turn an Octokit failure into a caller-facing Error whose message survives the
 * capnweb boundary (which drops `error.name`). A secret-pipeline error (the
 * connection has no usable token) is named so the caller can fix the connection;
 * anything else keeps the HTTP status and Octokit's message.
 */
export function normalizeGithubError(error: unknown, connection: string): Error {
  const e = error as {
    status?: number;
    response?: { data?: { error?: string } };
    message?: string;
  };
  const pipeline = e.response?.data?.error;
  if (typeof pipeline === "string" && pipeline.startsWith("secret_")) {
    return new Error(
      `GitHub connection "${connection}" has no usable installation token (${pipeline}). Use itx.integrations.list() to see connections.`,
    );
  }
  return new Error(`GitHub API failed with HTTP ${e.status ?? "?"}: ${e.message ?? String(error)}`);
}
