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

const IterateConfigFileShape = z.object({
  // global: IterateConfig.optional(), // could add something like this mebe

  workspaces: z.record(z.string().describe("workspace dir path"), IterateConfig),
});

const getIterateConfigFilePath = () => {
  return path.join(os.homedir(), ".iterate/.iterate.json");
};

const getIterateConfigFile = async () => {
  const configFile = getIterateConfigFilePath();
  if (!fs.existsSync(configFile)) {
    return null;
  }
  const raw = JSON.parse(await fs.promises.readFile(configFile, "utf8"));
  return IterateConfigFileShape.parse(raw);
};

const getIterateConfig = async () => {
  const file = await getIterateConfigFile();
  if (!file) {
    throw new Error(
      `Config file ${getIterateConfigFilePath()} does not exist. Have you run \`iterate setup\`?`,
    );
  }
  const config = file.workspaces[process.cwd()];
  if (!config) {
    throw new Error(
      `Config file ${getIterateConfigFilePath()} does not contain a config for the current working directory. Have you run \`iterate setup\`?`,
    );
  }
  return config;
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
  setup: t.procedure.input(IterateConfig).mutation(async ({ input }) => {
    const file = await getIterateConfigFile().catch((e) => {
      if (e instanceof z.ZodError) {
        throw new Error(
          `${getIterateConfigFilePath()} is not valid: ${z.prettifyError(e)}. Please fix it manually or delete it.`,
        );
      }
      return null;
    });

    const configPath = getIterateConfigFilePath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const newFile = {
      ...file,
      workspaces: {
        ...file?.workspaces,
        [process.cwd()]: input,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(newFile, null, 2));
    return configPath;
  }),
  checkAuth: t.procedure.mutation(async () => {
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

cli.run({
  prompts,
});
