import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireEnv, type DeployedEnv } from "../../../../envs.ts";

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A resolved `--env <name>` invocation: the envs.ts entry plus that env's
 * Doppler secrets. Every deployed-environment script starts here, so the
 * environment is always selected explicitly by name — never implied by
 * whatever Doppler config the shell happened to be wrapped in.
 */
export interface EnvContext {
  name: string;
  env: DeployedEnv;
  /** The env's full Doppler secret set (project `os`, config env.dopplerConfig). */
  secrets: Record<string, string>;
  /** Cloudflare API fetch, authed with the env's token, scoped to its account. */
  cf: (path: string, init?: RequestInit) => Promise<any>;
}

/** Resolve `--env <name>` from argv (or ITERATE_ENV) into a full context. */
export async function resolveEnvContext(argv = process.argv): Promise<EnvContext> {
  const flagIndex = argv.indexOf("--env");
  const name = flagIndex >= 0 ? argv[flagIndex + 1] : process.env.ITERATE_ENV;
  if (!name) throw new Error("Pass --env <name> (e.g. --env preview_3). See envs.ts for the list.");
  const env = requireEnv(name);

  const secrets = loadDopplerSecrets(env.dopplerConfig);

  const accountId = secrets.CLOUDFLARE_ACCOUNT_ID;
  if (accountId !== env.cloudflareAccountId) {
    throw new Error(
      `Doppler config ${env.dopplerConfig} carries CLOUDFLARE_ACCOUNT_ID=${accountId} but envs.ts ` +
        `says ${name} lives in account ${env.cloudflareAccountId}. Fix whichever is wrong before proceeding.`,
    );
  }

  const cf = async (path: string, init?: RequestInit) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${secrets.CLOUDFLARE_API_TOKEN}`,
          ...(init?.body && typeof init.body === "string"
            ? { "content-type": "application/json" }
            : {}),
          ...init?.headers,
        },
      },
    );
    const body: any = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) {
      throw new Error(
        `Cloudflare API ${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 500)}`,
      );
    }
    return body.result;
  };

  return { name, env, secrets, cf };
}

/** Download a Doppler config's secrets (project scoping from apps/os doppler.yaml). */
export function loadDopplerSecrets(config: string): Record<string, string> {
  const result = spawnSync(
    "doppler",
    ["secrets", "download", "--no-file", "--format", "json", "--config", config],
    { cwd: APP_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`doppler secrets download --config ${config} failed: ${result.stderr?.trim()}`);
  }
  return JSON.parse(result.stdout);
}
