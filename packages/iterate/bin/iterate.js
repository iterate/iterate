#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import * as prompts from "@clack/prompts";
import { createTRPCClient, httpLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import superjson from "superjson";
import { createCli } from "trpc-cli";
import { proxify } from "trpc-cli/dist/proxify.js";
import { z } from "zod/v4";

const DEFAULT_REPO_URL = "https://github.com/iterate/iterate.git";
const DEFAULT_REPO_DIR = join(homedir(), ".iterate", "repo");
const CONFIG_PATH = join(homedir(), ".iterate", ".iterate.json");
const APP_ROUTER_PATH = join("apps", "os", "backend", "trpc", "root.ts");

/**
 * @typedef {{
 *   repoPath?: string;
 *   repoRef?: string;
 *   repoUrl?: string;
 *   autoInstall?: boolean;
 * }} LauncherConfig
 */

/**
 * @typedef {{
 *   global?: Record<string, unknown>;
 *   launcher?: LauncherConfig;
 *   workspaces?: Record<string, Record<string, unknown>>;
 * } & Record<string, unknown>} ConfigFile
 */

/** @typedef {"env" | "config" | "cwd" | "default"} RepoDirSource */

/**
 * @typedef {{
 *   repoDir: string;
 *   repoDirSource: RepoDirSource;
 *   repoRef?: string;
 *   repoUrl: string;
 *   autoInstall: boolean;
 *   cwdRepoDir?: string;
 *   launcherConfig: LauncherConfig;
 * }} RuntimeOptions
 */

/**
 * @typedef {{
 *   command: string;
 *   args: string[];
 *   cwd?: string;
 *   env?: Record<string, string | undefined>;
 * }} SpawnOptions
 */

/**
 * @typedef {{
 *   repoDir: string;
 *   repoRef?: string;
 *   repoUrl: string;
 * }} CheckoutOptions
 */

const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  Boolean(process.env.OPENCODE_SESSION) ||
  Boolean(process.env.CLAUDE_CODE);

const t = initTRPC.meta().create();

const SetupInput = z.object({
  baseUrl: z
    .string()
    .describe(`Base URL for os API (for example https://dev-yourname-os.dev.iterate.com)`),
  adminPasswordEnvVarName: z.string().describe("Env var name containing admin password"),
  userId: z.string().describe("User ID to impersonate for os calls"),
  repoPath: z.string().describe("Path to iterate checkout (or 'local' / 'managed' shortcuts)"),
  autoInstall: z.boolean().describe("Auto install dependencies when missing"),
  scope: z.enum(["workspace", "global"]).describe("Where to store launcher config"),
});

const AuthConfig = z.object({
  baseUrl: z.string(),
  adminPasswordEnvVarName: z.string(),
  userId: z.string(),
});

/** @param {string} message */
const log = (message) => {
  process.stderr.write(`[iterate] ${message}\n`);
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
};

/** @param {unknown} value */
const nonEmptyString = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** @param {string} input */
const normalizePath = (input) => {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  if (isAbsolute(input)) {
    return input;
  }
  return resolve(input);
};

/** @param {unknown} value */
const parseBoolean = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return undefined;
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

  if (!isObject(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object.`);
  }
  return parsed;
};

/** @param {unknown} launcher */
const sanitizeLauncherConfig = (launcher) => {
  if (!isObject(launcher)) {
    return {};
  }
  return {
    repoPath: nonEmptyString(launcher.repoPath),
    repoRef: nonEmptyString(launcher.repoRef),
    repoUrl: nonEmptyString(launcher.repoUrl),
    autoInstall: typeof launcher.autoInstall === "boolean" ? launcher.autoInstall : undefined,
  };
};

/** @param {ConfigFile} configFile */
const getGlobalConfig = (configFile) => {
  return isObject(configFile.global) ? configFile.global : {};
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
  const legacyLauncherConfig = isObject(configFile.launcher) ? configFile.launcher : {};
  return {
    ...legacyLauncherConfig,
    ...getGlobalConfig(configFile),
    ...getWorkspaceConfig(configFile, workspacePath),
  };
};

/** @param {string} workspacePath */
const readLauncherConfig = (workspacePath) => {
  const configFile = readConfigFile();
  return sanitizeLauncherConfig(getMergedWorkspaceConfig(configFile, workspacePath));
};

/**
 * @param {{
 *   launcherPatch: Partial<LauncherConfig>;
 *   workspacePatch?: Record<string, unknown>;
 *   scope: "workspace" | "global";
 *   workspacePath: string;
 * }} options
 */
const writeLauncherConfig = ({ launcherPatch, workspacePatch, scope, workspacePath }) => {
  const configFile = readConfigFile();
  const existingGlobal = getGlobalConfig(configFile);
  const existingWorkspaces = isObject(configFile.workspaces) ? configFile.workspaces : {};

  const nextGlobal = scope === "global" ? { ...existingGlobal, ...launcherPatch } : existingGlobal;
  const nextWorkspaces =
    scope === "workspace" || workspacePatch
      ? {
          ...existingWorkspaces,
          [workspacePath]: {
            ...getWorkspaceConfig(configFile, workspacePath),
            ...(scope === "workspace" ? launcherPatch : {}),
            ...(workspacePatch ?? {}),
          },
        }
      : existingWorkspaces;

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const { launcher: _legacyLauncher, ...rest } = configFile;
  const next = {
    ...rest,
    global: nextGlobal,
    workspaces: nextWorkspaces,
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
};

/** @param {string} dir */
const isIterateRepo = (dir) => {
  return (
    existsSync(join(dir, ".git")) &&
    existsSync(join(dir, "pnpm-workspace.yaml")) &&
    existsSync(join(dir, APP_ROUTER_PATH))
  );
};

/** @param {string} startDir */
const findNearestIterateRepo = (startDir) => {
  let current = resolve(startDir);
  for (;;) {
    if (isIterateRepo(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

/** @returns {RuntimeOptions} */
const resolveRuntimeOptions = () => {
  const launcherConfig = readLauncherConfig(process.cwd());
  const cwdRepoDir = findNearestIterateRepo(process.cwd());
  const envRepoDir = nonEmptyString(process.env.ITERATE_REPO_DIR);

  let repoDir;
  /** @type {RepoDirSource} */
  let repoDirSource;

  if (envRepoDir) {
    repoDir = normalizePath(envRepoDir);
    repoDirSource = "env";
  } else if (launcherConfig.repoPath) {
    repoDir = normalizePath(launcherConfig.repoPath);
    repoDirSource = "config";
  } else if (cwdRepoDir) {
    repoDir = cwdRepoDir;
    repoDirSource = "cwd";
  } else {
    repoDir = DEFAULT_REPO_DIR;
    repoDirSource = "default";
  }

  const repoRef = nonEmptyString(process.env.ITERATE_REPO_REF) ?? launcherConfig.repoRef;
  const repoUrl =
    nonEmptyString(process.env.ITERATE_REPO_URL) ?? launcherConfig.repoUrl ?? DEFAULT_REPO_URL;
  const autoInstall =
    parseBoolean(process.env.ITERATE_AUTO_INSTALL) ??
    launcherConfig.autoInstall ??
    (repoDirSource === "cwd" ? false : true);

  return {
    repoDir,
    repoDirSource,
    repoRef,
    repoUrl,
    autoInstall,
    cwdRepoDir,
    launcherConfig,
  };
};

/** @param {string} workspacePath */
const readAuthConfig = (workspacePath) => {
  const configFile = readConfigFile();
  const mergedConfig = getMergedWorkspaceConfig(configFile, workspacePath);
  const parsed = AuthConfig.safeParse(mergedConfig);
  if (!parsed.success) {
    throw new Error(
      `Config file ${CONFIG_PATH} is missing auth config for ${workspacePath}: ${z.prettifyError(parsed.error)}`,
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

/** @param {z.infer<typeof AuthConfig>} authConfig */
const authDance = async (authConfig) => {
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

  let impersonateSetCookie;
  await superadminAuthClient.admin.impersonateUser({
    userId: authConfig.userId,
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

/** @param {string} repoDir */
const loadAppRouter = async (repoDir) => {
  const appRouterPath = join(repoDir, APP_ROUTER_PATH);
  if (!existsSync(appRouterPath)) {
    throw new Error(`Could not find ${APP_ROUTER_PATH} under ${repoDir}.`);
  }
  const rootModule = await import(pathToFileURL(appRouterPath).href);
  if (!rootModule || typeof rootModule !== "object" || !("appRouter" in rootModule)) {
    throw new Error(`Failed to load appRouter from ${appRouterPath}`);
  }
  return rootModule.appRouter;
};

/** @param {unknown} error */
const commandMissing = (error) => {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
};

/** @param {SpawnOptions} options */
const run = ({ command, args, cwd, env }) => {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
};

/** @param {SpawnOptions} options */
const runChecked = async ({ command, args, cwd, env }) => {
  const code = await run({ command, args, cwd, env });
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${command} ${args.join(" ")}`);
  }
};

