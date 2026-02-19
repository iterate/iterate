#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// --- Local delegation (must run before any heavy imports) ---

/**
 * Walk up from `startDir` looking for `relativePath` to exist.
 * Returns the directory where it was found, or null.
 * @param {string} relativePath
 * @param {string} [startDir]
 * @returns {string | null}
 */
const findUp = (relativePath, startDir = process.cwd()) => {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, relativePath))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const __filename = fileURLToPath(import.meta.url);

/**
 * If we're already running from a local version, skip delegation to avoid loops.
 * Otherwise, find the closest local iterate CLI and re-exec into it.
 */
const delegateToLocal = () => {
  if (process.env.__ITERATE_CLI_DELEGATED) return;

  const selfReal = realpathSync(__filename);

  // 1. Check if we're inside the iterate repo (has pnpm-workspace.yaml at root)
  const repoRoot = findUp("pnpm-workspace.yaml");
  if (repoRoot) {
    const repoScript = join(repoRoot, "packages/iterate/bin/iterate.js");
    if (existsSync(repoScript) && realpathSync(repoScript) !== selfReal) {
      reExec(repoScript);
      return;
    }
  }

  // 2. Check for a local node_modules install
  const nmRoot = findUp("node_modules/.bin/iterate");
  if (nmRoot) {
    const nmScript = join(nmRoot, "node_modules/.bin/iterate");
    if (existsSync(nmScript) && realpathSync(nmScript) !== selfReal) {
      reExec(nmScript);
      return;
    }
  }
};

/**
 * Re-exec into `scriptPath` with the same argv, never returning.
 * @param {string} scriptPath
 */
const reExec = (scriptPath) => {
  try {
    execFileSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, __ITERATE_CLI_DELEGATED: "1" },
    });
  } catch (e) {
    process.exit(e && typeof e === "object" && "status" in e ? Number(e.status) || 1 : 1);
  }
  process.exit(0);
};

delegateToLocal();

// --- Normal CLI startup (dynamic imports so delegation can short-circuit first) ---

const prompts = await import("@clack/prompts");
const { createTRPCClient, httpLink } = await import("@trpc/client");
const { initTRPC } = await import("@trpc/server");
const { createAuthClient } = await import("better-auth/client");
const { adminClient } = await import("better-auth/client/plugins");
const { default: superjson } = await import("superjson");
const { createCli } = await import("trpc-cli");
const { proxify } = await import("trpc-cli/dist/proxify.js");
const { z } = await import("zod/v4");

const XDG_CONFIG_PARENT = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);

const XDG_CONFIG_PATH = join(XDG_CONFIG_PARENT, "config.json");
const CONFIG_PATH = XDG_CONFIG_PATH;
// todo write json schema to file too - need to make everything zod first
// const CONFIG_SCHEMA_PATH = join(XDG_CONFIG_PARENT, "config-schema.json");

const SetupInput = z.object({
  osBaseUrl: z
    .string()
    .describe(`Base URL for OS API (for example https://dev-yourname-os.dev.iterate.com)`),
  daemonBaseUrl: z.string().describe(`Base URL for daemon API (for example http://localhost:3001)`),
  adminPasswordEnvVarName: z.string().describe("Env var name containing admin password"),
  userEmail: z.string().describe("User email to impersonate for OS calls"),
  scope: z.enum(["workspace", "global"]).describe("Where to store launcher config"),
});

const AuthConfig = z.object({
  osBaseUrl: z.string(),
  daemonBaseUrl: z.string(),
  adminPasswordEnvVarName: z.string(),
  userEmail: z.string(),
});

const ConfigFile = z.object({
  global: AuthConfig.partial().optional(),
  workspaces: z.record(z.string(), AuthConfig).optional(),
  /** a place where I put old/invalid configs I can't quite let go of */
  rubbish: z.unknown().optional(),
});

/** @typedef {import('zod').infer<typeof AuthConfig>} AuthConfig */
/** @typedef {import('zod').infer<typeof ConfigFile>} ConfigFile */

/**
 * @typedef {{
 *   command: string;
 *   args: string[];
 *   cwd?: string;
 *   env?: Record<string, string | undefined>;
 * }} SpawnOptions
 */

