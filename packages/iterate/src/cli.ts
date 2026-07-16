import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import process from "node:process";

import * as prompts from "@clack/prompts";
import type { RpcStub } from "capnweb";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os } from "@orpc/server";
import { createCli, parseRouter, type AnyRouter, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod/v4";
import type { StandardSchemaV1 } from "trpc-cli/dist/standard-schema/contract.js";
import type { AuthContractClient } from "../../../apps/auth-contract/src/index.ts";
import { connectItx } from "../../../apps/os/src/itx-client.ts";
import type {
  ItxAuthCredentials,
  Project,
  ProjectListEntry,
  Session,
} from "./itx-api.generated.ts";
import {
  emitComputerNeedsLogin,
  runUseMyComputerJson,
  shareMyComputer,
} from "./use-my-computer.ts";
import { runApprovalCli } from "./approve.ts";
import { emitNeedsLogin, runApprovalJson } from "./approve-json.ts";
import { launchMenubarApp } from "./menubar-app.ts";
import {
  CONFIG_PATH,
  Config,
  DEFAULT_CONFIG_NAME,
  readConfig,
  readConfigFile,
  removeConfigSession,
  updateConfigSession,
  writeConfigFile,
  type StoredSession,
} from "./config.ts";

type ParsedRouter = ReturnType<typeof parseRouter>;

const OAUTH_REFRESH_SKEW_MS = 60_000;
const DEFAULT_CHAT_AGENT_PATH = "/agents/onboarding";
type OsAuthHeaders = { cookie?: string; authorization?: string };
type OsAuth = { credentials: ItxAuthCredentials; requestHeaders?: HeadersInit };
type CreateOsSession = (input: { auth: OsAuth; baseUrl: string }) => RpcStub<Session>;

const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  Boolean(process.env.OPENCODE_SESSION) ||
  Boolean(process.env.CLAUDE_CODE);

/** Global override set by --config flag before CLI commands run. */
let configFlagOverride: string | undefined;

/**
 * We strip host-level flags before handing argv to `trpc-cli`,
 * That keeps router-local help/validation focused on the mounted
 * procedures instead of teaching every command about iterate-specific flags.
 *
 * Example: `iterate --config dev doctor`
 */
const consumeCliStringFlag = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1) return undefined;
  const value = args[flagIndex + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flagName} requires a value`);
  }
  process.argv.splice(flagIndex + 2, 2);
  return value;
};

const firstNonFlagArgument = (args: string[]): string | undefined => {
  for (const arg of args) {
    if (arg === "--") return undefined;
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
};

export const defaultBareInvocationToChat = (args: string[]) =>
  args.length === 0 ? ["chat"] : args;

const applyDefaultBareInvocation = () => {
  const args = process.argv.slice(2);
  const nextArgs = defaultBareInvocationToChat(args);
  if (nextArgs !== args) process.argv.splice(2, args.length, ...nextArgs);
};

const resolveStreamTuiEntrypointPath = () => {
  const moduleDir = import.meta.dirname;
  const candidates = [
    join(moduleDir, "stream-tui/agent-chat-terminal.tsx"),
    join(moduleDir, "stream-tui/agent-chat-terminal.mjs"),
    join(moduleDir, "stream-tui/agent-chat-terminal.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Could not find the Iterate stream TUI entrypoint.");
};

export const buildChatCommand = (input: {
  osBaseUrl: string;
  projectId: string;
  agentPath: string;
  entrypointPath: string;
}) => ({
  command: "bun",
  args: [
    input.entrypointPath,
    "--base-url",
    input.osBaseUrl,
    "--project-id",
    input.projectId,
    "--agent-path",
    input.agentPath,
  ],
});

const runInheritedProcess = async (input: {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}): Promise<void> => {
  const child = spawn(input.command, input.args, {
    stdio: "inherit",
    env: { ...process.env, ...input.env },
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  if (result.signal) {
    throw new Error(`${input.command} exited with signal ${result.signal}.`);
  }
  if (result.code !== 0) {
    throw new Error(`${input.command} exited with code ${result.code ?? "unknown"}.`);
  }
};

const hasConfig = (configFile: ReturnType<typeof readConfigFile>, name: string) =>
  name === DEFAULT_CONFIG_NAME || Boolean(configFile.configs?.[name]);

/**
 * Resolve which config name to use.
 * Priority: --config flag > workspace match (walk up from cwd) > default > single-config auto > built-in prd
 */
const resolveConfigName = (workspacePath: string): string | Error => {
  const configFile = readConfigFile();

  if (configFlagOverride) {
    if (!hasConfig(configFile, configFlagOverride)) {
      return new Error(
        `Config "${configFlagOverride}" not found. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
      );
    }
    return configFlagOverride;
  }

  // Walk up directory tree for workspace match
  let dir = workspacePath;
  while (dir && dir !== "/") {
    const match = configFile.workspaces?.[dir];
    if (match) {
      if (!hasConfig(configFile, match)) {
        return new Error(`Workspace "${dir}" maps to config "${match}" which doesn't exist.`);
      }
      return match;
    }
    dir = dirname(dir);
  }

  if (configFile.default) {
    if (!hasConfig(configFile, configFile.default)) {
      return new Error(
        `Default config "${configFile.default}" doesn't exist. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
      );
    }
    return configFile.default;
  }

  // If there's exactly one config, use it
  const configNames = Object.keys(configFile.configs || {});
  if (configNames.length === 1) return configNames[0];

  return DEFAULT_CONFIG_NAME;
};

function resolveConfig(workspacePath: string): { name: string; config: Config } | Error;
function resolveConfig(
  workspacePath: string,
  options: { throw: true },
): { name: string; config: Config };
function resolveConfig(
  workspacePath: string,
  options?: { throw: true },
): { name: string; config: Config } | Error {
  const result = ((): { name: string; config: Config } | Error => {
    const name = resolveConfigName(workspacePath);
    if (name instanceof Error) return name;
    const config = readConfig(name);
    if (config instanceof Error) return config;
    return { name, config };
  })();
  if (result instanceof Error && options?.throw) throw result;
  return result;
}

class StoredOsSessionError extends Error {
  readonly reason: "missing" | "expired";

  constructor(reason: "missing" | "expired", message: string) {
    super(message);
    this.reason = reason;
    this.name = "StoredOsSessionError";
  }
}

/**
 * Get auth headers for OS API calls based on the resolved config's stored session.
 * OAuth sessions are refreshed when possible.
 */
const getOsAuthHeaders = async (config: Config, configName?: string): Promise<OsAuthHeaders> => {
  let session = config.session;
  if (!session) {
    throw new StoredOsSessionError(
      "missing",
      `Not logged in to ${config.osBaseUrl}. Run \`iterate login\` first.`,
    );
  }
  if (sessionNeedsRefresh(session)) {
    if (session.refreshToken && session.clientId) {
      session = await refreshOAuthSession({ config, configName, session });
    } else {
      throw new StoredOsSessionError(
        "expired",
        `Session expired for ${config.osBaseUrl}. Run \`iterate login\` again.`,
      );
    }
  }
  if (session.token) {
    return { authorization: `Bearer ${session.token}` };
  }
  if (session.cookie) {
    return { cookie: session.cookie };
  }
  throw new Error(`Stored session for ${config.osBaseUrl} has no token or cookie.`);
};

