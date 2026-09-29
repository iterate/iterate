import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { z } from "zod";
import { CLOUDFLARE_API, fetchRetryingPlatformFailures } from "@iterate-com/shared/platform-retry";
import { UNPROVISIONED } from "../../envs.ts";

/**
 * An app's envs.ts entry and the name it was found by (envs.ts `getDeployTarget`,
 * `getOsDeployTarget`), as the deploy tooling needs every one: which Doppler
 * config supplies its secrets and which Cloudflare account it lives in. The
 * name (`prd`, `preview`, a per-commit deployment's `pr3144-a1b2c3d`) travels
 * with the entry because the vite build runs in its own process and finds the
 * entry again by it (`CLOUDFLARE_ENV`).
 */
export interface DeployableEnv {
  name: string;
  cloudflareAccountId: string;
  dopplerConfig: string;
}

/** Structured Cloudflare API failure so callers can handle specific statuses without parsing text. */
export class CloudflareApiError extends Error {
  method: string;
  path: string;
  status: number;
  details: unknown;

  constructor(method: string, path: string, status: number, details: unknown) {
    super(
      `Cloudflare API ${method} ${path} failed (${status}): ${String(JSON.stringify(details) ?? details).slice(0, 500)}`,
    );
    this.name = "CloudflareApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.details = details;
  }
}

/**
 * A resolved `--env <name>` invocation: the app's envs.ts entry plus that
 * env's Doppler secrets. Every deployed-environment script starts here, so
 * the environment is always selected by name.
 */
export interface EnvContext<E extends DeployableEnv> {
  env: E;
  /** The env's full Doppler secret set. */
  secrets: Record<string, string>;
  /** Cloudflare API fetch scoped to the env's account (path after /accounts/<id>). */
  cf: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  /** Cloudflare API fetch with a full /client/v4 path (for zone-scoped calls). */
  cfV4: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
}

/**
 * Resolve an env into a full context: its Doppler secrets, checked against
 * the Cloudflare account envs.ts says it lives in. The caller looks the env
 * up by its `--env` flag, the only way to choose one; this function never
 * reads argv or the environment for it.
 */
export async function resolveEnvContext<E extends DeployableEnv>(options: {
  env: E;
  /** Doppler project the env's config lives in (e.g. "os", "dash"). */
  dopplerProject: string;
}): Promise<EnvContext<E>> {
  const { env } = options;
  const secrets = loadDopplerSecrets(options.dopplerProject, env.dopplerConfig);

  const accountId = secrets.CLOUDFLARE_ACCOUNT_ID;
  if (accountId !== env.cloudflareAccountId) {
    throw new Error(
      `Doppler config ${options.dopplerProject}/${env.dopplerConfig} carries ` +
        `CLOUDFLARE_ACCOUNT_ID=${accountId} but envs.ts says ${env.name} lives in account ` +
        `${env.cloudflareAccountId}. Fix whichever is wrong before proceeding.`,
    );
  }

  const cfV4 = cloudflareApi(secrets.CLOUDFLARE_API_TOKEN);
  return {
    env,
    secrets,
    cf: <T>(path: string, init?: RequestInit) => cfV4<T>(`/accounts/${accountId}${path}`, init),
    cfV4,
  };
}

/**
 * Cloudflare's API with `apiToken`, `path` under /client/v4: THE choke point for every Cloudflare API
 * call the deploy tooling makes (ctx.cf / ctx.cfV4 across deploy, ensure-resources and erase-data),
 * so this is where a call Cloudflare failed is sent again (CLOUDFLARE_API's schedule): after a 429
 * whatever its method, after a 5xx or a lost connection only when its method names its whole end
 * state. Request bodies are always strings (see the content-type sniff below), so replaying the
 * same init per attempt is safe.
 */