const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  Boolean(process.env.OPENCODE_SESSION) ||
  Boolean(process.env.CLAUDE_CODE);

const t = initTRPC.meta().create();

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
};

/** @returns {ConfigFile} */
const readConfigFile = () => {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  const rawText = readFileSync(CONFIG_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${detail}`);
  }

  return parsed;
};

/**
 * @param {ConfigFile} configFile
 * @param {string} workspacePath
 */
const getMergedWorkspaceConfig = (configFile, workspacePath) => {
  const configs = [];
  while (workspacePath && workspacePath !== "/") {
    if (workspacePath in (configFile.workspaces || {})) {
      configs.push(configFile.workspaces?.[workspacePath]);
    }
    workspacePath = dirname(workspacePath);
  }
  configs.push(configFile.global);
  /** @type {AuthConfig} */
  return configs.reverse().reduce((acc, config) => {
    return { ...acc, ...config };
  }, {});
};

/**
 * @param {{ patch?: Partial<AuthConfig>; scope: "workspace" | "global"; workspacePath: string; }} options
 * @returns {ConfigFile}
 */
const writeNewConfig = ({ patch, scope, workspacePath }) => {
  patch = Object.fromEntries(
    Object.entries(patch || {}).filter(([_key, value]) => value !== undefined),
  );
  const configFile = readConfigFile();
  const cloned = structuredClone(configFile);

  if (scope === "global") {
    cloned.global = { ...configFile.global, ...patch };
  }
  if (scope === "workspace" && workspacePath) {
    cloned.workspaces ||= {};
    // @ts-expect-error - we know it's a string
    cloned.workspaces[workspacePath] = {
      ...configFile.workspaces?.[workspacePath],
      ...patch,
    };
  }

  const parsed = ConfigFile.safeParse(cloned);
  if (!parsed.success) {
    throw new Error(`Invalid config file: ${z.prettifyError(parsed.error)}`);
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return cloned;
};

/** @param {string} workspacePath */
const readAuthConfig = (workspacePath) => {
  const configFile = readConfigFile();
  const mergedConfig = getMergedWorkspaceConfig(configFile, workspacePath);
  const parsed = AuthConfig.safeParse(mergedConfig);
  if (!parsed.success) {
    return new Error(
      `Invalid auth config for ${workspacePath} (in config file ${CONFIG_PATH}). Have you run \`iterate setup\`?\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
};

/** @param {string[] | undefined} setCookies */
const setCookiesToCookieHeader = (setCookies) => {
  const byName = new Map();
  for (const c of setCookies ?? []) {
    const pair = c.split(";")[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    byName.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
};

const impersonationUserIdCache = new Map();

/**
 * @param {{
 *   superadminAuthClient: any;
 *   userEmail: string;
 *   baseUrl: string;
 * }} options
 */
const resolveImpersonationUserId = async ({ superadminAuthClient, userEmail, baseUrl }) => {
  const normalizedEmail = userEmail.trim().toLowerCase();
  const cacheKey = `${baseUrl}::${normalizedEmail}`;
  const cachedUserId = impersonationUserIdCache.get(cacheKey);
  if (cachedUserId) {
    return cachedUserId;
  }

  /** @type {any[]} */
  let users = [];

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

  const resolvedUserId = exactMatches[0].id;
  impersonationUserIdCache.set(cacheKey, resolvedUserId);
  return resolvedUserId;
};

/** @param {import('zod').infer<typeof AuthConfig>} authConfig */
const osAuthDance = async (authConfig) => {
  /** @type {string[] | undefined} */
  let superadminSetCookie;
  const authClient = createAuthClient({
    baseURL: authConfig.osBaseUrl,
    fetchOptions: {
      throw: true,
    },
  });
  const password = process.env[authConfig.adminPasswordEnvVarName];
  if (!password) {
    throw new Error(`Password not found in env var ${authConfig.adminPasswordEnvVarName}`);
  }

  await authClient.signIn.email({
    email: "superadmin@nustom.com",
    password,
    fetchOptions: {
      throw: true,
      onResponse: (ctx) => {
        superadminSetCookie = ctx.response.headers.getSetCookie();
      },
    },
  });

  const superadminAuthClient = createAuthClient({
    baseURL: authConfig.osBaseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx) => {
        ctx.headers.set("origin", authConfig.osBaseUrl);
        ctx.headers.set("cookie", setCookiesToCookieHeader(superadminSetCookie));
      },
    },
    plugins: [adminClient()],
  });

  const userId = await resolveImpersonationUserId({
    superadminAuthClient,
    userEmail: authConfig.userEmail,
    baseUrl: authConfig.osBaseUrl,
  });

  let impersonateSetCookie;
  await superadminAuthClient.admin.impersonateUser({
    userId,
    fetchOptions: {
      throw: true,
      onResponse: (ctx) => {
        impersonateSetCookie = ctx.response.headers.getSetCookie();
      },
    },
  });

  const userCookies = setCookiesToCookieHeader(impersonateSetCookie);

  const userClient = createAuthClient({
    baseURL: authConfig.osBaseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx) => {
        ctx.headers.set("origin", authConfig.osBaseUrl);
        ctx.headers.set("cookie", userCookies);
      },
    },
  });

  return { userCookies, userClient };
};

/** @param {{baseUrl: string}} params */
const loadAppRouter = async (params) => {
  const url = `${params.baseUrl}/api/trpc-cli-procedures`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} got ${response.status}: ${await response.text()}`);
  }

  const router = await response.json().catch((e) => {
    throw new Error(`${url} returned invalid router: ${e.message}`);
  });
  if (!Array.isArray(router?.procedures)) {
    throw new Error(`${url} returned invalid router: ${JSON.stringify(router)}`);
  }
  /** @type {{procedures: any[]}} */
  return router;
};

