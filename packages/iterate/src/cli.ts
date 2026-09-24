import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import process from "node:process";
import repl from "node:repl";
import { RpcTarget } from "capnweb";
import * as prompts from "@clack/prompts";
import { os } from "@orpc/server";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod/v4";
import { connectOsNext } from "./next-node.ts";
import type { SessionCredentials } from "./next/api.ts";
import { launchMenubarApp } from "./menubar-app.ts";
import { shareMyComputer } from "./use-my-computer.ts";
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

// Claude Code sets `CLAUDECODE=1`, not a bare `CLAUDE_CODE`; keep both spellings (as
// lint-staged.config.cjs does).
const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  Boolean(process.env.OPENCODE_SESSION) ||
  Boolean(process.env.CLAUDE_CODE) ||
  Boolean(process.env.CLAUDECODE);
let configFlagOverride: string | undefined;
const consumeCliStringFlag = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1) return undefined;
  const value = args[flagIndex + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flagName} requires a value`);
  process.argv.splice(flagIndex + 2, 2);
  return value;
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

/**
 * Resolve the config's OAuth credentials before connecting.
 * OAuth sessions are refreshed when possible.
 */
const storedCredentials = async (
  config: Config,
  configName?: string,
): Promise<SessionCredentials> => {
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
    return { type: "bearer", token: session.token };
  }
  throw new Error(`No bearer token for ${config.osBaseUrl}. Run \`iterate login\` again.`);
};

const sessionNeedsRefresh = (session: StoredSession) => {
  if (!session.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
};

const credentialsForConfig = async (config: Config, name: string): Promise<SessionCredentials> => {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (secret) return { type: "admin-secret", secret };
  const token = process.env.ITERATE_BEARER_TOKEN?.trim();
  if (token) return { type: "bearer", token };
  return await storedCredentials(config, name);
};
const connectConfigured = async () => {
  const resolved = resolveConfig(process.cwd(), { throw: true });
  const connection = await connectOsNext({
    baseUrl: resolved.config.osBaseUrl,
    auth: await credentialsForConfig(resolved.config, resolved.name),
  });
  return { resolved, connection };
};
const selectProject = async (
  connection: Awaited<ReturnType<typeof connectOsNext>>,
  configured?: string,
) => {
  if (configured) return configured;
  const projects = await connection.session.projects.list();
  if (projects.length === 1) return projects[0].id;
  throw new Error(
    `Pass --project or set defaultProject in ${CONFIG_PATH}. Accessible projects: ${projects.map((p) => `${p.slug} (${p.id})`).join(", ") || "none"}.`,
  );
};
const OAUTH_SCOPE = "iterate";
const LOOPBACK_HOST = "localhost";
const LOOPBACK_CALLBACK_PATH = "/callback";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const OAuthTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
  expires_at: z.number().positive().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});
type OAuthTokenResponse = z.infer<typeof OAuthTokenResponse>;

const base64Url = (buffer: Buffer) => buffer.toString("base64url");

const randomBase64Url = (byteLength = 32) => base64Url(randomBytes(byteLength));

export const oauthResourceForOsBaseUrl = (osBaseUrl: string) => {
  return new URL("/api", osBaseUrl).href;
};

const openUrlInBrowser = async (url: string) => {
  const { execFile } = await import("node:child_process");
  const { command, args } =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  execFile(command, args, (error) => {
    if (error)
      console.error(`Could not open a browser: ${error.message}. Open the URL above manually.`);
  });
};

const readErrorBody = async (response: Response) => {
  const text = await response.text();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
};