const osAuthFromHeaders = (headers: OsAuthHeaders): OsAuth => {
  if (headers.authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(headers.authorization);
    if (!match) throw new Error("Stored OS authorization header is not a bearer token.");
    return { credentials: { type: "bearer", token: match[1] } };
  }
  if (headers.cookie) {
    return {
      credentials: { type: "from-server-cookie" },
      requestHeaders: { cookie: headers.cookie },
    };
  }
  throw new Error("No OS auth credentials available.");
};

const osAuthFromEnvironment = (): OsAuth | undefined => {
  const adminSecret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (adminSecret) return { credentials: { type: "admin-secret", secret: adminSecret } };

  const bearerToken = process.env.ITERATE_BEARER_TOKEN?.trim();
  if (bearerToken) return { credentials: { type: "bearer", token: bearerToken } };

  return undefined;
};

const disposeRpc = (stub: { [Symbol.dispose]?: () => void } | undefined) => {
  try {
    stub?.[Symbol.dispose]?.();
  } catch {
    // Broken transports may already have disposed the remote side.
  }
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const headersRecord = (headers: HeadersInit | undefined): Record<string, string> | undefined => {
  if (headers === undefined) return undefined;
  return Object.fromEntries(new Headers(headers).entries());
};

const withAuthenticatedOsSession = async <T>(input: {
  auth: OsAuth;
  baseUrl: string;
  createSession?: CreateOsSession;
  run: (session: RpcStub<Session>) => Promise<T>;
}): Promise<T> => {
  const session =
    input.createSession?.({ auth: input.auth, baseUrl: input.baseUrl }) ??
    (connectItx({
      auth: input.auth.credentials,
      baseUrl: input.baseUrl,
      headers: headersRecord(input.auth.requestHeaders),
    }) as RpcStub<Session>);

  try {
    return await input.run(session);
  } finally {
    disposeRpc(session);
  }
};

export const verifyOsSession = async (input: {
  authHeaders: OsAuthHeaders;
  baseUrl: string;
  createSession?: CreateOsSession;
}) => {
  return await withAuthenticatedOsSession({
    auth: osAuthFromHeaders(input.authHeaders),
    baseUrl: input.baseUrl,
    createSession: input.createSession,
    run: async (session) => await session.__describe(),
  });
};

const setupMissingProjectForChat = async (session: RpcStub<Session>, project: ProjectListEntry) => {
  let projectItx: RpcStub<Project> | undefined;
  try {
    projectItx = (await session.projects.create({
      projectId: project.id,
      slug: project.slug,
      ...(project.organizationSlug ? { organizationSlug: project.organizationSlug } : {}),
      waitUntilReady: false,
    })) as unknown as RpcStub<Project>;
  } catch (error) {
    throw new Error(
      `Project "${project.slug}" (${project.id}) exists in auth but is missing in OS. Failed to set it up for chat: ${errorMessage(error)}`,
    );
  } finally {
    disposeRpc(projectItx);
  }
  return project.id;
};

const accessibleProjectsMessage = (projects: ProjectListEntry[]) =>
  projects.length === 0
    ? "No accessible projects found."
    : `Accessible projects: ${projects
        .map((project) => `${project.slug} (${project.id}, ${project.deploymentStatus})`)
        .join(", ")}.`;

export const resolveChatProject = async (input: {
  auth: OsAuth;
  baseUrl: string;
  configName: string;
  configPath: string;
  configuredDefaultProject?: string;
  createSession?: CreateOsSession;
  explicitProject?: string;
}) => {
  const configured = input.explicitProject || input.configuredDefaultProject;

  return await withAuthenticatedOsSession({
    auth: input.auth,
    baseUrl: input.baseUrl,
    createSession: input.createSession,
    run: async (session) => {
      let projects: ProjectListEntry[];
      try {
        projects = await session.projects.list();
      } catch (error) {
        if (configured) {
          throw new Error(
            `Failed to resolve project "${configured}" for config "${input.configName}" in ${input.configPath}. The CLI could not list accessible projects, so it cannot resolve slugs or recover auth-known projects that are missing in OS: ${errorMessage(error)}`,
          );
        }
        throw new Error(
          `No project specified. Pass --project or set "defaultProject" on config "${input.configName}" in ${input.configPath}. Failed to list accessible projects: ${errorMessage(error)}`,
        );
      }

      if (configured) {
        const project = projects.find(
          (candidate) => candidate.id === configured || candidate.slug === configured,
        );
        if (!project) {
          if (configured.startsWith("prj_")) return configured;
          throw new Error(
            `Project "${configured}" was not found among accessible projects for config "${input.configName}" in ${input.configPath}. ${accessibleProjectsMessage(projects)}`,
          );
        }
        if (project.deploymentStatus === "missing") {
          return await setupMissingProjectForChat(session, project);
        }
        return project.id;
      }

      const readyProjects = projects.filter((project) => project.deploymentStatus === "ready");
      const candidates = readyProjects.length > 0 ? readyProjects : projects;
      if (candidates.length === 1) {
        const project = candidates[0]!;
        if (project.deploymentStatus === "missing") {
          return await setupMissingProjectForChat(session, project);
        }
        return project.id;
      }

      throw new Error(
        `No project specified. Pass --project or set "defaultProject" on config "${input.configName}" in ${input.configPath}. ${accessibleProjectsMessage(projects)}`,
      );
    },
  });
};

const sessionNeedsRefresh = (session: StoredSession) => {
  if (!session.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + OAUTH_REFRESH_SKEW_MS;
};

const getAuthWorkerHeaders = async (
  config: Config,
): Promise<{ cookie?: string; authorization?: string }> => {
  const session = config.session;
  if (!session) {
    throw new Error(`Not logged in to ${config.authBaseUrl}. Run \`iterate login\` first.`);
  }
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
    throw new Error(`Session expired for ${config.authBaseUrl}. Run \`iterate login\` again.`);
  }
  if (session.token) {
    return { authorization: `Bearer ${session.token}` };
  }
  if (session.cookie) {
    return { cookie: session.cookie };
  }
  throw new Error(`Stored session for ${config.authBaseUrl} has no token or cookie.`);
};

const getAuthWorkerClient = async (config: Config): Promise<AuthContractClient> => {
  const baseURL = config.authBaseUrl;
  const headers = await getAuthWorkerHeaders(config);
  return createORPCClient(
    new RPCLink({
      url: `${baseURL}/api/orpc/`,
      fetch: async (request: URL | Request, init?: RequestInit) => {
        const reqHeaders = new Headers(
          request instanceof Request ? request.headers : init?.headers,
        );
        if (headers.cookie) reqHeaders.set("cookie", headers.cookie);
        if (headers.authorization) reqHeaders.set("authorization", headers.authorization);
        return fetch(request, { ...init, headers: reqHeaders });
      },
    }),
  );
};

const OAUTH_SCOPE = "openid profile email offline_access project";
const LOOPBACK_HOST = "localhost";
const LOOPBACK_CALLBACK_PATH = "/callback";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
};