/** @param {{ baseUrl: string }} params */
const getOsProcedures = async (params) => {
  const appRouter = await loadAppRouter(params);
  /** @type {{}} */
  const proxiedRouter = proxify(appRouter.procedures, async () => {
    return createTRPCClient({
      links: [
        httpLink({
          url: `${params.baseUrl}/api/trpc/`,
          transformer: superjson,
          fetch: async (request, init) => {
            const authConfig = readAuthConfig(process.cwd());
            if (authConfig instanceof Error) throw authConfig;
            const { userCookies } = await osAuthDance(authConfig);
            const headers = new Headers(init?.headers);
            headers.set("cookie", userCookies);
            return fetch(request, { ...init, headers });
          },
        }),
      ],
    });
  });

  return proxiedRouter;
};

/**
 * Creates a fetch wrapper that calls /api/trpc-stream/* instead of /api/trpc/*.
 * The streaming endpoint returns SSE: log lines as `event: log` and the final
 * tRPC response as `event: response`, which we reassemble into a normal Response.
 * @param {string} daemonBaseUrl
 * @returns {typeof globalThis.fetch}
 */
const streamingFetch = (daemonBaseUrl) => {
  return async (/** @type {any} */ input, /** @type {any} */ init) => {
    // Rewrite URL from /api/trpc/X to /api/trpc-stream/X
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rewritten = url.replace(
      `${daemonBaseUrl}/api/trpc/`,
      `${daemonBaseUrl}/api/trpc-stream/`,
    );
    const res = await fetch(rewritten, init);
    if (rewritten === url) return res;

    const contentType = res.headers.get("content-type") || "";
    // If the daemon didn't respond with SSE, pass through as-is (non-streaming endpoint)
    if (!contentType.includes("text/event-stream")) return res;
    // Parse SSE stream: print log events to stderr, collect the final response
    const reader = res.body?.getReader();
    if (!reader) return res;
    const decoder = new TextDecoder();
    let buffer = "";
    /** @type {string | null} */
    let responseBody = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete SSE messages (double newline delimited)
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const lines = part.split("\n");
        const event = lines[0].split(": ")[1];
        const data = lines[1].split(": ").slice(1).join(": ");
        if (event === "log") {
          /** @type {{level: "debug" | "info" | "warn" | "error"; args: unknown[]}} */
          const detail = JSON.parse(data);
          console[detail.level](...detail.args);
        } else if (event === "response") {
          responseBody = data;
        }
      }
    }
    // Reconstruct a normal Response from the final payload so tRPC client is happy
    return new Response(responseBody, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
};