const registerOAuthClient = async (input: { authBaseUrl: string; redirectUri: string }) => {
  const response = await fetch(`${input.authBaseUrl}/oauth2/register`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", origin: input.authBaseUrl },
    body: JSON.stringify({
      client_name: "iterate CLI",
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

  const client = z.object({ client_id: z.string().min(1) }).parse(await response.json());
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

  void callbackPromise.catch(() => {});

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (settled) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth callback already received.");
      return;
    }

    const url = new URL(request.url || "/", `http://${LOOPBACK_HOST}`);
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
    close: () => {
      clearTimeout(timeout);
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
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

  const response = await fetch(`${input.authBaseUrl}/oauth2/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
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

  const token = OAuthTokenResponse.parse(await response.json());
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
    refreshToken: token.refresh_token || existing?.refreshToken,
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

  const authBaseUrl = input.config.osBaseUrl;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.session.clientId,
    refresh_token: input.session.refreshToken,
    resource: oauthResourceForOsBaseUrl(input.config.osBaseUrl),
  });
  if (input.session.scope) body.set("scope", input.session.scope);

  const response = await fetch(`${authBaseUrl}/oauth2/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: authBaseUrl,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth refresh failed (${response.status}). Run \`iterate login\` again.`);
  }

  const token = OAuthTokenResponse.parse(await response.json());
  const refreshedSession = oauthTokenToSession(token, input.session);
  refreshedSession.clientId = input.session.clientId;
  input.config.session = refreshedSession;
  if (input.configName) updateConfigSession(input.configName, refreshedSession);
  return refreshedSession;
};

const oauthLogin = async (config: Config): Promise<StoredSession> => {
  const authBaseUrl = config.osBaseUrl;
  const resource = oauthResourceForOsBaseUrl(config.osBaseUrl);
  const codeVerifier = randomBase64Url(48);
  const state = randomBase64Url(32);
  const callback = await startOAuthCallbackServer();
  try {
    const clientId = await registerOAuthClient({ authBaseUrl, redirectUri: callback.redirectUri });

    const authorizeUrl = new URL(`${authBaseUrl}/oauth2/auth`);
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

    const callbackResult = await callback.wait();

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
  } finally {
    await callback.close();
  }
};

const loginToResolvedConfig = async (resolved: { name: string; config: Config }) => {
  const { config } = resolved;

  console.error(`Logging in to ${config.osBaseUrl}...`);
  const oauthResult = await oauthLogin(config);

  // Update in-memory config so subsequent verification and calls see the token.
  config.session = oauthResult;

  using connection = await connectOsNext({
    baseUrl: config.osBaseUrl,
    auth: { type: "bearer", token: oauthResult.token },
  });
  await connection.session.whoami();

  updateConfigSession(resolved.name, oauthResult);
  return oauthResult;
};

const launcherProcedures = {
  ping: os.input(z.object({})).handler(async () => {
    const { connection } = await connectConfigured();
    using owned = connection;
    return { message: "OS Next session valid", principal: await owned.session.whoami() };
  }),
  login: os
    .input(z.object({}))
    .meta({ description: "Authenticate with OS Next via browser OAuth" })
    .handler(async () => {
      const session = await loginToResolvedConfig(resolveConfig(process.cwd(), { throw: true }));
      return {
        message: "Logged in successfully",
        expiresAt: session.expiresAt,
        scope: session.scope,
      };
    }),
  logout: os
    .input(z.object({}))
    .meta({ description: "Remove the current config's stored session" })
    .handler(async () => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      removeConfigSession(resolved.name);
      return { message: `Logged out from ${resolved.name}` };
    }),
  orgs: {
    list: os.input(z.object({})).handler(async () => {
      const { connection } = await connectConfigured();
      using owned = connection;
      return await owned.session.organizations.list();
    }),
  },
  projects: {
    list: os.input(z.object({})).handler(async () => {
      const { connection } = await connectConfigured();
      using owned = connection;
      return await owned.session.projects.list();
    }),
  },
  repl: os
    .input(
      z.object({
        project: z.string().optional().describe("Project id or slug"),
        context: z.string().default("/").describe("Context path within the project"),
      }),
    )
    .meta({ description: "Open a local Node REPL with itx and RpcTarget in scope" })
    .handler(async ({ input }) => {
      const { resolved, connection } = await connectConfigured();
      using owned = connection;
      const project = input.project || resolved.config.defaultProject;
      if (!project && input.context !== "/")
        throw new Error("--context requires --project or a configured defaultProject.");
      using root = project ? await owned.session.projects.get(project) : null;
      using context = root ? await root.cd(input.context) : null;
      console.error(
        `Connected to ${resolved.config.osBaseUrl}, ${project ? `project ${project}, context ${input.context}` : "session"}. Use .exit to quit.`,
      );
      // capnweb identifies built-ins by prototype. Evaluate in this process's
      // realm so objects and argument arrays use the transport's constructors.
      const server = repl.start({ prompt: "itx> ", useGlobal: true });
      const initialize = () => {
        server.context.itx = context || owned.session;
        server.context.RpcTarget = RpcTarget;
      };
      initialize();
      server.on("reset", initialize);
      try {
        const outcome = await Promise.race([
          new Promise<"exit">((resolve) => server.once("exit", () => resolve("exit"))),
          owned.closed,
        ]);
        if (outcome !== "exit") {
          throw new Error(
            `REPL disconnected (${outcome.code}: ${outcome.reason || "connection closed"}). Start a new REPL to reconnect.`,
          );
        }
      } finally {
        server.close();
      }
    }),
  itx: {
    run: os
      .input(
        z
          .object({
            project: z
              .string()
              .optional()
              .describe("Project id or slug; defaults to config.defaultProject"),
            context: z.string().default("/").describe("Context path within the project"),
            eval: z
              .string()
              .optional()
              .describe("Script body with itx in scope; use return for the result"),
            file: z
              .string()
              .optional()
              .describe("Read the script from a UTF-8 file; - reads stdin"),
          })
          .refine(
            (input) => Boolean(input.eval) !== Boolean(input.file),
            "Specify exactly one of --eval or --file",
          ),
      )
      .meta({ description: "Run an itx script once on OS Next" })
      .handler(async ({ input }) => {
        let script = input.eval;
        if (input.file === "-") {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          script = Buffer.concat(chunks).toString("utf8");
        } else if (input.file) script = await readFile(input.file, "utf8");
        const { resolved, connection } = await connectConfigured();
        using owned = connection;
        const project = await selectProject(owned, input.project || resolved.config.defaultProject);
        using root = await owned.session.projects.get(project);
        using context = await root.cd(input.context);
        return await context.run(`async (itx) => {\n${script}\n}`);
      }),
  },
  menubar: os
    .input(z.object({ project: z.string().optional().describe("Project id or slug") }))
    .meta({ description: "Launch the macOS menu bar for sign-in and computer sharing" })
    .handler(async ({ input }) => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      const project = input.project || resolved.config.defaultProject;
      if (!project) throw new Error("menubar needs --project or a configured defaultProject.");
      await launchMenubarApp({ configName: resolved.name, project, log: console.error });
    }),
  useMyComputer: os
    .input(
      z.object({
        project: z.string().optional().describe("Project id or slug"),
        json: z.boolean().optional().describe("Emit menu-bar events as NDJSON; stop on stdin EOF"),
        name: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
          .optional()
          .describe("Computer capability name, e.g. jonasComputer"),
      }),
    )
    .meta({ description: "Share this Mac with a project until Ctrl-C" })
    .handler(async ({ input }) => {
      if (process.platform !== "darwin")
        throw new Error("use-my-computer requires macOS (AppleScript and Swift).");
      const { resolved, connection } = await connectConfigured();
      using owned = connection;
      const project = await selectProject(owned, input.project || resolved.config.defaultProject);
      await shareMyComputer({ connection: owned, project, name: input.name, json: input.json });
    }),
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
          defaultProject: z.string().optional().describe("Default project id or slug"),
          setDefault: z.boolean().optional().describe("Set as the default config"),
          setWorkspace: z.boolean().optional().describe("Map current directory to this config"),
        }),
      )
      .meta({ description: "Create or update a named config" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        configFile.configs ||= {};

        configFile.configs[input.name] ||= Config.parse({});
        if (input.osBaseUrl && input.osBaseUrl !== configFile.configs[input.name].osBaseUrl) {
          configFile.configs[input.name].osBaseUrl = input.osBaseUrl;
          delete configFile.configs[input.name].session;
        }
        if (input.defaultProject)
          configFile.configs[input.name].defaultProject = input.defaultProject;

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
          config: { ...configFile.configs[input.name], session: undefined },
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
          config: {
            ...resolved.config,
            session: resolved.config.session ? { loggedIn: true } : undefined,
          },
          resolvedVia: configFlagOverride ? "--config flag" : "workspace mapping or default",
        };
      }),
  },
};
export const getCli = async () => {
  configFlagOverride = consumeCliStringFlag("--config");
  if (process.argv.length === 2) process.argv.push("--help");
  const cli = createCli({
    router: launcherProcedures,
    name: "iterate",
    description: "Iterate CLI for OS Next. Run itx scripts, authenticate, and share your computer.",
  });
  return {
    cli,
    prompts: isAgent || !process.stdin.isTTY || !process.stdout.isTTY ? undefined : prompts,
  };
};
export const runCli = async () => {
  const { cli, prompts: cliPrompts } = await getCli();
  await cli.run({ prompts: cliPrompts, logger: yamlTableConsoleLogger });
};