const base64Url = (buffer: Buffer) => buffer.toString("base64url");

const randomBase64Url = (byteLength = 32) => base64Url(randomBytes(byteLength));

export const oauthResourceForOsBaseUrl = (osBaseUrl: string) => {
  const url = new URL(osBaseUrl);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

  if (loopbackHosts.has(url.hostname)) {
    return `${url.protocol}//${url.hostname}`;
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
};

const openUrlInBrowser = async (url: string) => {
  try {
    const { execFile } = await import("node:child_process");
    if (process.platform === "darwin") {
      execFile("open", [url]);
      return;
    }
    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", url]);
      return;
    }
    execFile("xdg-open", [url]);
  } catch {
    // Ignore; the URL is printed for manual opening.
  }
};

const readErrorBody = async (response: Response) => {
  const text = await response.text();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
};

const registerOAuthClient = async (input: { authBaseUrl: string; redirectUri: string }) => {
  const response = await fetch(`${input.authBaseUrl}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: input.authBaseUrl },
    body: JSON.stringify({
      client_name: "Iterate CLI",
      redirect_uris: [input.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPE,
      type: "native",
      require_pkce: true,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OAuth client registration failed (${response.status}): ${await readErrorBody(response)}`,
    );
  }

  const client = (await response.json()) as { client_id?: string };
  if (!client.client_id) throw new Error("OAuth client registration did not return client_id.");
  return client.client_id;
};

