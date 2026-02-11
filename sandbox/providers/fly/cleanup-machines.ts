import { parseArgs } from "node:util";
import { z } from "zod/v4";

const FLY_API_BASE = "https://api.machines.dev";
const FLY_GRAPHQL_BASE = "https://api.fly.io/graphql";
const DEFAULT_TIMEFRAME = "24h";
const DEFAULT_ACTION = "stop";
const ALLOWED_PREFIXES = new Set(["dev", "stg"]);
const LIST_APPS_PAGE_SIZE = 100;

const FLY_ORG_APPS_QUERY = `
  query FlyOrgApps($orgSlug: String!, $first: Int!, $after: String) {
    organization(slug: $orgSlug) {
      apps(first: $first, after: $after) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const FlyEnv = z.object({
  FLY_API_TOKEN: z.string().optional(),
  FLY_ORG: z.string().default("iterate"),
  SANDBOX_NAME_PREFIX: z.enum(["dev", "stg", "prd"]).optional(),
});

type FlyEnv = z.infer<typeof FlyEnv>;
type CleanupAction = "stop" | "delete";
type FlyGraphQlResponse<TData> = {
  data?: TData;
  errors?: Array<{ message?: string }>;
};
type FlyOrgApps = {
  organization: {
    apps: {
      nodes: Array<{ name: string }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  } | null;
};
type FlyOrgAppsConnection = NonNullable<FlyOrgApps["organization"]>["apps"];

type FlyMachine = {
  id?: string;
  name?: string;
  state?: string;
  updated_at?: string;
  config?: {
    metadata?: Record<string, unknown>;
  };
};

function resolveFlyToken(env: FlyEnv): string {
  return env.FLY_API_TOKEN ?? "";
}

function parseDuration(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+)([smhd])$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid timeframe '${input}'. Use formats like 30m, 24h, 7d.`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  const unitMs =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  return value * unitMs;
}

async function flyApi<T>(params: {
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const { token, method, path, body } = params;
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }

  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function flyGraphQL<TData>(params: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<TData> {
  const { token, query, variables } = params;
  const response = await fetch(FLY_GRAPHQL_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as FlyGraphQlResponse<TData>;
  if (!response.ok) {
    throw new Error(`GraphQL request failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    const message = payload.errors
      .map((error) => error.message)
      .filter((value): value is string => Boolean(value))
      .join("; ");
    throw new Error(`GraphQL request failed: ${message || "unknown error"}`);
  }

  if (!payload.data) {
    throw new Error("GraphQL request returned no data");
  }

  return payload.data;
}

function isIterateSandboxMachine(machine: FlyMachine): boolean {
  const metadata = machine.config?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return metadata["com.iterate.sandbox"] === "true";
}

function shouldSkipForStop(state: string | undefined): boolean {
  if (!state) return false;
  return state === "stopped" || state === "suspended" || state === "destroyed";
}

function resolvePrefix(positional: string[], env: FlyEnv): string {
  const argPrefix = positional[2];
  const prefix = argPrefix ?? env.SANDBOX_NAME_PREFIX;
  if (!prefix) {
    throw new Error("Missing prefix. Pass it explicitly or set SANDBOX_NAME_PREFIX.");
  }
  if (!ALLOWED_PREFIXES.has(prefix)) {
    throw new Error(
      `Prefix '${prefix}' is not allowed. This script is intentionally limited to dev/stg.`,
    );
  }
  return prefix;
}

async function listAppNamesByPrefix(params: {
  token: string;
  orgSlug: string;
  prefix: string;
}): Promise<string[]> {
  const { token, orgSlug, prefix } = params;
  const appNames: string[] = [];
  let after: string | null = null;

  while (true) {
    const appsPage: FlyOrgApps = await flyGraphQL<FlyOrgApps>({
      token,
      query: FLY_ORG_APPS_QUERY,
      variables: {
        orgSlug,
        first: LIST_APPS_PAGE_SIZE,
        after,
      },
    });

    const apps: FlyOrgAppsConnection | undefined = appsPage.organization?.apps;
    if (!apps) break;

    apps.nodes
      .map((node: { name: string }) => node.name)
      .filter((appName: string) => appName.startsWith(`${prefix}-`))
      .forEach((appName: string) => appNames.push(appName));

    if (!apps.pageInfo.hasNextPage) break;
    after = apps.pageInfo.endCursor;
    if (!after) break;
  }

  return appNames;
}

async function main(): Promise<void> {
  const env = FlyEnv.parse(process.env);
  const token = resolveFlyToken(env);
  if (!token) {
    throw new Error("Missing FLY_API_TOKEN.");
  }

  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
  });

  const timeframeArg = positionals[0] ?? DEFAULT_TIMEFRAME;
  const action = (positionals[1] ?? DEFAULT_ACTION) as CleanupAction;
  const prefix = resolvePrefix(positionals, env);

  if (action !== "stop" && action !== "delete") {
    throw new Error(`Invalid action '${action}'. Use 'stop' or 'delete'.`);
  }

  const timeframeMs = parseDuration(timeframeArg);
  const cutoff = Date.now() - timeframeMs;
  const appNames = await listAppNamesByPrefix({ token, orgSlug: env.FLY_ORG, prefix });

  let stoppedCount = 0;
  let deletedCount = 0;
  let deletedApps = 0;
  let skippedCount = 0;

  console.log(
    `fly cleanup: prefix=${prefix} action=${action} timeframe=${timeframeArg} cutoff=${new Date(cutoff).toISOString()} apps=${appNames.length}`,
  );

  for (const appName of appNames) {
    let machines: FlyMachine[] = [];
    try {
      machines = await flyApi<FlyMachine[]>({
        token,
        method: "GET",
        path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
      });
    } catch (error) {
      skippedCount += 1;
      console.log(`skip app=${appName}: ${String(error)}`);
      continue;
    }

    const candidates = machines.filter((machine) => {
      if (!isIterateSandboxMachine(machine)) return false;
      if (!machine.updated_at) return false;
      const updatedAt = Date.parse(machine.updated_at);
      if (!Number.isFinite(updatedAt)) return false;
      return updatedAt < cutoff;
    });

    for (const machine of candidates) {
      if (!machine.id) {
        skippedCount += 1;
        continue;
      }

      if (action === "stop") {
        if (shouldSkipForStop(machine.state)) {
          skippedCount += 1;
          continue;
        }
        await flyApi({
          token,
          method: "POST",
          path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machine.id)}/stop`,
          body: {},
        });
        stoppedCount += 1;
        continue;
      }

      await flyApi({
        token,
        method: "DELETE",
        path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machine.id)}?force=true`,
      });
      deletedCount += 1;

      try {
        await flyApi({
          token,
          method: "DELETE",
          path: `/v1/apps/${encodeURIComponent(appName)}`,
        });
        deletedApps += 1;
      } catch {
        // best effort app cleanup
      }
    }
  }

  console.log(
    `done: stopped=${stoppedCount} deleted=${deletedCount} deletedApps=${deletedApps} skipped=${skippedCount}`,
  );
}

await main();
