#!/usr/bin/env node
// @ts-check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import * as prompts from "@clack/prompts";
import { createTRPCClient, httpLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import superjson from "superjson";
import { createCli } from "trpc-cli";
import { proxify } from "trpc-cli/dist/proxify.js";
import { z } from "zod/v4";

const XDG_CONFIG_PARENT = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);

const XDG_CONFIG_PATH = join(XDG_CONFIG_PARENT, "config.json");
const CONFIG_PATH = XDG_CONFIG_PATH;
// todo write json schema to file too - need to make everything zod first
// const CONFIG_SCHEMA_PATH = join(XDG_CONFIG_PARENT, "config-schema.json");

const SetupInput = z.object({
  baseUrl: z
    .string()
    .describe(`Base URL for os API (for example https://dev-yourname-os.dev.iterate.com)`),
  adminPasswordEnvVarName: z.string().describe("Env var name containing admin password"),
  userEmail: z.string().describe("User email to impersonate for os calls"),
  scope: z.enum(["workspace", "global"]).describe("Where to store launcher config"),
});

const AuthConfig = z.object({
  baseUrl: z.string(),
  adminPasswordEnvVarName: z.string(),
  userEmail: z.string(),
});

const ConfigFile = z.object({
  global: AuthConfig.partial().optional(),
  workspaces: z.record(z.string(), AuthConfig).optional(),
});

/** @typedef {z.infer<typeof AuthConfig>} AuthConfig */
/** @typedef {z.infer<typeof ConfigFile>} ConfigFile */

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
const getWorkspaceConfig = (configFile, workspacePath) => {
  const workspaces = isObject(configFile.workspaces) ? configFile.workspaces : {};
  const rawWorkspaceConfig = workspaces[workspacePath];
  return isObject(rawWorkspaceConfig) ? rawWorkspaceConfig : {};
};

/**
 * @param {ConfigFile} configFile
 * @param {string} workspacePath
 */
const getMergedWorkspaceConfig = (configFile, workspacePath) => {
  return {
    ...configFile.global,
    ...getWorkspaceConfig(configFile, workspacePath),
  };
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
    throw new Error(
      `Config file ${CONFIG_PATH} is missing auth config for ${workspacePath}. Have you run \`iterate setup\`?\n${z.prettifyError(parsed.error)}`,
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

/** @param {z.infer<typeof AuthConfig>} authConfig */
const authDance = async (authConfig) => {
  /** @type {string[] | undefined} */
  let superadminSetCookie;
  const authClient = createAuthClient({
    baseURL: authConfig.baseUrl,
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
    baseURL: authConfig.baseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx) => {
        ctx.headers.set("origin", authConfig.baseUrl);
        ctx.headers.set("cookie", setCookiesToCookieHeader(superadminSetCookie));
      },
    },
    plugins: [adminClient()],
  });

  const userId = await resolveImpersonationUserId({
    superadminAuthClient,
    userEmail: authConfig.userEmail,
    baseUrl: authConfig.baseUrl,
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
    baseURL: authConfig.baseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx) => {
        ctx.headers.set("origin", authConfig.baseUrl);
        ctx.headers.set("cookie", userCookies);
      },
    },
  });

  return { userCookies, userClient };
};

/** @param {{baseUrl: string}} params */
const loadAppRouter = async (params) => {
  const url = `${params.baseUrl}/api/trpc-cli-serialised-router`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} got ${response.status}: ${await response.text()}`);
  }
  /** @type {import("trpc-cli/dist/trpc-compat.js").SerialisedRouter} */
  const router = await response.json();
  if (router?.type !== "trpc-cli-serialised-router") {
    throw new Error(`${url} returned invalid router: ${JSON.stringify(router)}`);
  }
  return router;
};

/** @param {{ baseUrl: string }} params */
const getRuntimeProcedures = async (params) => {
  const appRouter = await loadAppRouter(params);
  /** @type {{}} */
  const proxiedRouter = proxify(appRouter, async () => {
    return createTRPCClient({
      links: [
        httpLink({
          url: `${params.baseUrl}/api/trpc/`,
          transformer: superjson,
          fetch: async (request, init) => {
            const authConfig = readAuthConfig(process.cwd());
            const { userCookies } = await authDance(authConfig);
            const headers = new Headers(init?.headers);
            headers.set("cookie", userCookies);
            return fetch(request, { ...init, headers });
          },
        }),
      ],
    });
  });

  return {
    whoami: t.procedure.mutation(async () => {
      const authConfig = readAuthConfig(process.cwd());
      const { userClient } = await authDance(authConfig);
      return await userClient.getSession();
    }),
    os: proxiedRouter,
  };
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
      return {
        configPath: CONFIG_PATH,
        current: readAuthConfig(process.cwd()),
      };
    }),
  setup: t.procedure
    .input(SetupInput.partial())
    .meta({ prompt: true, description: "Configure auth + launcher defaults for current workspace" })
    .mutation(async ({ input }) => {
      writeNewConfig({
        scope: input.scope || "workspace",
        patch: {
          baseUrl: input.baseUrl,
          adminPasswordEnvVarName: input.adminPasswordEnvVarName,
          userEmail: input.userEmail,
        },
        workspacePath: process.cwd(),
      });

      return {
        configPath: CONFIG_PATH,
        current: readAuthConfig(process.cwd()),
      };
    }),
};

const runCli = async () => {
  const baseUrl = readAuthConfig(process.cwd()).baseUrl;

  const runtimeProcedures = await getRuntimeProcedures({ baseUrl });
  const router = t.router({
    ...launcherProcedures,
    ...runtimeProcedures,
  });

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