const startOAuthCallbackServer = async (): Promise<{
  redirectUri: string;
  wait: () => Promise<{ code: string; state: string; redirectUri: string }>;
  close: () => Promise<void>;
}> => {
  let settled = false;
  let resolveCallback:
    | ((value: { code: string; state: string; redirectUri: string }) => void)
    | undefined;
  let rejectCallback: ((reason: unknown) => void) | undefined;

  const callbackPromise = new Promise<{
    code: string;
    state: string;
    redirectUri: string;
  }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (settled) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth callback already received.");
      return;
    }

    const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== LOOPBACK_CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      settled = true;
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>Iterate login failed</h1><p>You can return to the terminal.</p>");
      rejectCallback?.(
        new Error(
          `OAuth authorization failed: ${error}${
            url.searchParams.get("error_description")
              ? ` (${url.searchParams.get("error_description")})`
              : ""
          }`,
        ),
      );
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      settled = true;
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>Iterate login failed</h1><p>Missing code or state.</p>");
      rejectCallback?.(new Error("OAuth callback was missing code or state."));
      return;
    }

    settled = true;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>Iterate login complete</h1><p>You can close this tab.</p>");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolveCallback?.({
      code,
      state,
      redirectUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCallback?.(new Error("Timed out waiting for OAuth callback."));
    }
  }, OAUTH_CALLBACK_TIMEOUT_MS);
  timeout.unref();

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`,
    wait: () => callbackPromise.finally(() => clearTimeout(timeout)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const exchangeOAuthCode = async (input: {
  authBaseUrl: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}) => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  });

  const response = await fetch(`${input.authBaseUrl}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: input.authBaseUrl,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${await readErrorBody(response)}`,
    );
  }

  const token = (await response.json()) as OAuthTokenResponse;
  if (!token.access_token) throw new Error("OAuth token exchange did not return access_token.");
  return token;
};

const oauthTokenToSession = (
  token: OAuthTokenResponse,
  existing: Pick<StoredSession, "clientId" | "refreshToken"> | undefined,
): StoredSession => {
  const expiresAtMs = token.expires_at
    ? token.expires_at * 1000
    : token.expires_in
      ? Date.now() + token.expires_in * 1000
      : undefined;
  return {
    token: token.access_token,
    refreshToken: token.refresh_token ?? existing?.refreshToken,
    clientId: existing?.clientId,
    scope: token.scope,
    tokenType: token.token_type,
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : undefined,
  };
};

export const refreshOAuthSession = async (input: {
  config: Config;
  configName?: string;
  session: StoredSession;
}): Promise<StoredSession> => {
  if (!input.session.refreshToken || !input.session.clientId) {
    throw new Error(`Session expired for ${input.config.osBaseUrl}. Run \`iterate login\` again.`);
  }

  const authBaseUrl = input.config.authBaseUrl;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.session.clientId,
    refresh_token: input.session.refreshToken,
    resource: oauthResourceForOsBaseUrl(input.config.osBaseUrl),
  });
  if (input.session.scope) body.set("scope", input.session.scope);

  const response = await fetch(`${authBaseUrl}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: authBaseUrl,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth refresh failed (${response.status}). Run \`iterate login\` again.`);
  }

  const token = (await response.json()) as OAuthTokenResponse;
  const refreshedSession = oauthTokenToSession(token, input.session);
  refreshedSession.clientId = input.session.clientId;
  input.config.session = refreshedSession;
  if (input.configName) updateConfigSession(input.configName, refreshedSession);
  return refreshedSession;
};

const oauthLogin = async (config: Config): Promise<StoredSession> => {
  const authBaseUrl = config.authBaseUrl;
  const resource = oauthResourceForOsBaseUrl(config.osBaseUrl);
  const codeVerifier = randomBase64Url(48);
  const state = randomBase64Url(32);
  const callback = await startOAuthCallbackServer();
  const clientId = await registerOAuthClient({ authBaseUrl, redirectUri: callback.redirectUri });

  const authorizeUrl = new URL(`${authBaseUrl}/api/auth/oauth2/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", callback.redirectUri);
  authorizeUrl.searchParams.set("scope", OAUTH_SCOPE);
  authorizeUrl.searchParams.set("resource", resource);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set(
    "code_challenge",
    base64Url(createHash("sha256").update(codeVerifier).digest()),
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  console.error(`\nOpening browser to authenticate with Iterate:\n`);
  console.error(`  ${authorizeUrl.href}\n`);
  if (!isAgent && process.env.ITERATE_SKIP_BROWSER_OPEN !== "1") {
    await openUrlInBrowser(authorizeUrl.href);
  }

  let callbackResult: { code: string; state: string; redirectUri: string };
  try {
    callbackResult = await callback.wait();
  } finally {
    await callback.close().catch(() => {});
  }

  if (callbackResult.state !== state) {
    throw new Error("OAuth callback state did not match. Please try again.");
  }

  const token = await exchangeOAuthCode({
    authBaseUrl,
    clientId,
    code: callbackResult.code,
    codeVerifier,
    redirectUri: callbackResult.redirectUri,
    resource,
  });
  const session = oauthTokenToSession(token, { clientId, refreshToken: undefined });
  session.clientId = clientId;
  return session;
};

const loginToResolvedConfig = async (resolved: { name: string; config: Config }) => {
  const { config } = resolved;

  console.error(`Logging in to ${config.authBaseUrl}...`);
  const oauthResult = await oauthLogin(config);
  updateConfigSession(resolved.name, oauthResult);
  // Update in-memory config so subsequent verification and calls see the token.
  config.session = oauthResult;

  await verifyOsSession({
    authHeaders: await getOsAuthHeaders(config, resolved.name),
    baseUrl: config.osBaseUrl,
  }).catch((error: unknown) => {
    throw new Error(`Failed to verify OS session: ${errorMessage(error)}`);
  });

  return oauthResult;
};

const shouldAutoLoginForChat = (error: unknown) =>
  error instanceof StoredOsSessionError &&
  (error.reason === "missing" || error.reason === "expired");

export const ensureBearerAuthHeadersForChat = async (input: {
  getAuthHeaders: () => Promise<OsAuthHeaders>;
  login: () => Promise<void>;
  osBaseUrl: string;
}) => {
  let authHeaders = await input.getAuthHeaders();
  if (authHeaders.authorization) return authHeaders;

  console.error(
    `Stored session for ${input.osBaseUrl} cannot be used for chat. Starting browser login...`,
  );
  await input.login();
  authHeaders = await input.getAuthHeaders();
  if (authHeaders.authorization) return authHeaders;

  throw new Error(
    `Stored session for ${input.osBaseUrl} has no bearer token. Run \`iterate login\` again.`,
  );
};

