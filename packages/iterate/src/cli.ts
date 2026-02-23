import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import * as prompts from "@clack/prompts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os } from "@orpc/server";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { createCli, parseRouter, type AnyRouter } from "trpc-cli";
import { z } from "zod/v4";
import type { StandardSchemaV1 } from "trpc-cli/dist/standard-schema/contract.js";

type ParsedRouter = ReturnType<typeof parseRouter>;

const XDG_CONFIG_PARENT = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);

const CONFIG_PATH = join(XDG_CONFIG_PARENT, "config.json");

/** Superadmin impersonation strategy — for CI/automation. Requires admin password env var. */
const SuperadminStrategy = z.object({
  strategy: z.literal("superadmin"),
  adminPasswordEnvVarName: z.string().describe("Env var name containing admin password"),
  userEmail: z.string().describe("User email to impersonate for OS calls"),
});

/** Device flow strategy — interactive login via browser (RFC 8628). */
const DeviceStrategy = z.object({
  strategy: z.literal("device"),
});

const AuthStrategy = z.discriminatedUnion("strategy", [SuperadminStrategy, DeviceStrategy]);

/** Stored session (lives inside a config entry) */
const Session = z.object({
  token: z.string().optional(),
  cookie: z.string().optional(),
  expiresAt: z.string().optional(),
});

/** A named config — describes which server to talk to and how to authenticate. */
const Config = z.object({
  osBaseUrl: z.string(),
  daemonBaseUrl: z.string().optional(),
  auth: AuthStrategy,
  session: Session.optional(),
});

type Config = z.infer<typeof Config>;

/** The config file on disk (~/.config/iterate/config.json) */
const ConfigFile = z.object({
  configs: z.record(z.string(), Config).optional(),
  default: z.string().optional(),
  /** Maps absolute directory path to a config name */
  workspaces: z.record(z.string(), z.string()).optional(),
});

type ConfigFile = z.infer<typeof ConfigFile>;

const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  Boolean(process.env.OPENCODE_SESSION) ||
  Boolean(process.env.CLAUDE_CODE);

const readConfigFile = (): ConfigFile => {
  if (!existsSync(CONFIG_PATH)) return {};
  const rawText = readFileSync(CONFIG_PATH, "utf8");
  try {
    return JSON.parse(rawText) as ConfigFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${detail}`);
  }
};

const writeConfigFile = (configFile: ConfigFile): void => {
  const parsed = ConfigFile.safeParse(configFile);
  if (!parsed.success) {
    throw new Error(`Invalid config file: ${z.prettifyError(parsed.error)}`);
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(parsed.data, null, 2)}\n`);
};

/** Global override set by --config flag before CLI commands run. */
let configFlagOverride: string | undefined;

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

const resolveConfig = (workspacePath: string): { name: string; config: Config } | Error => {
  const configFile = readConfigFile();
  const name = resolveConfigName(workspacePath);
  if (name instanceof Error) return name;
  const config = configFile.configs?.[name];
  if (!config) return new Error(`Config "${name}" not found`);
  const parsed = Config.safeParse(config);
  if (!parsed.success) {
    return new Error(
      `Invalid config "${name}" in ${CONFIG_PATH}:\n${z.prettifyError(parsed.error)}`,
    );
  }
  // Normalize: strip trailing slashes from URLs to avoid double-slash issues
  parsed.data.osBaseUrl = parsed.data.osBaseUrl.replace(/\/+$/, "");
  if (parsed.data.daemonBaseUrl) {
    parsed.data.daemonBaseUrl = parsed.data.daemonBaseUrl.replace(/\/+$/, "");
  }
  return { name, config: parsed.data };
};

const storeSession = (configName: string, session: Config["session"]): void => {
  const configFile = readConfigFile();
  const entry = configFile.configs?.[configName];
  if (!entry) throw new Error(`Config "${configName}" not found`);
  entry.session = session;
  writeConfigFile(configFile);
};

const removeSession = (configName: string): void => {
  const configFile = readConfigFile();
  const entry = configFile.configs?.[configName];
  if (entry) {
    delete entry.session;
    writeConfigFile(configFile);
  }
};

