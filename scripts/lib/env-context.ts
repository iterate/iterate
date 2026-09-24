import { spawnSync } from "node:child_process";
import { UNPROVISIONED } from "../../envs.ts";
import { fetchCloudflareWith429Retry } from "./cloudflare-429-retry.ts";

/**
 * The minimum an app's envs.ts entry must carry for the deploy tooling:
 * which Doppler config supplies secrets and which Cloudflare account the
 * env lives in. Each app's env interface (envs.ts OsEnv, KitEnv,
 * DummyPetshopEnv; start-app.ts StartAppEnv) extends this structurally.
 */
export interface DeployableEnv {
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
 * the environment is selected by name (a deploy's or ensure-resources'
 * DOPPLER_CONFIG fallback aside; see resolveEnvContext).
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
 * `doppler run -- pnpm run-script deploy` (no flags)
 * selects the matching env without extra plumbing (env names and Doppler
 * config names coincide; the account-id assertion below still catches any
 * mismatch). Deploys pass `allowDopplerConfigFallback: true`; erase-data
 * does NOT (destructive = explicit flag only — trpc-cli enforces the
 * required `--env` option); ensure-resources passes true (harmless,
 * create-only).
 */
export async function resolveEnvContext<E extends DeployableEnv>(options: {
  envs: Record<string, E>;
  /** Doppler project the env's config lives in (e.g. "os", "dash"). */
  dopplerProject: string;
  /** Explicit environment name (the caller's --env flag). */
  env?: string;
  /** When `env` is absent, allow the CI-bridge DOPPLER_CONFIG fallback. Default false. */
  allowDopplerConfigFallback?: boolean;
}): Promise<EnvContext<E>> {
  const name =
    options.env || (options.allowDopplerConfigFallback ? process.env.DOPPLER_CONFIG : undefined);
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
    // A 2xx with no JSON body answers undefined — Artifacts accepts a repo delete with a 202 and
    // nothing else, and deletes a namespace the same way.
    return body?.result as T;
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
  if (missing.length > 0) {
    throw new Error(
      `Environment ${name} has unprovisioned resources (${missing.map(([key]) => key).join(", ")}). ` +
        `Run ensure-resources --env ${name}, paste the printed IDs into envs.ts, and retry.`,
    );
  }
}

/** Download a Doppler config's secrets as a plain object. */
function loadDopplerSecrets(project: string, config: string): Record<string, string> {
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