/** @param {CheckoutOptions} options */
const ensureRepoCheckout = async ({ repoDir, repoRef, repoUrl }) => {
  if (existsSync(repoDir)) {
    if (!existsSync(join(repoDir, APP_ROUTER_PATH))) {
      throw new Error(`Expected ${APP_ROUTER_PATH} in ${repoDir}.`);
    }
    if (!existsSync(join(repoDir, ".git"))) {
      throw new Error(`Expected git checkout at ${repoDir}, but .git is missing.`);
    }
    return;
  }

  mkdirSync(dirname(repoDir), { recursive: true });
  const cloneArgs = ["clone", "--depth", "1"];
  if (repoRef) {
    cloneArgs.push("--branch", repoRef, "--single-branch");
  }
  cloneArgs.push(repoUrl, repoDir);

  log(`cloning iterate repo into ${repoDir}`);
  try {
    await runChecked({
      command: "git",
      args: cloneArgs,
    });
  } catch (error) {
    if (commandMissing(error)) {
      throw new Error("git is required but was not found on PATH.");
    }
    throw error;
  }
};

/** @param {string} repoDir */
const hasInstalledDependencies = (repoDir) => {
  return existsSync(join(repoDir, "node_modules", ".modules.yaml"));
};

/** @param {{ repoDir: string }} options */
const installDependencies = async ({ repoDir }) => {
  log("installing dependencies with pnpm");
  const installArgs = ["install", "--frozen-lockfile"];
  try {
    await runChecked({
      command: "corepack",
      args: ["pnpm", ...installArgs],
      cwd: repoDir,
    });
    return;
  } catch (error) {
    if (!commandMissing(error)) {
      throw error;
    }
  }

  try {
    await runChecked({
      command: "pnpm",
      args: installArgs,
      cwd: repoDir,
    });
  } catch (error) {
    if (commandMissing(error)) {
      throw new Error("pnpm/corepack is required but was not found on PATH.");
    }
    throw error;
  }
};