const setCookiesToCookieHeader = (setCookies: string[] | undefined): string => {
  const byName = new Map<string, string>();
  for (const c of setCookies ?? []) {
    const pair = c.split(";")[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    byName.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
};

const impersonationUserIdCache = new Map<string, string>();

const resolveImpersonationUserId = async ({
  superadminAuthClient,
  userEmail,
  baseUrl,
}: {
  superadminAuthClient: any;
  userEmail: string;
  baseUrl: string;
}): Promise<string> => {
  const normalizedEmail = userEmail.trim().toLowerCase();
  const cacheKey = `${baseUrl}::${normalizedEmail}`;
  const cachedUserId = impersonationUserIdCache.get(cacheKey);
  if (cachedUserId) {
    return cachedUserId;
  }

  let users: any[] = [];

  try {
    const result = await superadminAuthClient.admin.listUsers({
      query: {
        filterField: "email",
        filterOperator: "eq",
        filterValue: normalizedEmail,
        limit: 10,
      },
      fetchOptions: {
        throw: true,
      },
    });
    users = Array.isArray(result?.users) ? result.users : [];
  } catch {
    const result = await superadminAuthClient.admin.listUsers({
      query: {
        searchField: "email",
        searchOperator: "contains",
        searchValue: normalizedEmail,
        limit: 100,
      },
      fetchOptions: {
        throw: true,
      },
    });
    users = Array.isArray(result?.users) ? result.users : [];
  }

  const exactMatches = users.filter(
    (user) =>
      user &&
      typeof user === "object" &&
      "email" in user &&
      typeof user.email === "string" &&
      user.email.toLowerCase() === normalizedEmail &&
      "id" in user &&
      typeof user.id === "string",
  );

  if (exactMatches.length === 0) {
    throw new Error(`No user found with email ${userEmail}`);
  }
  if (exactMatches.length > 1) {
    throw new Error(`Multiple users found with email ${userEmail}`);
  }

  const resolvedUserId = exactMatches[0].id as string;
  impersonationUserIdCache.set(cacheKey, resolvedUserId);
  return resolvedUserId;
};

const superadminAuthDance = async (config: Config & { auth: { strategy: "superadmin" } }) => {
  let superadminSetCookie: string[] | undefined;
  const authClient = createAuthClient({
    baseURL: config.osBaseUrl,
    fetchOptions: {
      throw: true,
    },
  });
  const password = process.env[config.auth.adminPasswordEnvVarName];
  if (!password) {
    throw new Error(`Password not found in env var ${config.auth.adminPasswordEnvVarName}`);
  }

  await authClient.signIn.email({
    email: "superadmin@nustom.com",
    password,
    fetchOptions: {
      throw: true,
      onResponse: (ctx: { response: Response }) => {
        superadminSetCookie = ctx.response.headers.getSetCookie();
      },
    },
  });

  const superadminAuthClient = createAuthClient({
    baseURL: config.osBaseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx: { headers: Headers }) => {
        ctx.headers.set("origin", config.osBaseUrl);
        ctx.headers.set("cookie", setCookiesToCookieHeader(superadminSetCookie));
      },
    },
    plugins: [adminClient()],
  });

  const userId = await resolveImpersonationUserId({
    superadminAuthClient,
    userEmail: config.auth.userEmail,
    baseUrl: config.osBaseUrl,
  });

  let impersonateSetCookie: string[] | undefined;
  await superadminAuthClient.admin.impersonateUser({
    userId,
    fetchOptions: {
      throw: true,
      onResponse: (ctx: { response: Response }) => {
        impersonateSetCookie = ctx.response.headers.getSetCookie();
      },
    },
  });

  const userCookies = setCookiesToCookieHeader(impersonateSetCookie);

  const userClient = createAuthClient({
    baseURL: config.osBaseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx: { headers: Headers }) => {
        ctx.headers.set("origin", config.osBaseUrl);
        ctx.headers.set("cookie", userCookies);
      },
    },
  });

  return { userCookies, userClient };
};

/**
 * Get auth headers for OS API calls based on the resolved config's auth strategy.
 * Returns either a cookie header (superadmin) or Authorization: Bearer header (device flow).
 */
const getOsAuthHeaders = async (
  config: Config,
): Promise<{ cookie?: string; authorization?: string }> => {
  if (config.auth.strategy === "superadmin") {
    const { userCookies } = await superadminAuthDance(
      config as Config & { auth: { strategy: "superadmin" } },
    );
    return { cookie: userCookies };
  }
  if (config.auth.strategy === "device") {
    const session = config.session;
    if (!session) {
      throw new Error(`Not logged in to ${config.osBaseUrl}. Run \`iterate login\` first.`);
    }
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      throw new Error(`Session expired for ${config.osBaseUrl}. Run \`iterate login\` again.`);
    }
    if (session.token) {
      return { authorization: `Bearer ${session.token}` };
    }
    if (session.cookie) {
      return { cookie: session.cookie };
    }
    throw new Error(`Stored session for ${config.osBaseUrl} has no token or cookie.`);
  }
  throw new Error(`Unknown auth strategy: ${(config.auth as any).strategy}`);
};

