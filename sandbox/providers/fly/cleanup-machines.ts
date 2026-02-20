import { initTRPC } from "@trpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod/v4";

const FLY_API_BASE = "https://api.machines.dev";
const FLY_GRAPHQL_BASE = "https://api.fly.io/graphql";
/** Prefixes allowed by default. Use --prefix to bypass this restriction. */
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

const t = initTRPC.create();

const router = t.router({
  cleanup: t.procedure
    .meta({ description: "Stop or delete idle Fly machines for a given prefix", default: true })
    .input(
      z.object({
        timeframe: z
          .string()
          .default("24h")
          .describe("How long a machine must be idle before cleanup (e.g. 30m, 24h, 7d)"),
        action: z
          .enum(["stop", "delete"])
          .default("stop")
          .describe("Whether to stop or delete matching machines"),
        prefix: z
          .string()
          .optional()
          .describe(
            "App name prefix to target. Falls back to SANDBOX_NAME_PREFIX env var. Arbitrary prefixes must start with 'test-'.",
          ),
        all: z
          .boolean()
          .default(false)
          .describe("Skip age-based filtering and clean up ALL matching machines (useful for CI)"),
      }),
    )
    .mutation(async ({ input }) => {
      const env = FlyEnv.parse(process.env);
      const token = resolveFlyToken(env);
      if (!token) {
        throw new Error("Missing FLY_API_TOKEN.");
      }

      const prefix = input.prefix ?? env.SANDBOX_NAME_PREFIX;
      if (!prefix) {
        throw new Error("Missing --prefix. Pass it explicitly or set SANDBOX_NAME_PREFIX.");
      }
      if (!ALLOWED_PREFIXES.has(prefix)) {
        if (!prefix.startsWith("test-")) {
          throw new Error(
            `Prefix '${prefix}' is not allowed. Only dev/stg or test-* prefixes are permitted.`,
          );
        }
      }

      if (input.all) {
        console.log("WARNING: --all flag is set, age-based filtering is disabled");
      }

      const timeframeMs = parseDuration(input.timeframe);
      const cutoff = Date.now() - timeframeMs;
      const appNames = await listAppNamesByPrefix({ token, orgSlug: env.FLY_ORG, prefix });

      let stoppedCount = 0;
      let deletedCount = 0;
      let deletedApps = 0;
      let skippedCount = 0;

      console.log(
        `fly cleanup: prefix=${prefix} action=${input.action} timeframe=${input.timeframe} cutoff=${new Date(cutoff).toISOString()} apps=${appNames.length}${input.all ? " (--all: no age filter)" : ""}`,
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
          // --all skips age-based filtering (useful for CI cleanup)
          if (input.all) return true;
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

          if (input.action === "stop") {
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

          try {
            await flyApi({
              token,
              method: "DELETE",
              path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machine.id)}?force=true`,
            });
            deletedCount += 1;
          } catch (error) {
            skippedCount += 1;
            console.log(`skip delete app=${appName} machine=${machine.id}: ${String(error)}`);
            continue;
          }
        }

        // Delete the app if action=delete and all machines were cleaned up (or app was empty)
        if (input.action === "delete" && (candidates.length > 0 || machines.length === 0)) {
          // Re-check remaining machines after deletions — only delete app if truly empty
          try {
            const remaining = await flyApi<FlyMachine[]>({
              token,
              method: "GET",
              path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
            });
            if (remaining.length === 0) {
              await flyApi({
                token,
                method: "DELETE",
                path: `/v1/apps/${encodeURIComponent(appName)}`,
              });
              deletedApps += 1;
            }
          } catch {
            // best effort app cleanup
          }
        }
      }

      return `done: stopped=${stoppedCount} deleted=${deletedCount} deletedApps=${deletedApps} skipped=${skippedCount}`;
    }),
});

createCli({ router }).run();