const loadRemoteProcedures = async (params: {
  baseUrl: string;
}): Promise<{ procedures: ParsedRouter }> => {
  const url = `${params.baseUrl}/api/trpc-cli-procedures`;
  const response = await fetch(url);
  if (!response.ok) {
    let text = await response.text();
    if (text.includes("<title>")) {
      text = "HTML with title: " + text.split("<title>")[1].split("</title>")[0];
    } else if (["<html>", "<body>", "<head>", "!DOCTYPE html"].some((s) => text.includes(s))) {
      text = "<html>...</html>";
    } else {
      text = text.split("\n")[0];
      if (text.length > 50) text = text.slice(0, 50) + "...";
    }

    throw new Error(`${url} got ${response.status}: ${text}`);
  }

  let router: any;
  try {
    router = await response.json();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${url} returned invalid router: ${message}`);
  }
  if (!Array.isArray(router?.procedures)) {
    throw new Error(`${url} returned invalid router: ${JSON.stringify(router)}`);
  }
  return router as { procedures: ParsedRouter };
};

/** Wraps an oRPC client so `wrapper[dotPath].query(input)` and `.mutate(input)` work (for trpc-cli proxify compat) */
const orpcToTrpcStyleClient = (orpcClient: unknown) => {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        const parts = prop.split(".");
        let current: any = orpcClient;
        for (const part of parts) current = current[part];
        return {
          query: (input: any) => current(input),
          mutate: (input: any) => current(input),
        };
      },
    },
  );
};

const getOsProcedures = async (params: {
  baseUrl: string;
  config: Config;
  configName?: string;
}) => {
  const appRouter = await loadRemoteProcedures(params);
  const proxiedRouter = proxifyOrpc(appRouter.procedures, () => {
    const client = createORPCClient(
      new RPCLink({
        url: `${params.baseUrl}/api/orpc/`,
        fetch: async (request: URL | Request, init?: RequestInit) => {
          const authHeaders = await getOsAuthHeaders(params.config, params.configName);
          const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
          if (authHeaders.cookie) headers.set("cookie", authHeaders.cookie);
          if (authHeaders.authorization) headers.set("authorization", authHeaders.authorization);
          return fetch(request, { ...init, headers });
        },
      }),
    );
    return orpcToTrpcStyleClient(client);
  });

  return proxiedRouter;
};

const launcherProcedures = {
  ping: os.input(z.object({})).handler(async () => {
    const resolved = resolveConfig(process.cwd(), { throw: true });
    const { config } = resolved;
    const description = await verifyOsSession({
      authHeaders: await getOsAuthHeaders(config, resolved.name),
      baseUrl: config.osBaseUrl,
    }).catch((error: unknown) => {
      throw new Error(`Failed to verify OS session: ${errorMessage(error)}`);
    });
    return { message: "OS session valid", principal: description.principal };
  }),
  login: os
    .input(z.object({}))
    .meta({
      description: "Authenticate with the OS server via browser-based OAuth",
    })
    .handler(async () => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      const oauthResult = await loginToResolvedConfig(resolved);
      return {
        message: "Logged in successfully",
        expiresAt: oauthResult.expiresAt,
        scope: oauthResult.scope,
      };
    }),

  logout: os
    .input(z.object({}))
    .meta({ description: "Remove stored session for the current config" })
    .handler(async () => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      removeConfigSession(resolved.name);
      return { message: `Logged out from ${resolved.name} (${resolved.config.osBaseUrl})` };
    }),

  chat: os
    .input(
      z.object({
        project: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "OS project id (prj_…) or slug. Defaults to the active config's defaultProject.",
          ),
        agentPath: z
          .string()
          .trim()
          .min(1)
          .startsWith("/agents/")
          .optional()
          .default(DEFAULT_CHAT_AGENT_PATH)
          .describe("Agent stream path to chat with (default: /agents/onboarding)"),
      }),
    )
    .meta({
      description: "Open the Iterate agent chat terminal UI",
    })
    .handler(async ({ input }) => {
      // Resolved here, not in the input schema: the schema is built at module
      // load, before `--config` has been consumed.
      const resolved = resolveConfig(process.cwd(), { throw: true });
      const envAuth = osAuthFromEnvironment();
      let storedAuthHeaders: OsAuthHeaders | undefined;
      let didAutoLogin = false;
      const loginForChat = async () => {
        didAutoLogin = true;
        storedAuthHeaders = undefined;
        await loginToResolvedConfig(resolved);
      };
      const getStoredAuthHeaders = async () => {
        if (storedAuthHeaders) return storedAuthHeaders;
        try {
          storedAuthHeaders = await getOsAuthHeaders(resolved.config, resolved.name);
        } catch (error) {
          if (didAutoLogin || !shouldAutoLoginForChat(error)) throw error;
          console.error(
            `No active session for ${resolved.config.osBaseUrl}. Starting browser login...`,
          );
          await loginForChat();
          storedAuthHeaders = await getOsAuthHeaders(resolved.config, resolved.name);
        }
        return storedAuthHeaders;
      };
      const getStoredBearerAuthHeaders = () =>
        ensureBearerAuthHeadersForChat({
          getAuthHeaders: getStoredAuthHeaders,
          login: loginForChat,
          osBaseUrl: resolved.config.osBaseUrl,
        });
      const project = await resolveChatProject({
        auth: envAuth ?? osAuthFromHeaders(await getStoredBearerAuthHeaders()),
        baseUrl: resolved.config.osBaseUrl,
        configName: resolved.name,
        configPath: CONFIG_PATH,
        configuredDefaultProject: resolved.config.defaultProject,
        explicitProject: input.project,
      });
      const command = buildChatCommand({
        osBaseUrl: resolved.config.osBaseUrl,
        projectId: project,
        agentPath: input.agentPath,
        entrypointPath: resolveStreamTuiEntrypointPath(),
      });
      // Auth: admin/bearer secrets from the inherited environment win (doppler,
      // e2e). Otherwise refresh the stored `iterate login` session here — the
      // launcher owns the OAuth refresh machinery — and hand the TUI a plain
      // bearer token; the capnweb WebSocket authenticates once at connect.
      const env: Record<string, string | undefined> = { ITERATE_CONFIG_NAME: resolved.name };
      if (!envAuth) {
        const headers = await getStoredBearerAuthHeaders();
        const token = headers.authorization?.replace(/^Bearer /, "");
        if (!token) {
          throw new Error(
            `Stored session for ${resolved.config.osBaseUrl} has no bearer token. Run \`iterate login\` again.`,
          );
        }
        env.ITERATE_BEARER_TOKEN = token;
      }
      await runInheritedProcess({ ...command, env });
    }),

  useMyComputer: os
    .input(
      z.object({
        project: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "OS project id (prj_…) or slug. Defaults to the active config's defaultProject.",
          ),
        name: z
          .string()
          .trim()
          .regex(
            /^[a-zA-Z][a-zA-Z0-9]*$/,
            "Use a camelCase name: letters and digits, starting with a letter.",
          )
          .optional()
          .describe(
            "Name agents use to reach this computer (camelCase; the itx.<name> path). Prompted if omitted.",
          ),
        json: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Machine mode for the menu-bar app: NDJSON activity on stdout. Never opens a browser — emits a needs-login line instead.",
          ),
      }),
    )
    .meta({
      description:
        "Share THIS computer with a project's agents as itx.myComputer (native dialogs, notifications, Swift). Runs until Ctrl-C.",
    })
    .handler(async ({ input }) => {
      const resolved = resolveConfig(process.cwd(), { throw: true });

      // Auth, exactly like `chat`: env secrets win (doppler/e2e), otherwise use
      // the stored `iterate login` session. In JSON mode we never open a
      // browser — a missing session is reported so the app can drive login.
      const envAuth = osAuthFromEnvironment();
      let authHeaders: OsAuthHeaders | undefined;
      if (!envAuth) {
        try {
          authHeaders = await getOsAuthHeaders(resolved.config, resolved.name);
        } catch (error) {
          if (!shouldAutoLoginForChat(error)) throw error;
          if (input.json) {
            emitComputerNeedsLogin();
            return;
          }
          console.error(
            `No active session for ${resolved.config.osBaseUrl}. Starting browser login...`,
          );
          await loginToResolvedConfig(resolved);
          authHeaders = await getOsAuthHeaders(resolved.config, resolved.name);
        }
      }
      const auth = envAuth ?? osAuthFromHeaders(authHeaders!);

      const projectId = await resolveChatProject({
        auth,
        baseUrl: resolved.config.osBaseUrl,
        configName: resolved.name,
        configPath: CONFIG_PATH,
        configuredDefaultProject: resolved.config.defaultProject,
        explicitProject: input.project,
      });

      // The share loop re-resolves credentials before every (re)connect so it
      // survives the short access-token TTL over extended sharing: env secrets
      // win (doppler/e2e, never expire), else re-read the stored session — which
      // refreshes the OAuth token when it's near expiry.
      const reauth = async () => {
        const env = osAuthFromEnvironment();
        if (env) return { auth: env.credentials, headers: headersRecord(env.requestHeaders) };
        // Re-read the EXACT launch-time config by name (picks up a token the
        // previous refresh persisted) — never re-resolve from cwd, which could
        // select a different config and send its credential to this server.
        const config = readConfig(resolved.name);
        if (config instanceof Error) throw config;
        const refreshed = osAuthFromHeaders(await getOsAuthHeaders(config, resolved.name));
        return { auth: refreshed.credentials, headers: headersRecord(refreshed.requestHeaders) };
      };
      const shared = {
        baseUrl: resolved.config.osBaseUrl,
        projectId,
        name: input.name,
        reauth,
      };
      // JSON mode announces activity for the menu-bar app; the terminal form
      // prompts for a name and prints a paste-for-your-agent hint. Both block.
      if (input.json) {
        await runUseMyComputerJson(shared);
        return;
      }
      await shareMyComputer(shared);
    }),

  approve: os
    .input(
      z.object({
        project: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "OS project id (prj_…) or slug. Defaults to the active config's defaultProject.",
          ),
        enroll: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Generate this machine's approval key (Secure Enclave when available) and enroll it before listening.",
          ),
        softwareKey: z
          .boolean()
          .optional()
          .default(false)
          .describe("With --enroll: force a software P-256 key instead of the Secure Enclave."),
        native: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "macOS: approve via native dialogs — the Approve button leads straight into Touch ID. Needs an enrolled Secure Enclave key.",
          ),
        keys: z
          .boolean()
          .optional()
          .default(false)
          .describe("List the project's enrolled approval keys and exit."),
        revoke: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Revoke this machine's approval key (append key-revoked, destroy local material) and exit.",
          ),
        json: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Machine mode for the menu-bar app: NDJSON events on stdout, {offset,decision} on stdin. Never opens a browser — emits a needs-login line instead.",
          ),
        menubar: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "macOS: build (on first use, from the shipped Swift source) and launch the menu-bar approver app for this project, then exit.",
          ),
      }),
    )
    .meta({
      description:
        "Be the human in the loop for a project's egress: watch held outbound requests and approve or reject each one (Touch-ID-signed when an enclave key is enrolled). Runs until Ctrl-C.",
    })
    .handler(async ({ input }) => {
      const resolved = resolveConfig(process.cwd(), { throw: true });

      // --menubar just builds + launches the GUI app; it needs no auth here (the
      // app signs in itself). Handle it first, and standalone.
      if (input.menubar) {
        if (input.json || input.enroll || input.keys || input.revoke || input.native) {
          throw new Error("--menubar is standalone; run it without the other flags.");
        }
        const project = input.project ?? resolved.config.defaultProject;
        if (!project) {
          throw new Error("--menubar needs --project or a configured defaultProject.");
        }
        await launchMenubarApp({
          configName: resolved.name,
          project,
          log: (message) => console.error(message),
        });
        return;
      }

      // --json is listen-and-decide only; the setup flags are for the terminal
      // form. Reject the combination loudly rather than silently ignoring it.
      if (input.json && (input.enroll || input.keys || input.revoke || input.native)) {
        throw new Error(
          "--json cannot be combined with --enroll/--keys/--revoke/--native; run those separately.",
        );
      }

      // Auth, exactly like `chat`: env secrets win (doppler/e2e), otherwise use
      // the stored `iterate login` session. In JSON mode we never open a
      // browser — a missing session is reported so the app can drive login.
      const envAuth = osAuthFromEnvironment();
      let authHeaders: OsAuthHeaders | undefined;
      if (!envAuth) {
        try {
          authHeaders = await getOsAuthHeaders(resolved.config, resolved.name);
        } catch (error) {
          if (!shouldAutoLoginForChat(error)) throw error;
          if (input.json) {
            emitNeedsLogin();
            return;
          }
          console.error(
            `No active session for ${resolved.config.osBaseUrl}. Starting browser login...`,
          );
          await loginToResolvedConfig(resolved);
          authHeaders = await getOsAuthHeaders(resolved.config, resolved.name);
        }
      }
      const auth = envAuth ?? osAuthFromHeaders(authHeaders!);

      const projectId = await resolveChatProject({
        auth,
        baseUrl: resolved.config.osBaseUrl,
        configName: resolved.name,
        configPath: CONFIG_PATH,
        configuredDefaultProject: resolved.config.defaultProject,
        explicitProject: input.project,
      });

      if (input.json) {
        await runApprovalJson({
          auth: auth.credentials,
          baseUrl: resolved.config.osBaseUrl,
          projectId,
          headers: headersRecord(auth.requestHeaders),
        });
        return;
      }

      await runApprovalCli({
        auth: auth.credentials,
        baseUrl: resolved.config.osBaseUrl,
        projectId,
        headers: headersRecord(auth.requestHeaders),
        enroll: input.enroll,
        softwareKey: input.softwareKey,
        native: input.native,
        keys: input.keys,
        revoke: input.revoke,
      });
    }),

  orgs: {
    list: os
      .input(z.object({}))
      .meta({ description: "List organizations from the auth worker" })
      .handler(async () => {
        const resolved = resolveConfig(process.cwd(), { throw: true });
        const authClient = await getAuthWorkerClient(resolved.config);
        return await authClient.user.myOrganizations();
      }),
  },

  config: {
    get: os
      .input(z.object({}))
      .meta({ default: true, description: "Show config, resolved target, and session status" })
      .handler(async () => {
        const configFile = readConfigFile();
        const resolved = resolveConfig(process.cwd());

        const configs = configFile.configs || {};
        const sessions = Object.fromEntries(
          Object.entries(configs).map(([name, cfg]) => {
            if (!cfg.session) return [name, null];
            return [
              name,
              {
                hasToken: Boolean(cfg.session?.token),
                hasCookie: Boolean(cfg.session?.cookie),
                expiresAt: cfg.session?.expiresAt,
                expired: cfg.session?.expiresAt
                  ? new Date(cfg.session.expiresAt) < new Date()
                  : false,
              },
            ];
          }),
        );

        if (resolved instanceof Error) {
          return { configPath: CONFIG_PATH, error: resolved.message };
        }

        return {
          configPath: CONFIG_PATH,
          config: resolved.name,
          ...resolved.config,
          session: sessions[resolved.name],
        };
      }),
    list: os
      .input(z.object({}))
      .meta({ description: "List all named configs" })
      .handler(async () => {
        const configFile = readConfigFile();
        const currentName = resolveConfigName(process.cwd());
        const configs = { [DEFAULT_CONFIG_NAME]: {}, ...(configFile.configs || {}) };
        return {
          configs: Object.fromEntries(
            Object.entries(configs).map(([name, cfg]) => [
              name,
              {
                osBaseUrl: Config.parse(cfg).osBaseUrl,
                active: name === currentName ? true : undefined,
              },
            ]),
          ),
          default: configFile.default,
        };
      }),

    set: os
      .input(
        z.object({
          name: z.string().describe("Config name (e.g. dev, prd, preview)"),
          osBaseUrl: z
            .string()
            .optional()
            .describe("Base URL for OS API (e.g. https://os.iterate.com)"),
          authBaseUrl: z
            .string()
            .optional()
            .describe("Base URL for auth API (e.g. https://auth.iterate.com)"),
          setDefault: z.boolean().optional().describe("Set as the default config"),
          setWorkspace: z.boolean().optional().describe("Map current directory to this config"),
        }),
      )
      .meta({ prompt: true, description: "Create or update a named config" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        configFile.configs ||= {};

        configFile.configs[input.name] ||= {} as never;
        if (input.osBaseUrl) configFile.configs[input.name].osBaseUrl = input.osBaseUrl;
        if (input.authBaseUrl) configFile.configs[input.name].authBaseUrl = input.authBaseUrl;

        if (input.setDefault) {
          configFile.default = input.name;
        }
        if (input.setWorkspace) {
          configFile.workspaces ||= {};
          configFile.workspaces[process.cwd()] = input.name;
        }

        writeConfigFile(configFile);
        return {
          configPath: CONFIG_PATH,
          config: configFile.configs[input.name],
        };
      }),

    use: os
      .input(
        z.object({
          name: z.string().meta({ positional: true }).describe("Config name to set as default"),
        }),
      )
      .meta({ description: "Set the default config" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        if (input.name !== DEFAULT_CONFIG_NAME && !configFile.configs?.[input.name]) {
          throw new Error(
            `Config "${input.name}" not found. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
          );
        }
        configFile.default = input.name;
        writeConfigFile(configFile);
        return { default: input.name };
      }),

    current: os
      .input(z.object({}))
      .meta({ description: "Show which config is active and why" })
      .handler(async () => {
        const resolved = resolveConfig(process.cwd(), { throw: true });
        return {
          name: resolved.name,
          config: resolved.config,
          resolvedAuthBaseUrl: resolved.config.authBaseUrl,
          resolvedVia: configFlagOverride ? "--config flag" : "workspace mapping or default",
        };
      }),
  },
};

export const getCli = async () => {
  // Parse custom top-level flags early, before trpc-cli sees the args.
  configFlagOverride = consumeCliStringFlag("--config");
  applyDefaultBareInvocation();
  const requestedRootCommand = firstNonFlagArgument(process.argv.slice(2));
  const shouldLoadRemoteRouters =
    !requestedRootCommand ||
    !Object.prototype.hasOwnProperty.call(launcherProcedures, requestedRootCommand);

  const errorProcedure = (problem: string) => (e: Error) => {
    const message = `${problem}: ${e.message}`;
    return os.meta({ description: message }).handler(() => {
      throw new Error(problem, { cause: e });
    });
  };

  const routers: Record<string, import("@orpc/server").Router<any, any>>[] = [launcherProcedures];

  // Launcher commands are fully local and should not wait on remote discovery before
  // they can run or print command-specific help.
  if (shouldLoadRemoteRouters) {
    const resolved = resolveConfig(process.cwd());
    if (resolved instanceof Error) {
      const procedure = errorProcedure(`Invalid config`)(resolved);
      routers.push({ os: procedure, daemon: procedure });
    } else {
      const { config } = resolved;
      const settledResults = await Promise.allSettled([
        getOsProcedures({ baseUrl: config.osBaseUrl, config, configName: resolved.name }),
      ]);

      const [osProcedures] = settledResults;

      if (osProcedures.status === "fulfilled") {
        routers.push({ os: osProcedures.value });
      } else {
        const message = `Couldn't connect to os at ${config.osBaseUrl}`;
        routers.push({ os: errorProcedure(message)(osProcedures.reason) });
      }
    }
  }

  const router = Object.assign({}, ...routers);

  const cli = createCli({
    router,
    name: "iterate",
    version: "0.0.1",
    description: "Iterate CLI",
  });

  return { cli, prompts: isAgent ? undefined : prompts };
};

export const runCli = async () => {
  const { cli, prompts: cliPrompts } = await getCli();
  await cli.run({ prompts: cliPrompts, logger: yamlTableConsoleLogger });
};

// todo: move this to trpc-cli
export const proxifyOrpc = <R extends AnyRouter>(
  router: R | ReturnType<typeof parseRouter>,
  getClient: (procedurePath: string) => unknown,
) => {
  const parsed = Array.isArray(router) ? router : parseRouter({ router });
  const outputRouterRecord = {};
  for (const [procedurePath, info] of parsed) {
    const parts = procedurePath.split(".");
    let currentRouter: any = outputRouterRecord;
    for (const part of parts.slice(0, -1)) {
      currentRouter = currentRouter[part] ||= {};
    }
    const schemas = info.inputSchemas.success ? info.inputSchemas.value : [];
    const standardSchema: StandardSchemaV1 & { toJsonSchema: () => {} } = {
      "~standard": {
        vendor: "trpc-cli",
        version: 1,
        validate: (value: unknown) => ({ value }),
      },
      toJsonSchema: () => {
        if (schemas.length === 0) return {};
        if (schemas.length === 1) return schemas[0];
        return { allOf: schemas };
      },
    };
    currentRouter[parts[parts.length - 1]] = os
      .input(standardSchema)
      .handler(async ({ input }: any) => {
        const client: any = await getClient(procedurePath);
        return client[procedurePath].query(input);
      });
  }
  return outputRouterRecord;
};