/** Get an authenticated better-auth client for whoami/getSession etc. */
const getAuthenticatedClient = async (config: Config) => {
  const headers = await getOsAuthHeaders(config);
  return createAuthClient({
    baseURL: config.osBaseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx: { headers: Headers }) => {
        ctx.headers.set("origin", config.osBaseUrl);
        if (headers.cookie) ctx.headers.set("cookie", headers.cookie);
        if (headers.authorization) ctx.headers.set("authorization", headers.authorization);
      },
    },
  });
};

// Device flow login (RFC 8628 via better-auth deviceAuthorization plugin)
const DEVICE_CLIENT_ID = "iterate-cli";

const deviceFlowLogin = async (
  config: Config,
): Promise<{ token?: string; cookie?: string; expiresAt?: string }> => {
  // Step 1: Request device code (RFC 8628 — all fields are snake_case)
  const codeRes = await fetch(`${config.osBaseUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.osBaseUrl },
    body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
  });
  if (!codeRes.ok) {
    const text = await codeRes.text();
    throw new Error(`Device code request failed (${codeRes.status}): ${text.slice(0, 200)}`);
  }
  const code = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  // Step 2: Show user code and open browser
  const verifyUrl =
    code.verification_uri_complete ||
    `${config.osBaseUrl}${code.verification_uri}?user_code=${code.user_code}`;
  console.error(`\nOpen this URL in your browser to authenticate:\n`);
  console.error(`  ${verifyUrl}\n`);
  console.error(`Your code: ${code.user_code}\n`);

  // Try to open browser automatically (execFile avoids shell injection from server-controlled URL)
  try {
    const { execFile } = await import("node:child_process");
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFile(cmd, [verifyUrl]);
  } catch {
    // Ignore — user can open manually
  }

  // Step 3: Poll for approval (RFC 8628 §3.5: slow_down permanently increases interval by 5s)
  let pollInterval = (code.interval || 5) * 1000;
  const expiresAt = Date.now() + (code.expires_in || 900) * 1000;
  console.error("Waiting for approval...");

  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const tokenUrl = `${config.osBaseUrl}/api/auth/device/token`;
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.osBaseUrl },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: DEVICE_CLIENT_ID,
      }),
    });

    const tokenBody = (await tokenRes.json()) as Record<string, unknown>;

    // Check for polling errors (400 responses while pending)
    if (!tokenRes.ok) {
      const errorCode = tokenBody.error as string | undefined;
      if (errorCode === "authorization_pending") continue;
      if (errorCode === "slow_down") {
        pollInterval += 5000;
        continue;
      }
      if (errorCode === "expired_token") {
        throw new Error("Device code expired. Please try again.");
      }
      if (errorCode === "access_denied") {
        throw new Error("Authorization denied by user.");
      }
      if (errorCode) {
        throw new Error(`Device auth error: ${errorCode}`);
      }
      throw new Error(`Device token request failed: ${tokenRes.status}`);
    }

    // Success — the JSON body has { access_token, token_type, expires_in, scope }
    // access_token is the raw session token. We use the bearer() plugin server-side
    // to send it as Authorization: Bearer <token>.
    if (tokenBody.access_token) {
      const expiresAtMs = tokenBody.expires_in
        ? Date.now() + (tokenBody.expires_in as number) * 1000
        : undefined;
      return {
        token: tokenBody.access_token as string,
        expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : undefined,
      };
    }

    throw new Error("Unexpected response from device token endpoint");
  }

  throw new Error("Device code expired (timeout). Please try again.");
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

const getOsProcedures = async (params: { baseUrl: string; config: Config }) => {
  const appRouter = await loadRemoteProcedures(params);
  const proxiedRouter = proxifyOrpc(appRouter.procedures, () => {
    const client = createORPCClient(
      new RPCLink({
        url: `${params.baseUrl}/api/orpc/`,
        fetch: async (request: URL | Request, init?: RequestInit) => {
          const authHeaders = await getOsAuthHeaders(params.config);
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

/**
 * Creates a fetch wrapper that calls /api/orpc-stream/* instead of /api/orpc/*.
 * The streaming endpoint returns SSE: log lines as `event: log` and the final
 * oRPC response as `event: response`, which we reassemble into a normal Response.
 */
const streamingFetch = (daemonBaseUrl: string): typeof globalThis.fetch => {
  return async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rewritten = url.replace(
      `${daemonBaseUrl}/api/orpc/`,
      `${daemonBaseUrl}/api/orpc-stream/`,
    );
    if (rewritten === url) return fetch(input, init);
    const fetchInput = input instanceof Request ? new Request(rewritten, input) : rewritten;
    const res = await fetch(fetchInput, init);

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) return res;
    const reader = res.body?.getReader();
    if (!reader) return res;
    const decoder = new TextDecoder();
    let buffer = "";
    let responseBody: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const lines = part.split("\n");
        const event = lines[0].split(": ")[1];
        const data = lines[1].split(": ").slice(1).join(": ");
        if (event === "log") {
          const detail = JSON.parse(data) as {
            level: "debug" | "info" | "warn" | "error";
            args: unknown[];
          };
          console[detail.level](...detail.args);
        } else if (event === "response") {
          responseBody = data;
        }
      }
    }
    return new Response(responseBody, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
};

const getDaemonProcedures = async (params: { daemonBaseUrl: string }) => {
  const daemonRouter = await loadRemoteProcedures({ baseUrl: params.daemonBaseUrl });
  const proxiedRouter = proxifyOrpc(daemonRouter.procedures, async () => {
    const client = createORPCClient(
      new RPCLink({
        url: `${params.daemonBaseUrl}/api/orpc/`,
        fetch: streamingFetch(params.daemonBaseUrl),
      }),
    );
    return orpcToTrpcStyleClient(client);
  });

  return proxiedRouter;
};

const launcherProcedures = {
  doctor: os
    .meta({ description: "Show config, resolved target, and session status" })
    .handler(async () => {
      const configFile = readConfigFile();
      const resolved = resolveConfig(process.cwd());
      const configs = configFile.configs || {};
      return {
        configPath: CONFIG_PATH,
        configFile,
        resolved: resolved instanceof Error ? { error: resolved.message } : resolved,
        sessions: Object.fromEntries(
          Object.entries(configs).map(([name, cfg]) => [
            name,
            {
              hasSession: Boolean(cfg.session?.token || cfg.session?.cookie),
              expiresAt: cfg.session?.expiresAt,
              expired: cfg.session?.expiresAt
                ? new Date(cfg.session.expiresAt) < new Date()
                : false,
            },
          ]),
        ),
      };
    }),

  login: os
    .input(
      z
        .object({
          superadmin: z
            .boolean()
            .optional()
            .describe("Use superadmin impersonation instead of device flow (for CI/automation)"),
        })
        .partial(),
    )
    .meta({
      description: "Authenticate with the OS server via browser-based device flow",
    })
    .handler(async ({ input }) => {
      const resolved = resolveConfig(process.cwd());
      if (resolved instanceof Error) throw resolved;
      const { config } = resolved;

      if (input.superadmin || config.auth.strategy === "superadmin") {
        if (config.auth.strategy !== "superadmin") {
          throw new Error(
            "Config is not using superadmin strategy. Remove --superadmin or change config.",
          );
        }
        const typedConfig = config as Config & {
          auth: { strategy: "superadmin" };
        };
        const { userCookies, userClient } = await superadminAuthDance(typedConfig);
        storeSession(resolved.name, { cookie: userCookies });
        const session = await userClient.getSession();
        return {
          message: "Logged in via superadmin impersonation",
          user: (session as any)?.data?.user ?? (session as any)?.user,
        };
      }

      // Device flow
      console.error(`Logging in to ${config.osBaseUrl}...`);
      const deviceResult = await deviceFlowLogin(config);
      storeSession(resolved.name, deviceResult);
      // Update in-memory config so getAuthenticatedClient sees the token
      config.session = deviceResult;

      // Verify session
      const client = await getAuthenticatedClient(config);
      const session = await client.getSession();
      return {
        message: "Logged in successfully",
        user: (session as any)?.data?.user ?? (session as any)?.user,
        expiresAt: deviceResult.expiresAt,
      };
    }),

  logout: os
    .meta({ description: "Remove stored session for the current config" })
    .handler(async () => {
      const resolved = resolveConfig(process.cwd());
      if (resolved instanceof Error) throw resolved;
      removeSession(resolved.name);
      return { message: `Logged out from ${resolved.name} (${resolved.config.osBaseUrl})` };
    }),

  whoami: os.meta({ description: "Show current authenticated user" }).handler(async () => {
    const resolved = resolveConfig(process.cwd());
    if (resolved instanceof Error) throw resolved;
    const client = await getAuthenticatedClient(resolved.config);
    return await client.getSession();
  }),

  config: {
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
              daemonBaseUrl: cfg.daemonBaseUrl,
              strategy: cfg.auth.strategy,
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
          name: z.string().describe("Config name (e.g. dev, prd, staging)"),
          osBaseUrl: z.string().describe("Base URL for OS API (e.g. https://os.iterate.com)"),
          daemonBaseUrl: z
            .string()
            .optional()
            .describe("Base URL for daemon API (e.g. http://localhost:3001)"),
          strategy: z.enum(["device", "superadmin"]).default("device").describe("Auth strategy"),
          adminPasswordEnvVarName: z
            .string()
            .optional()
            .describe("Env var name for admin password (superadmin strategy only)"),
          userEmail: z
            .string()
            .optional()
            .describe("User email to impersonate (superadmin strategy only)"),
          setDefault: z.boolean().optional().describe("Set as the default config"),
          setWorkspace: z.boolean().optional().describe("Map current directory to this config"),
        }),
      )
      .meta({ prompt: true, description: "Create or update a named config" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        configFile.configs ||= {};

        const auth: z.infer<typeof AuthStrategy> =
          input.strategy === "superadmin"
            ? {
                strategy: "superadmin" as const,
                adminPasswordEnvVarName: input.adminPasswordEnvVarName || "",
                userEmail: input.userEmail || "",
              }
            : { strategy: "device" as const };

        configFile.configs[input.name] = {
          osBaseUrl: input.osBaseUrl,
          daemonBaseUrl: input.daemonBaseUrl,
          auth,
        };

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
      const resolved = resolveConfig(process.cwd());
      if (resolved instanceof Error) throw resolved;
      return {
        name: resolved.name,
        config: resolved.config,
        resolvedVia: configFlagOverride ? "--config flag" : "workspace mapping or default",
      };
    }),
  },
};

export const getCli = async () => {
  // Parse --config flag early, before trpc-cli sees the args
  const args = process.argv.slice(2);
  const configFlagIndex = args.indexOf("--config");
  if (configFlagIndex !== -1 && args[configFlagIndex + 1]) {
    configFlagOverride = args[configFlagIndex + 1];
    // Remove --config <name> from argv so trpc-cli doesn't choke on it
    process.argv.splice(configFlagIndex + 2, 2);
  }

  const resolved = resolveConfig(process.cwd());

  const errorProcedure = (problem: string) => (e: Error) => {
    const message = `${problem}: ${e.message}`;
    return os.meta({ description: message }).handler(() => {
      throw new Error(problem, { cause: e });
    });
  };

  const routers: Record<string, import("@orpc/server").Router<any, any>>[] = [launcherProcedures];

  if (resolved instanceof Error) {
    const procedure = errorProcedure(`Invalid config`)(resolved);
    routers.push({ os: procedure, daemon: procedure });
  } else {
    const { config } = resolved;
    const settledResults = await Promise.allSettled([
      getOsProcedures({ baseUrl: config.osBaseUrl, config }),
      config.daemonBaseUrl
        ? getDaemonProcedures({ daemonBaseUrl: config.daemonBaseUrl })
        : Promise.reject(new Error("No daemonBaseUrl configured")),
    ]);

    const [osProcedures, daemonProcedures] = settledResults;

    if (osProcedures.status === "fulfilled") {
      routers.push({ os: osProcedures.value });
    } else {
      const message = `Couldn't connect to os at ${config.osBaseUrl}`;
      routers.push({ os: errorProcedure(message)(osProcedures.reason) });
    }
    if (daemonProcedures.status === "fulfilled") {
      // don't nest daemon procedures under "daemon"
      routers.push(daemonProcedures.value);
    } else {
      const message = config.daemonBaseUrl
        ? `Couldn't connect to daemon at ${config.daemonBaseUrl}`
        : `No daemonBaseUrl configured`;
      routers.push({
        daemon: errorProcedure(message)(daemonProcedures.reason),
      });
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
  await cli.run({ prompts: cliPrompts });
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
