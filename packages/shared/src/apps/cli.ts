import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os } from "@orpc/server";
import { createCli, parseRouter, type AnyRouter } from "trpc-cli";
import type { StandardSchemaV1 } from "trpc-cli/dist/standard-schema/contract.js";

const DEFAULT_DISCOVERY_PATH = "/__common/trpc-cli-procedures";
const DEFAULT_RPC_PATH = "/orpc/";
const DEFAULT_LOCAL_ROUTER_PATHS = ["scripts/router.ts", "cli/router.ts"] as const;
const REMOTE_GROUP_NAME = "rpc";

type ParsedRouter = ReturnType<typeof parseRouter>;
type IterateAppCliAuthMode = "shared-api-secret-bearer";
export type IterateAppCliPackageConfig = {
  remote?: {
    baseUrlEnvVar?: string;
    defaultBaseUrl?: string;
    discoveryPath?: string;
    rpcPath?: string;
    auth?: IterateAppCliAuthMode;
  };
  localRouterPaths?: string[];
};
type PackageInfo = {
  name?: string;
  version?: string;
  description?: string;
  iterateAppCli?: IterateAppCliPackageConfig;
};

export type ResolveHeadersArgs = {
  apiBaseUrl: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  packageJson: PackageInfo;
};

type IterateAppCliConfig = {
  remote: {
    baseUrlEnvVar: string;
    defaultBaseUrl?: string;
    discoveryPath: string;
    rpcPath: string;
    resolveHeaders?:
      | ((
          args: ResolveHeadersArgs,
        ) =>
          | Promise<NonNullable<RequestInit["headers"]> | undefined>
          | NonNullable<RequestInit["headers"]>
          | undefined)
      | undefined;
  };
  localRouterPaths?: string[];
};

export async function runAppCli() {
  const baseUrlFlag = consumeCliStringFlag("--base-url");
  const cwd = process.cwd();
  const packageJson = readPackageJson(cwd);
  const config = resolveCliConfig({ cwd, packageJson });
  const localRouter = await loadLocalRouter({
    cwd,
    localRouterPaths: config.localRouterPaths ?? [...DEFAULT_LOCAL_ROUTER_PATHS],
  });

  if (localRouter && REMOTE_GROUP_NAME in localRouter) {
    throw new Error(
      `Local router cannot define the reserved root command ${JSON.stringify(REMOTE_GROUP_NAME)}.`,
    );
  }

  const apiBaseUrlInput =
    baseUrlFlag ?? process.env[config.remote.baseUrlEnvVar] ?? config.remote.defaultBaseUrl;
  const rpcRequested = firstNonFlagArgument(process.argv.slice(2)) === REMOTE_GROUP_NAME;

  const remoteRouterResult = await loadRemoteRouter({
    apiBaseUrlInput,
    config,
    cwd,
    packageJson,
  });

  if (rpcRequested && !remoteRouterResult.ok) {
    throw new Error(remoteRouterResult.message);
  }

  const router = {
    ...(localRouter ?? {}),
    [REMOTE_GROUP_NAME]: remoteRouterResult.ok
      ? remoteRouterResult.router
      : errorProcedure(remoteRouterResult.message),
  } as AnyRouter;

  const cli = createCli({
    router,
    name: packageJson.name ?? "iterate-app-cli",
    version: packageJson.version ?? "0.0.0",
    description: packageJson.description ?? "Iterate app CLI",
  });

  await cli.run();
}

async function loadLocalRouter(params: { cwd: string; localRouterPaths: string[] }) {
  const localRouterPath = params.localRouterPaths.find((routerPath) =>
    existsSync(resolve(params.cwd, routerPath)),
  );

  if (!localRouterPath) {
    return undefined;
  }

  const fullPath = resolve(params.cwd, localRouterPath);
  const imported = (await import(pathToFileURL(fullPath).href)) as {
    router?: Record<string, unknown>;
  };

  if (!imported.router || typeof imported.router !== "object") {
    throw new Error(
      `Local router module ${JSON.stringify(localRouterPath)} must export a named "router" object.`,
    );
  }

  return imported.router;
}

