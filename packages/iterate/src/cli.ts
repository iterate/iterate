import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import * as prompts from "@clack/prompts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os } from "@orpc/server";
import { createCli, parseRouter, type AnyRouter, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod/v4";
import type { StandardSchemaV1 } from "trpc-cli/dist/standard-schema/contract.js";
import type { AuthContractClient } from "../../../apps/auth-contract/src/index.ts";
import {
  CONFIG_PATH,
  Config,
  readConfig,
  readConfigFile,
  removeConfigSession,
  updateConfigSession,
  writeConfigFile,
  type StoredSession,
} from "./config.ts";

type ParsedRouter = ReturnType<typeof parseRouter>;

const OAUTH_REFRESH_SKEW_MS = 60_000;

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
 * Usage examples:
 * - `iterate --local-router ./scripts/preview/router.ts local-router preview sync`
 * - `iterate --config dev doctor`
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

/**
 * Temporary compatibility for root-owned preview commands.
 * App CLIs should use packages/shared/src/apps/cli.ts instead of iterate --local-router,
 * but preview still depends on this mounted-router flow for now.
 */
const loadLocalRouter = async (routerPath: string) => {
  const fullPath = resolve(process.cwd(), routerPath);
  const importedModule = (await import(pathToFileURL(fullPath).href)) as {
    router?: import("@orpc/server").Router<any, any>;
  };
  const router = importedModule.router;
  if (router == null) {
    throw new Error(
      `Local router module ${JSON.stringify(routerPath)} must export a named "router" value.`,
    );
  }
  if (typeof router !== "object") {
    throw new Error(
      `Local router module ${JSON.stringify(routerPath)} exported a router mount, but it is not an object.`,
    );
  }
  return router;
};

const resolveStreamTuiEntrypointPath = () => {
  const moduleDir = import.meta.dirname;
  const candidates = [
    join(moduleDir, "stream-tui/event-stream-terminal.tsx"),
    join(moduleDir, "stream-tui/event-stream-terminal.mjs"),
    join(moduleDir, "stream-tui/event-stream-terminal.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Could not find the Iterate stream TUI entrypoint.");
};

export const buildChatCommand = (input: {
  osBaseUrl: string;
  projectSlugOrId: string;
  streamPath: string;
  entrypointPath: string;
}) => ({
  command: "bun",
  args: [
    input.entrypointPath,
    "--base-url",
    input.osBaseUrl,
    "--project-slug-or-id",
    input.projectSlugOrId,
    "--stream-path",
    input.streamPath,
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

/**
 * Resolve which config name to use.
 * Priority: --config flag > workspace match (walk up from cwd) > default > single-config auto > error
 */
const resolveConfigName = (workspacePath: string): string | Error => {
  const configFile = readConfigFile();

  if (configFlagOverride) {
    if (!configFile.configs?.[configFlagOverride]) {
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
      if (!configFile.configs?.[match]) {
        return new Error(`Workspace "${dir}" maps to config "${match}" which doesn't exist.`);
      }
      return match;
    }
    dir = dirname(dir);
  }

  if (configFile.default) {
    if (!configFile.configs?.[configFile.default]) {
      return new Error(
        `Default config "${configFile.default}" doesn't exist. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
      );
    }
    return configFile.default;
  }

  // If there's exactly one config, use it
  const configNames = Object.keys(configFile.configs || {});
  if (configNames.length === 1) return configNames[0];

  return new Error(
    `No config resolved for ${workspacePath}. Run \`iterate config set <name>\` or set a default with \`iterate config use <name>\`.\n` +
      `  Config file: ${CONFIG_PATH}`,
  );
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

/**
 * Get auth headers for OS API calls based on the resolved config's stored session.
 * OAuth sessions are refreshed when possible.
 */
const getOsAuthHeaders = async (
  config: Config,
  configName?: string,
): Promise<{ cookie?: string; authorization?: string }> => {
  let session = config.session;
  if (!session) {
    throw new Error(`Not logged in to ${config.osBaseUrl}. Run \`iterate login\` first.`);
  }
  if (sessionNeedsRefresh(session)) {
    if (session.refreshToken && session.clientId) {
      session = await refreshOAuthSession({ config, configName, session });
    } else {
      throw new Error(`Session expired for ${config.osBaseUrl}. Run \`iterate login\` again.`);
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

const pkceChallenge = (verifier: string) =>
  base64Url(createHash("sha256").update(verifier).digest());

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
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`,
    wait: () => callbackPromise.finally(() => clearTimeout(timeout)),
    close,
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

const refreshOAuthSession = async (input: {
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
    resource: input.config.osBaseUrl,
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
  const codeVerifier = randomBase64Url(48);
  const state = randomBase64Url(32);
  const callback = await startOAuthCallbackServer();
  const clientId = await registerOAuthClient({ authBaseUrl, redirectUri: callback.redirectUri });

  const authorizeUrl = new URL(`${authBaseUrl}/api/auth/oauth2/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", callback.redirectUri);
  authorizeUrl.searchParams.set("scope", OAUTH_SCOPE);
  authorizeUrl.searchParams.set("resource", config.osBaseUrl);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  console.error(`\nOpening browser to authenticate with Iterate:\n`);
  console.error(`  ${authorizeUrl.href}\n`);
  await openUrlInBrowser(authorizeUrl.href);

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
    resource: config.osBaseUrl,
  });
  const session = oauthTokenToSession(token, { clientId, refreshToken: undefined });
  session.clientId = clientId;
  return session;
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
  ping: os.handler(async () => {
    const resolved = resolveConfig(process.cwd(), { throw: true });
    const { config } = resolved;
    const osClient = createORPCClient(
      new RPCLink({
        url: `${config.osBaseUrl}/api/orpc/`,
        fetch: async (request: URL | Request, init?: RequestInit) => {
          const authHeaders = await getOsAuthHeaders(config, resolved.name);
          const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
          if (authHeaders.authorization) headers.set("authorization", authHeaders.authorization);
          if (authHeaders.cookie) headers.set("cookie", authHeaders.cookie);
          return fetch(request, { ...init, headers });
        },
      }),
    );
    return (osClient as any).ping().catch((e: Error) => {
      throw new Error(`Failed to ping OS: ${e}`);
    });
  }),
  login: os
    .input(z.object({}))
    .meta({
      description: "Authenticate with the OS server via browser-based OAuth",
    })
    .handler(async () => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      const { config } = resolved;

      console.error(`Logging in to ${config.authBaseUrl}...`);
      const oauthResult = await oauthLogin(config);
      updateConfigSession(resolved.name, oauthResult);
      // Update in-memory config so subsequent verification and calls see the token.
      config.session = oauthResult;

      const osClient = createORPCClient(
        new RPCLink({
          url: `${config.osBaseUrl}/api/orpc/`,
          fetch: async (request: URL | Request, init?: RequestInit) => {
            const authHeaders = await getOsAuthHeaders(config, resolved.name);
            const headers = new Headers(
              request instanceof Request ? request.headers : init?.headers,
            );
            if (authHeaders.authorization) headers.set("authorization", authHeaders.authorization);
            if (authHeaders.cookie) headers.set("cookie", authHeaders.cookie);
            return fetch(request, { ...init, headers });
          },
        }),
      );
      await (osClient as any).ping().catch((e: Error) => {
        throw new Error(`Failed to ping OS: ${e}`);
      });
      return {
        message: "Logged in successfully",
        expiresAt: oauthResult.expiresAt,
        scope: oauthResult.scope,
      };
    }),

  logout: os
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
          .describe("OS project slug or ID. Defaults to the active config's defaultProject."),
        streamPath: z
          .string()
          .trim()
          .min(1)
          .startsWith("/")
          .describe("Project stream path to open"),
      }),
    )
    .meta({
      description: "Open the Iterate chat terminal UI",
    })
    .handler(async ({ input }) => {
      // Resolved here, not in the input schema: the schema is built at module
      // load, before `--config` has been consumed.
      const resolved = resolveConfig(process.cwd(), { throw: true });
      const project = input.project || resolved.config.defaultProject;
      if (!project) {
        throw new Error(
          `No project specified. Pass --project or set "defaultProject" on config "${resolved.name}" in ${CONFIG_PATH}.`,
        );
      }
      const command = buildChatCommand({
        osBaseUrl: resolved.config.osBaseUrl,
        projectSlugOrId: project,
        streamPath: input.streamPath,
        entrypointPath: resolveStreamTuiEntrypointPath(),
      });
      // Auth is the TUI's job: it reads admin/bearer secrets from the inherited
      // environment when present (doppler, e2e), and otherwise loads the named
      // config's stored session from the shared config file.
      await runInheritedProcess({
        ...command,
        env: { ITERATE_CONFIG_NAME: resolved.name },
      });
    }),

  orgs: {
    list: os.meta({ description: "List organizations from the auth worker" }).handler(async () => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      const authClient = await getAuthWorkerClient(resolved.config);
      return await authClient.user.myOrganizations();
    }),
  },

  config: {
    get: os
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
    list: os.meta({ description: "List all named configs" }).handler(async () => {
      const configFile = readConfigFile();
      const currentName = resolveConfigName(process.cwd());
      const configs = configFile.configs || {};
      return {
        configs: Object.fromEntries(
          Object.entries(configs).map(([name, cfg]) => [
            name,
            {
              osBaseUrl: cfg.osBaseUrl,
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
        if (!configFile.configs?.[input.name]) {
          throw new Error(
            `Config "${input.name}" not found. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
          );
        }
        configFile.default = input.name;
        writeConfigFile(configFile);
        return { default: input.name };
      }),

    current: os.meta({ description: "Show which config is active and why" }).handler(async () => {
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
  const localRouterPath = consumeCliStringFlag("--local-router");
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

  if (localRouterPath) {
    const localRouter = await loadLocalRouter(localRouterPath);
    routers.push({ "local-router": localRouter });
  }

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