/** @param {string} repoDir */
const getRuntimeProcedures = async (repoDir) => {
  const appRouter = await loadAppRouter(repoDir);
  const proxiedRouter = proxify(appRouter, async () => {
    return createTRPCClient({
      links: [
        httpLink({
          url: `${readAuthConfig(process.cwd()).baseUrl}/api/trpc/`,
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
      const runtime = resolveRuntimeOptions();
      return {
        configPath: CONFIG_PATH,
        repoDir: runtime.repoDir,
        repoDirSource: runtime.repoDirSource,
        autoInstall: runtime.autoInstall,
        repoRef: runtime.repoRef ?? null,
        repoUrl: runtime.repoUrl,
        cwdRepoDir: runtime.cwdRepoDir ?? null,
        repoExists: existsSync(runtime.repoDir),
        dependenciesInstalled: hasInstalledDependencies(runtime.repoDir),
      };
    }),
  setup: t.procedure
    .input(SetupInput)
    .meta({ description: "Configure auth + launcher defaults for current workspace" })
    .mutation(async ({ input }) => {
      const runtime = resolveRuntimeOptions();

      const rawRepoPath = input.repoPath.trim().toLowerCase();
      let repoPath = normalizePath(input.repoPath);
      if (rawRepoPath === "managed") {
        repoPath = DEFAULT_REPO_DIR;
      } else if (rawRepoPath === "local") {
        if (!runtime.cwdRepoDir) {
          throw new Error(
            "'local' repoPath was selected but current directory is not inside an iterate repo",
          );
        }
        repoPath = runtime.cwdRepoDir;
      }

      const next = writeLauncherConfig({
        launcherPatch: { repoPath, autoInstall: input.autoInstall },
        workspacePatch: {
          baseUrl: input.baseUrl,
          adminPasswordEnvVarName: input.adminPasswordEnvVarName,
          userId: input.userId,
        },
        scope: input.scope,
        workspacePath: process.cwd(),
      });
      return {
        configPath: CONFIG_PATH,
        launcher: sanitizeLauncherConfig(getMergedWorkspaceConfig(next, process.cwd())),
        scope: input.scope,
      };
    }),
  install: t.procedure
    .meta({ description: "Clone repo if needed, then run pnpm install" })
    .mutation(async () => {
      const runtime = resolveRuntimeOptions();
      await ensureRepoCheckout(runtime);
      await installDependencies({ repoDir: runtime.repoDir });
      return { repoDir: runtime.repoDir };
    }),
};

/** @param {string[]} args */
const runCli = async (args) => {
  const runtime = resolveRuntimeOptions();
  await ensureRepoCheckout(runtime);

  if (runtime.autoInstall && !hasInstalledDependencies(runtime.repoDir)) {
    await installDependencies({ repoDir: runtime.repoDir });
  }

  const runtimeProcedures = await getRuntimeProcedures(runtime.repoDir);
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

  process.argv = [process.argv[0], process.argv[1], ...args];
  await cli.run({
    prompts: isAgent ? undefined : prompts,
  });
};

const main = async () => {
  const args = process.argv.slice(2);

  if (args[0] === "launcher") {
    await runCli(args.slice(1));
    return;
  }
  await runCli(args);
};

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`iterate bootstrap failed: ${detail}\n`);
  process.exit(1);
});
