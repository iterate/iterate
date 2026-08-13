import { spawnSync } from "node:child_process";
import { UNPROVISIONED } from "../../envs.ts";
import { fetchCloudflareWith429Retry } from "./cloudflare-429-retry.ts";

/**
 * The minimum an app's envs.ts entry must carry for the deploy tooling:
 * which Doppler config supplies secrets and which Cloudflare account the
 * env lives in. Each app's env interface (DeployedEnv, AuthDeployedEnv, …)
 * extends this structurally.
 */
export interface DeployableEnv {
  cloudflareAccountId: string;
  dopplerConfig: string;
}

/** Structured Cloudflare API failure so callers can handle specific statuses without parsing text. */
export class CloudflareApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(
      `Cloudflare API ${method} ${path} failed (${status}): ${String(JSON.stringify(details) ?? details).slice(0, 500)}`,
    );
    this.name = "CloudflareApiError";
  }
}

/**
 * A resolved `--env <name>` invocation: the app's envs.ts entry plus that
 * env's Doppler secrets. Every deployed-environment script starts here, so
 * the environment is always selected explicitly by name — never implied by
 * whatever Doppler config the shell happened to be wrapped in.
 */
export interface EnvContext<E extends DeployableEnv> {
  name: string;
  env: E;
  /** The env's full Doppler secret set. */
  secrets: Record<string, string>;
  /** Cloudflare API fetch scoped to the env's account (path after /accounts/<id>). */
  cf: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  /** Cloudflare API fetch with a full /client/v4 path (for zone-scoped calls). */
  cfV4: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
}

/**
 * Resolve an environment name into a full context. `env` is the explicit
 * name from the caller's CLI flag — this function never reads argv itself.
 *
 * `allowDopplerConfigFallback` (default false) permits the CI bridge: when
 * `env` is absent, fall back to DOPPLER_CONFIG — so CI's existing
 * `doppler run --config preview_N -- pnpm run-script deploy` (no flags)
 * selects the matching env without extra plumbing (env names and Doppler
 * config names coincide; the account-id assertion below still catches any
 * mismatch). Deploys pass `allowDopplerConfigFallback: true`; erase-data
 * does NOT (destructive = explicit flag only — trpc-cli enforces the
 * required `--env` option); ensure-resources passes true (harmless,
 * create-only).
 */
export async function resolveEnvContext<E extends DeployableEnv>(options: {
  envs: Record<string, E>;
  /** Doppler project the env's config lives in (e.g. "os", "auth"). */
  dopplerProject: string;
  /** Explicit environment name (the caller's --env flag). */
  env?: string;
  /** When `env` is absent, allow the CI-bridge DOPPLER_CONFIG fallback. Default false. */
  allowDopplerConfigFallback?: boolean;
}): Promise<EnvContext<E>> {
  const name =
    options.env ?? (options.allowDopplerConfigFallback ? process.env.DOPPLER_CONFIG : undefined);
  if (!name) {
    throw new Error(
      `Pass --env <name>. Known: ${Object.keys(options.envs).join(", ")} (see envs.ts).`,
    );
  }
  const env = options.envs[name];
  if (!env) {
    throw new Error(
      `Unknown environment ${JSON.stringify(name)}. Known: ${Object.keys(options.envs).join(", ")}`,
    );
  }

  const secrets = loadDopplerSecrets(options.dopplerProject, env.dopplerConfig);

  const accountId = secrets.CLOUDFLARE_ACCOUNT_ID;
  if (accountId !== env.cloudflareAccountId) {
    throw new Error(
      `Doppler config ${options.dopplerProject}/${env.dopplerConfig} carries ` +
        `CLOUDFLARE_ACCOUNT_ID=${accountId} but envs.ts says ${name} lives in account ` +
        `${env.cloudflareAccountId}. Fix whichever is wrong before proceeding.`,
    );
  }

  const cfV4 = async <T>(path: string, init?: RequestInit): Promise<T> => {
    // This fetch is THE choke point for every Cloudflare API call the deploy
    // tooling makes (ctx.cf / ctx.cfV4 across deploy, ensure-resources and
    // erase-data scripts), so 429 backoff lives here once instead of at each
    // call site. Request bodies are always strings (see the content-type
    // sniff below), so replaying the same init per attempt is safe.
    const response = await fetchCloudflareWith429Retry(
      `${init?.method ?? "GET"} ${path}`,
      () =>
        fetch(`https://api.cloudflare.com/client/v4${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${secrets.CLOUDFLARE_API_TOKEN}`,
            ...(init?.body &&
              typeof init.body === "string" && { "content-type": "application/json" }),
            ...init?.headers,
          },
        }),
      // A caller's abort also cuts the backoff wait short, not just the fetch.
      { signal: init?.signal ?? undefined },
    );
    const body: any = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) {
      throw new CloudflareApiError(
        init?.method ?? "GET",
        path,
        response.status,
        body?.errors ?? body,
      );
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
    return body.result as T;
  };
  return {
    name,
    env,
    secrets,
    cf: <T>(path: string, init?: RequestInit) => cfV4<T>(`/accounts/${accountId}${path}`, init),
    cfV4,
  };
}

/**
 * Refuse to deploy an env whose resources were never created — the fix is
 * `pnpm ensure-resources --env <name>` followed by pasting the printed IDs
 * into envs.ts.
 */
export function assertProvisioned(name: string, resources: Record<string, string>) {
  const missing = Object.entries(resources).filter(([, id]) => id === UNPROVISIONED);
  if (missing.length) {
    throw new Error(
      `Environment ${name} has unprovisioned resources (${missing.map(([key]) => key).join(", ")}). ` +
        `Run ensure-resources --env ${name}, paste the printed IDs into envs.ts, and retry.`,
    );
  }
}

/** Download a Doppler config's secrets as a plain object. */
export function loadDopplerSecrets(project: string, config: string): Record<string, string> {
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
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `doppler secrets download --project ${project} --config ${config} failed: ${result.stderr?.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}
