import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";
import { createCli, type TrpcCliMeta } from "trpc-cli";
import { proxify } from "trpc-cli/dist/proxify.js";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import * as prompts from "@clack/prompts";
import { appRouter } from "./backend/trpc/root.ts";

const t = initTRPC.meta<TrpcCliMeta>().create();

const proxiedRouter = proxify(appRouter, async () => {
  const config = getIterateConfig();
  return createTRPCClient<typeof appRouter>({
    links: [
      httpLink({
        url: `${config.baseUrl}/api/trpc/`,
        transformer: superjson,
        fetch: async (request, init) => {
          const { userCookies } = await authDance();
          const headers = new Headers(init?.headers);
          headers.set("cookie", userCookies);
          return fetch(request, { ...init, headers });
        },
      }),
    ],
  });
});

const IterateConfig = z.object({
  /** e.g. https://dev-mmkal-os.dev.iterate.com */
  baseUrl: z.string(),
  /** e.g. SERVICE_AUTH_TOKEN */
  adminPasswordEnvVarName: z.string(),
  /** e.g. usr_01kh6wb0y8f6frrwx7he4ma94s */
  userId: z.string(),
});

const IterateLauncherConfig = z.object({
  /** Local path to iterate/iterate checkout used by npm launcher package */
  repoPath: z.string().optional(),
  /** Optional git ref (branch/tag/sha) for launcher-managed checkout */
  repoRef: z.string().optional(),
  /** Whether launcher should auto-run dependency installation */
  autoInstall: z.boolean().optional(),
  /** Optional git remote URL for launcher-managed checkout */
  repoUrl: z.string().optional(),
});

const IterateConfigDefaults = IterateConfig.partial().extend(IterateLauncherConfig.shape);

const IterateConfigFileShape = z
  .object({
    global: IterateConfigDefaults.optional(),
    /** Backward-compat launcher config; replaced by global/workspaces overrides */
    launcher: IterateLauncherConfig.optional(),
    workspaces: z
      .record(z.string().describe("workspace dir path"), IterateConfigDefaults)
      .default({}),
  })
  .passthrough();

const getIterateConfigFilePath = () => {
  return path.join(os.homedir(), ".iterate/.iterate.json");
};

const getIterateConfigFile = () => {
  const configFile = getIterateConfigFilePath();
  if (!fs.existsSync(configFile)) {
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  return IterateConfigFileShape.parse(raw);
};

const getIterateConfig = () => {
  const file = getIterateConfigFile();
  if (!file) {
    throw new Error(
      `Config file ${getIterateConfigFilePath()} does not exist. Add auth config in global/workspaces (baseUrl, adminPasswordEnvVarName, userId).`,
    );
  }

  const mergedConfig = {
    ...(file.launcher ?? {}),
    ...(file.global ?? {}),
    ...(file.workspaces[process.cwd()] ?? {}),
  };

  const parsed = IterateConfig.safeParse(mergedConfig);
  if (!parsed.success) {
    throw new Error(
      `Config file ${getIterateConfigFilePath()} is missing auth config for the current working directory after merging global/workspaces: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
};

/** Set-Cookie → Cookie header: extract name=value, merge same keys (last wins). */
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

const authDance = async () => {
  const config = await getIterateConfig();
  let superadminSetCookie!: string[];
  const authClient = createAuthClient({
    baseURL: config.baseUrl,
    fetchOptions: {
      throw: true,
    },
  });
  const password = process.env[config.adminPasswordEnvVarName];
  if (!password) {
    throw new Error(`Password not found in env var ${config.adminPasswordEnvVarName}`);
  }

  await authClient.signIn.email({
    email: "superadmin@nustom.com",
    password: password,
    fetchOptions: {
      throw: true,
      onResponse: (ctx) => {
        superadminSetCookie = ctx.response.headers.getSetCookie();
      },
    },
  });

  const superadminClient = createAuthClient({
    baseURL: config.baseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx) => {
        ctx.headers.set("origin", config.baseUrl); // for some reason this is needed for
        ctx.headers.set("cookie", setCookiesToCookieHeader(superadminSetCookie));
      },
    },
    plugins: [adminClient()],
  });

  let impersonateSetCookie!: string[];
  await superadminClient.admin.impersonateUser({
    userId: config.userId,
    fetchOptions: {
      throw: true,
      onResponse: (ctx) => {
        impersonateSetCookie = ctx.response.headers.getSetCookie();
      },
    },
  });

  const userCookies = setCookiesToCookieHeader(impersonateSetCookie);

  const userClient = createAuthClient({
    baseURL: config.baseUrl,
    fetchOptions: {
      throw: true,
      onRequest: (ctx) => {
        ctx.headers.set("origin", config.baseUrl);
        ctx.headers.set("cookie", userCookies);
      },
    },
  });

  return { userCookies, adminClient: superadminClient, userClient };
};

const router = t.router({
  whoami: t.procedure.mutation(async () => {
    const { userClient } = await authDance();
    return await userClient.getSession();
  }),
  os: proxiedRouter,
});

export const cli = createCli({
  router: router,
  name: "iterate",
  version: "0.0.1",
  description: "Iterate CLI - Daemon and agent management",
});

const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  !!process.env.OPENCODE_SESSION ||
  !!process.env.CLAUDE_CODE;
cli.run({
  prompts: isAgent ? undefined : prompts,
});