export function cloudflareApi(apiToken: string) {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method || "GET";
    const response = await fetchRetryingPlatformFailures(
      `${method} ${path}`,
      (signal) =>
        fetch(`https://api.cloudflare.com/client/v4${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${apiToken}`,
            ...(init?.body &&
              typeof init.body === "string" && { "content-type": "application/json" }),
            ...init?.headers,
          },
          signal,
        }),
      {
        area: "cloudflare-api",
        schedule: CLOUDFLARE_API,
        idempotent: ["GET", "HEAD", "PUT", "PATCH", "DELETE"].includes(method),
        timeoutMs: 60_000,
        signal: init?.signal || undefined,
      },
    );
    const body: any = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) {
      throw new CloudflareApiError(method, path, response.status, body?.errors ?? body);
    }
    // Fail loudly instead of silently acting on a truncated listing.
    const info = body?.result_info;
    const explicitPage = new URL(`https://api.cloudflare.com/client/v4${path}`).searchParams.has(
      "page",
    );
    if (
      !explicitPage &&
      info?.total_count &&
      Array.isArray(body.result) &&
      body.result.length < info.total_count
    ) {
      throw new Error(
        `Cloudflare API ${path} returned page 1 of ${info.total_count} results — raise per_page or paginate.`,
      );
    }
    // A 2xx with no JSON body answers undefined — Artifacts accepts a repo delete with a 202 and
    // nothing else, and deletes a namespace the same way.
    return body?.result as T;
  };
}

/**
 * Refuse to deploy an env whose resources were never created — the fix is
 * `pnpm ensure-resources --env <name>` followed by pasting the printed IDs
 * into envs.ts.
 */
export function assertProvisioned(name: string, resources: Record<string, string>) {
  const missing = Object.entries(resources).filter(([, id]) => id === UNPROVISIONED);
  if (missing.length > 0) {
    throw new Error(
      `Environment ${name} has unprovisioned resources (${missing.map(([key]) => key).join(", ")}). ` +
        `Run ensure-resources --env ${name}, paste the printed IDs into envs.ts, and retry.`,
    );
  }
}

/**
 * `name` out of Doppler `project`/`config`: how a script reads a secret that belongs to no envs.ts
 * deployment (the Slack bot token, the Depot organization token, an account's Cloudflare API token).
 * A workflow step hands its script DOPPLER_TOKEN and nothing else (docs/depot-ci.md#secrets).
 *
 * `fallback` names a file that keeps the config, encrypted, for a later step of the same job: a read
 * that finds no file there fetches the config and writes it, and one that finds it reads it without
 * a request. The test evidence upload's token is fetched beside the tests this way.
 */
export function dopplerSecret(
  project: string,
  config: string,
  name: string,
  options: { fallback?: string } = {},
): string {
  const value = loadDopplerSecrets(project, config, options.fallback)[name];
  if (!value) throw new Error(`Doppler ${project}/${config} has no ${name}`);
  return value;
}

/** THE DOPPLER READ, resolveEnvContext's and dopplerSecret's: a config's secrets as a plain object,
 *  downloaded by the Doppler CLI (DOPPLER_TOKEN in CI, its login on a laptop). */
function loadDopplerSecrets(
  project: string,
  config: string,
  fallback?: string,
): Record<string, string> {
  // What the file holds is a whole config: an empty one is a write that failed.
  const offline = fallback ? (statSync(fallback, { throwIfNoEntry: false })?.size ?? 0) > 0 : false;
  const result = spawnSync(
    "doppler",
    [
      "secrets",
      "download",
      "--no-file",
      "--format",
      "json",
      "--project",
      project,
      "--config",
      config,
      ...(fallback ? ["--fallback", fallback] : []),
      ...(offline ? ["--fallback-only"] : []),
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `doppler secrets download --project ${project} --config ${config}${offline ? " --fallback-only" : ""} failed: ${result.error?.message || result.stderr.trim()}`,
    );
  }
  return z.record(z.string(), z.string()).parse(JSON.parse(result.stdout));
}
