// GitHub Web API access for itx — a real Octokit, wrapped so its transport
// rides one named connection's secret. The installation token never leaves its
// Secret Durable Object: every request Octokit makes carries a
// `getSecret(path, "accessToken")` placeholder Authorization header and is
// dispatched through the connection secret's own `fetch()`, whose
// github-app-installation strategy mints the installation token on first use,
// re-mints on 401, substitutes the placeholder, and pins the host — all in
// trusted DO code. The caller's mandatory `.octokit` namespace
// (itx.integrations.github.get("<conn>").octokit) replays its remaining dotted
// path straight onto this instance (rpc-targets.ts), so it IS Octokit —
// `rest.repos.get(...)`, `request("GET /...")`, `graphql(...)` — never a
// hand-mapped surface. Mirrors the Slack WebClient wrapping in slack-api.ts.

import { Octokit } from "octokit";
import { itxEnv } from "../../env.ts";
import { isPathMissMessage } from "../../itx/path-proxy.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { githubAccessTokenPlaceholder, githubConnectionSecretPath } from "./utils.ts";

/**
 * A connection-scoped Octokit whose every request is routed through the GitHub
 * connection secret's `fetch()` with the access-token placeholder — the token
 * never leaves the Secret DO, and every call lands on the secret's audit trail.
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
  const placeholder = `Bearer ${githubAccessTokenPlaceholder(input.connection)}`;
  const stub = itxEnv.SECRET.getByName(
    DurableObjectNameCodec.stringify({ path: secretPath, projectId: input.projectId }),
  );
  return new Octokit({
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    // Disable Octokit's own retry paths: replaying an opaque write after a
    // 5xx/429/408 can duplicate a comment or review. The connection Secret DO
    // may still refresh credentials and repeat once after a 401; that narrow
    // auth retry happens below this transport and is safe to preserve.
    retry: { enabled: false },
    throttle: { enabled: false },
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

/** How to drive the GitHub built-in: get an optional named connection, then an Octokit path
 * replayed onto that connection's wrapped Octokit. The single source of truth,
 * shared by the dispatch guard (rpc-targets) and the error normalizer below. */
export const GITHUB_CALL_GRAMMAR =
  'Use itx.integrations.github.get(connection?).octokit.<path>: for example `.get().octokit.rest.apps.listReposAccessibleToInstallation()`, `.get().octokit.graphql(query, variables)`, or `.get().octokit.request("GET /installation/repositories")`. Pass a connection slug only when a specific installation matters; use itx.integrations.list() to see connections.';

/**
 * Turn an Octokit failure into a caller-facing Error whose message survives the
 * capnweb boundary (which drops `error.name`). A secret-pipeline error (the
 * connection has no usable token) is named so the caller can fix the connection;
 * a path-resolution miss means the caller drove the Octokit with a shape that
 * is not an Octokit method — point them at the grammar; anything else keeps the
 * HTTP status and Octokit's message.
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
  if (typeof e.message === "string" && isPathMissMessage(e.message)) {
    // Covers mid-path misses too (an invented `.api.request(...)` dies on
    // `api` being undefined, not on the leaf) — every miss gets the grammar.
    return new Error(GITHUB_CALL_GRAMMAR);
  }
  return new Error(`GitHub API failed with HTTP ${e.status ?? "?"}: ${e.message ?? String(error)}`);
}
