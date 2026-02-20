import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import * as prompts from "@clack/prompts";
import { createTRPCClient, httpLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import type { AnyRouter } from "@trpc/server";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import superjson from "superjson";
import { createCli, type parseRouter } from "trpc-cli";
import { proxify } from "trpc-cli/dist/proxify.js";
import { z } from "zod/v4";

type ParsedRouter = ReturnType<typeof parseRouter>;

const XDG_CONFIG_PARENT = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);

const XDG_CONFIG_PATH = join(XDG_CONFIG_PARENT, "config.json");
const CONFIG_PATH = XDG_CONFIG_PATH;

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

type AuthConfig = z.infer<typeof AuthConfig>;
type ConfigFile = z.infer<typeof ConfigFile>;

const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  Boolean(process.env.OPENCODE_SESSION) ||
  Boolean(process.env.CLAUDE_CODE);

const t = initTRPC.meta().create();

const readConfigFile = (): ConfigFile => {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  const rawText = readFileSync(CONFIG_PATH, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${detail}`);
  }

  return parsed as ConfigFile;
};

const getMergedWorkspaceConfig = (configFile: ConfigFile, workspacePath: string): AuthConfig => {
  const configs: Array<Partial<AuthConfig> | undefined> = [];
  while (workspacePath && workspacePath !== "/") {
    if (workspacePath in (configFile.workspaces || {})) {
      configs.push(configFile.workspaces?.[workspacePath]);
    }
    workspacePath = dirname(workspacePath);
  }
  configs.push(configFile.global);
  return configs.reverse().reduce<Record<string, unknown>>((acc, config) => {
    return { ...acc, ...config };
  }, {}) as AuthConfig;
};

const writeNewConfig = ({
  patch,
  scope,
  workspacePath,
}: {
  patch?: Partial<AuthConfig>;
  scope: "workspace" | "global";
  workspacePath: string;
}): ConfigFile => {
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
    cloned.workspaces[workspacePath] = {
      ...configFile.workspaces?.[workspacePath],
      ...patch,
    } as AuthConfig;
  }

  const parsed = ConfigFile.safeParse(cloned);
  if (!parsed.success) {
    throw new Error(`Invalid config file: ${z.prettifyError(parsed.error)}`);
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return cloned;
};

const readAuthConfig = (workspacePath: string): AuthConfig | Error => {
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

const osAuthDance = async (authConfig: AuthConfig) => {
  let superadminSetCookie: string[] | undefined;
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
      onResponse: (ctx: { response: Response }) => {
        superadminSetCookie = ctx.response.headers.getSetCookie();
      },
    },
  });

  const superadminAuthClient = createAuthClient({
    baseURL: authConfig.osBaseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx: { headers: Headers }) => {
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
    baseURL: authConfig.osBaseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx: { headers: Headers }) => {
        ctx.headers.set("origin", authConfig.osBaseUrl);
        ctx.headers.set("cookie", userCookies);
      },
    },
  });

  return { userCookies, userClient };
};

const loadAppRouter = async (params: {
  baseUrl: string;
}): Promise<{ procedures: ParsedRouter }> => {
  const url = `${params.baseUrl}/api/trpc-cli-procedures`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} got ${response.status}: ${await response.text()}`);
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

const getOsProcedures = async (params: { baseUrl: string }) => {
  const appRouter = await loadAppRouter(params);
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
 */
const streamingFetch = (daemonBaseUrl: string): typeof globalThis.fetch => {
  return async (input: any, init: any) => {
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
    let responseBody: string | null = null;
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
    // Reconstruct a normal Response from the final payload so tRPC client is happy
    return new Response(responseBody, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
};

const getDaemonProcedures = async (params: { daemonBaseUrl: string }) => {
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

export const getCli = async () => {
  const authConfig = readAuthConfig(process.cwd());

  const errorProcedure = (problem: string) => (e: Error) => {
    const message = `${problem}: ${e.message}`;
    return t.procedure.meta({ description: message }).mutation(() => {
      throw new Error(problem, { cause: e });
    });
  };

  const routers: AnyRouter[] = [t.router(launcherProcedures)];

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

  return { cli, prompts: isAgent ? undefined : prompts };
};

export const runCli = async () => {
  const { cli, prompts: cliPrompts } = await getCli();
  await cli.run({ prompts: cliPrompts });
};