/** @param {{ daemonBaseUrl: string }} params */
const getDaemonProcedures = async (params) => {
  const daemonRouter = await loadAppRouter({ baseUrl: params.daemonBaseUrl });
  const proxiedRouter = proxify(daemonRouter.procedures, async () => {
    return createTRPCClient({
      links: [
        httpLink({
          url: `${params.daemonBaseUrl}/api/trpc/`,
          fetch: streamingFetch(params.daemonBaseUrl),
        }),
      ],
    });
  });

  return proxiedRouter;
};

const launcherProcedures = {
  doctor: t.procedure
    .meta({ description: "Show launcher config and resolved runtime options" })
    .mutation(async () => {
      const configFile = readConfigFile();
      const parsed = ConfigFile.safeParse(configFile);
      if (!parsed.success) {
        throw new Error(`Invalid config file ${CONFIG_PATH}: ${z.prettifyError(parsed.error)}`);
      }
      const current = readAuthConfig(process.cwd());
      if (current instanceof Error) throw current;
      return { configPath: CONFIG_PATH, current };
    }),
  setup: t.procedure
    .input(SetupInput.partial())
    .meta({ prompt: true, description: "Configure auth + launcher defaults for current workspace" })
    .mutation(async ({ input }) => {
      writeNewConfig({
        scope: input.scope || "workspace",
        patch: {
          osBaseUrl: input.osBaseUrl,
          daemonBaseUrl: input.daemonBaseUrl,
          adminPasswordEnvVarName: input.adminPasswordEnvVarName,
          userEmail: input.userEmail,
        },
        workspacePath: process.cwd(),
      });

      const current = readAuthConfig(process.cwd());
      if (current instanceof Error) throw current;
      return { configPath: CONFIG_PATH, current };
    }),

  whoami: t.procedure.mutation(async () => {
    const authConfig = readAuthConfig(process.cwd());
    if (authConfig instanceof Error) throw authConfig;
    const { userClient } = await osAuthDance(authConfig);
    return await userClient.getSession();
  }),
};

const runCli = async () => {
  const authConfig = readAuthConfig(process.cwd());

  /** @type {(problem: string) => (e: Error) => {}} */
  const errorProcedure = (problem) => (e) => {
    const message = `${problem}: ${e.message}`;
    return t.procedure.meta({ description: message }).mutation(() => {
      throw new Error(problem, { cause: e });
    });
  };

  /** @type {import("@trpc/server").AnyRouter[]} */
  const routers = [t.router(launcherProcedures)];

  if (authConfig instanceof Error) {
    routers.push(
      t.router({
        os: errorProcedure(`Invalid auth config`)(authConfig),
        daemon: errorProcedure(`Invalid auth config`)(authConfig),
      }),
    );
  } else {
    const [osProcedures, daemonProcedures] = await Promise.allSettled([
      getOsProcedures({ baseUrl: authConfig.osBaseUrl }),
      getDaemonProcedures({ daemonBaseUrl: authConfig.daemonBaseUrl }),
    ]);

    if (osProcedures.status === "fulfilled") {
      routers.push(t.router({ os: osProcedures.value }));
    } else {
      routers.push(
        t.router({
          os: errorProcedure(`Couldn't connect to os at ${authConfig.osBaseUrl}`)(
            osProcedures.reason,
          ),
        }),
      );
    }
    if (daemonProcedures.status === "fulfilled") {
      // don't nest daemon procedures under "daemon"
      routers.push(daemonProcedures.value);
    } else {
      routers.push(
        t.router({
          daemon: errorProcedure(`Couldn't connect to daemon at ${authConfig.daemonBaseUrl}`)(
            daemonProcedures.reason,
          ),
        }),
      );
    }
  }

  const router = t.mergeRouters(...routers);

  const cli = createCli({
    router,
    name: "iterate",
    version: "0.0.1",
    description: "Iterate CLI",
  });

  await cli.run({
    prompts: isAgent ? undefined : prompts,
  });
};

const main = async () => {
  await runCli();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