async function loadRemoteRouter(params: {
  apiBaseUrlInput: string | undefined;
  config: IterateAppCliConfig;
  cwd: string;
  packageJson: PackageInfo;
}): Promise<
  | { ok: true; router: AnyRouter }
  | {
      ok: false;
      message: string;
    }
> {
  if (!params.apiBaseUrlInput) {
    return {
      ok: false,
      message: `No remote base URL configured. Pass --base-url or set ${params.config.remote.baseUrlEnvVar}.`,
    };
  }

  const apiBaseUrl = normalizeApiBaseUrl(params.apiBaseUrlInput);

  try {
    const remoteProcedures = await loadRemoteProcedures({
      apiBaseUrl,
      discoveryPath: params.config.remote.discoveryPath ?? DEFAULT_DISCOVERY_PATH,
    });

    const remoteRouter = proxifyOrpc(remoteProcedures.procedures, () => {
      const client = createORPCClient(
        new RPCLink({
          url: joinApiPath(apiBaseUrl, params.config.remote.rpcPath),
          fetch: async (request: URL | Request, init?: RequestInit) => {
            const headers = new Headers(
              request instanceof Request ? request.headers : init?.headers,
            );
            const resolvedHeaders = await params.config.remote.resolveHeaders?.({
              apiBaseUrl,
              cwd: params.cwd,
              env: process.env,
              packageJson: params.packageJson,
            });

            for (const [key, value] of new Headers(resolvedHeaders).entries()) {
              headers.set(key, value);
            }

            return fetch(request, { ...init, headers });
          },
        }),
      );

      return orpcToTrpcStyleClient(client);
    });

    return {
      ok: true,
      router: remoteRouter as AnyRouter,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function readPackageJson(cwd: string): PackageInfo {
  const packageJsonPath = join(cwd, "package.json");

  if (!existsSync(packageJsonPath)) {
    return {};
  }

  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageInfo;
}

function normalizeApiBaseUrl(value: string) {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("Remote base URL cannot be empty.");
  }

  const prefixed = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(prefixed);
  const pathname = url.pathname.replace(/\/+$/, "");

  url.pathname = pathname.endsWith("/api") ? pathname : `${pathname}/api`;
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/+$/, "");
}

async function loadRemoteProcedures(params: {
  apiBaseUrl: string;
  discoveryPath: string;
}): Promise<{ procedures: ParsedRouter }> {
  const url = joinApiPath(params.apiBaseUrl, params.discoveryPath);
  const response = await fetch(url);

  if (!response.ok) {
    let text = await response.text();

    if (text.includes("<title>")) {
      text = `HTML with title: ${text.split("<title>")[1]?.split("</title>")[0] ?? "unknown"}`;
    } else if (
      ["<html>", "<body>", "<head>", "!DOCTYPE html"].some((pattern) => text.includes(pattern))
    ) {
      text = "<html>...</html>";
    } else {
      text = text.split("\n")[0] ?? "";
      if (text.length > 80) {
        text = `${text.slice(0, 80)}...`;
      }
    }

    throw new Error(`${url} got ${response.status}: ${text}`);
  }

  let router: unknown;

  try {
    router = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${url} returned invalid router: ${message}`);
  }

  if (!Array.isArray((router as { procedures?: unknown })?.procedures)) {
    throw new Error(`${url} returned invalid router: ${JSON.stringify(router)}`);
  }

  return router as { procedures: ParsedRouter };
}

function joinApiPath(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function firstNonFlagArgument(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (!value?.startsWith("-")) {
      return value;
    }

    const next = args[index + 1];
    if (value === "--base-url" && next && !next.startsWith("-")) {
      index += 1;
    }
  }

  return undefined;
}

function consumeCliStringFlag(flagName: string): string | undefined {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf(flagName);

  if (flagIndex === -1) {
    return undefined;
  }

  const value = args[flagIndex + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`${flagName} requires a value.`);
  }

  process.argv.splice(flagIndex + 2, 2);
  return value;
}

function resolveCliConfig(params: { cwd: string; packageJson: PackageInfo }): IterateAppCliConfig {
  const slug = inferAppSlug({ cwd: params.cwd, packageJson: params.packageJson });
  const envPrefix = slugToEnvPrefix(slug);
  const packageConfig = params.packageJson.iterateAppCli;

  return {
    remote: {
      baseUrlEnvVar: packageConfig?.remote?.baseUrlEnvVar ?? `${envPrefix}_BASE_URL`,
      defaultBaseUrl: packageConfig?.remote?.defaultBaseUrl,
      discoveryPath: packageConfig?.remote?.discoveryPath ?? DEFAULT_DISCOVERY_PATH,
      rpcPath: packageConfig?.remote?.rpcPath ?? DEFAULT_RPC_PATH,
      resolveHeaders: createRemoteHeadersResolver({
        auth: packageConfig?.remote?.auth,
        envPrefix,
      }),
    },
    localRouterPaths: packageConfig?.localRouterPaths ?? [...DEFAULT_LOCAL_ROUTER_PATHS],
  };
}

function inferAppSlug(params: { cwd: string; packageJson: PackageInfo }) {
  const packageName = params.packageJson.name?.trim();
  const scopedPackageMatch = /^@iterate-com\/(.+)$/.exec(packageName ?? "");

  if (scopedPackageMatch?.[1]) {
    return scopedPackageMatch[1];
  }

  const cwdBasename = basename(params.cwd);
  if (cwdBasename) {
    return cwdBasename;
  }

  throw new Error("Could not infer app slug for iterate-app-cli.");
}

function slugToEnvPrefix(slug: string) {
  return slug
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function createRemoteHeadersResolver(params: { auth?: IterateAppCliAuthMode; envPrefix: string }) {
  if (params.auth === "shared-api-secret-bearer") {
    return ({ env }: ResolveHeadersArgs) =>
      resolveSharedApiSecretBearerHeaders({
        env,
        envPrefix: params.envPrefix,
      });
  }

  return undefined;
}

function resolveSharedApiSecretBearerHeaders(params: {
  env: NodeJS.ProcessEnv;
  envPrefix: string;
}) {
  const token =
    params.env[`${params.envPrefix}_API_KEY`]?.trim() ||
    params.env[`${params.envPrefix}_API_TOKEN`]?.trim() ||
    params.env.APP_CONFIG_SHARED_API_SECRET?.trim() ||
    readSharedApiSecretFromAppConfig(params.env.APP_CONFIG);

  if (!token) {
    throw new Error(
      `RPC commands require ${params.envPrefix}_API_KEY, ${params.envPrefix}_API_TOKEN, APP_CONFIG_SHARED_API_SECRET, or APP_CONFIG.sharedApiSecret.`,
    );
  }

  return {
    authorization: `Bearer ${token}`,
  };
}

function readSharedApiSecretFromAppConfig(rawValue: string | undefined) {
  if (!rawValue?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawValue) as { sharedApiSecret?: unknown };
    return typeof parsed.sharedApiSecret === "string" ? parsed.sharedApiSecret.trim() : undefined;
  } catch {
    return undefined;
  }
}

function errorProcedure(message: string) {
  return os.meta({ description: message }).handler(() => {
    throw new Error(message);
  });
}

function orpcToTrpcStyleClient(orpcClient: unknown) {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        const parts = prop.split(".");
        let current: any = orpcClient;

        for (const part of parts) {
          current = current[part];
        }

        return {
          query: (input: unknown) => current(input),
          mutate: (input: unknown) => current(input),
        };
      },
    },
  );
}

function proxifyOrpc<R extends AnyRouter>(
  router: R | ReturnType<typeof parseRouter>,
  getClient: (procedurePath: string) => unknown,
) {
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
      .handler(async ({ input }: { input: unknown }) => {
        const client: any = await getClient(procedurePath);
        return client[procedurePath].query(input);
      });
  }

  return outputRouterRecord;
}
