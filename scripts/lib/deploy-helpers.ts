/**
 * Shared primitives for the per-app deploy/ensure-resources/erase-data
 * scripts (apps/{os,auth,semaphore,tunnels,streams-example-app,dummy-petshop}/scripts).
 *
 * Each script stays an imperative top-to-bottom program; these are the
 * handful of moves they all make (spawn-and-fail-fast, smoke probes, the
 * wrangler secrets-file deploy dance, create-only Cloudflare resource
 * ensures, D1 wipes). Plain functions with explicit params — no config
 * machinery.
 */
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadDopplerSecrets, type DeployableEnv, type EnvContext } from "./env-context.ts";

/** The slice of EnvContext these helpers actually need: the Cloudflare API fetchers. */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf" | "cfV4">;

const SecretBindings = z.array(z.object({ name: z.string(), type: z.string() }));

/**
 * Spawn a command with inherited stdio and throw on a nonzero exit — the
 * fail-fast building block of every deploy script.
 */
export function run(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

/**
 * Probe a deployed URL until `ok(status)` holds (18 attempts, 5s apart ≈ 90s)
 * and throw when it never does — a deploy is only done once the env answers.
 *
 * The window is deliberately generous: a fresh worker version can answer 503
 * at the edge for tens of seconds while it propagates (measured 2026-07-09 on
 * preview slots: dashboard 503 for ~30-60s after a green `wrangler deploy`).
 * A success at attempt 12 costs nothing extra; giving up early fails the
 * whole deploy+e2e job, whose retry costs ~5 minutes.
 */
export async function smoke(url: string, ok: (status: number) => boolean, label: string) {
  await smokeResponse(url, (response) => ok(response.status), label);
}

/**
 * Response-aware variant of {@link smoke}. Use this when a status alone could
 * be produced by an edge/router fallback and the response body is part of the
 * deployment proof.
 */
export async function smokeResponse(
  url: string,
  ok: (response: Response) => boolean | Promise<boolean>,
  label: string,
) {
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (await ok(response)) {
        console.log(`smoke ok: ${label} (${url} → ${response.status})`);
        return;
      }
      console.warn(`smoke attempt ${attempt}: ${label} → ${response.status}`);
    } catch (error) {
      console.warn(`smoke attempt ${attempt}: ${label} → ${error}`);
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error(
    `Smoke failed: ${label} (${url}) never answered healthily — the deploy is NOT verified.`,
  );
}

/**
 * `wrangler deploy --secrets-file` with the secrets in a 0600 tmpfile that is
 * always cleaned up — code + secrets land atomically in one worker version.
 * Durable Object classes ride the same upload: the config's declarative
 * `exports` map is reconciled server-side per deploy, so a brand-new env's
 * first upload and a steady-state redeploy are the same single command (the
 * legacy migrations flow needed a classless bootstrap deploy first; exports
 * does not — verified live 2026-07-08).
 */
export async function deployWithSecrets(input: {
  /** App root the wrangler commands run in. */
  cwd: string;
  /** Path to the wrangler config to deploy (built dist config or wrangler.jsonc). */
  builtConfig: string;
  /** Secret name → value map shipped via --secrets-file. */
  secretValues: Record<string, string>;
  /** CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID for the wrangler process. */
  credentials: Record<string, string>;
  /** Extra `wrangler deploy` args (e.g. `["--env", name]` for env-block configs). */
  extraDeployArgs?: string[];
}) {
  const deployArgs = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    input.builtConfig,
    ...(input.extraDeployArgs ?? []),
  ];

  const secretsDir = mkdtempSync(join(tmpdir(), "deploy-secrets-"));
  try {
    const secretsFile = join(secretsDir, "secrets.json");
    writeFileSync(secretsFile, JSON.stringify(input.secretValues), { mode: 0o600 });
    run("pnpm", [...deployArgs, "--secrets-file", secretsFile], {
      cwd: input.cwd,
      env: input.credentials,
    });
  } finally {
    rmSync(secretsDir, { recursive: true, force: true });
  }
}

/**
 * Remove one retired secret from the currently deployed Worker, if present.
 *
 * `wrangler deploy --secrets-file` deliberately preserves omitted secrets, so
 * removing a name from generated config is not enough to revoke an existing
 * binding. Cloudflare's secret-delete API creates and immediately deploys a
 * new version of the same Worker without that binding. A second list makes
 * failure to revoke a hard deploy error rather than a silent credential leak.
 *
 * API: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/delete/
 * Deployment semantics: https://developers.cloudflare.com/workers/configuration/secrets/#delete-secrets-from-your-project
 * Omitted-secret semantics: https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code
 */
export async function deleteWorkerSecretIfPresent(input: {
  cf: (path: string, init?: RequestInit) => Promise<unknown>;
  workerName: string;
  secretName: string;
}): Promise<boolean> {
  const scriptPath = `/workers/scripts/${encodeURIComponent(input.workerName)}/secrets`;
  const current = SecretBindings.parse(await input.cf(scriptPath));
  if (!current.some((binding) => binding.name === input.secretName)) {
    console.log(`retired Worker secret absent: ${input.workerName}/${input.secretName}`);
    return false;
  }

  await input.cf(`${scriptPath}/${encodeURIComponent(input.secretName)}?url_encoded=true`, {
    method: "DELETE",
  });

  const remaining = SecretBindings.parse(await input.cf(scriptPath));
  if (remaining.some((binding) => binding.name === input.secretName)) {
    throw new Error(
      `Cloudflare reported success but retired Worker secret remains: ${input.workerName}/${input.secretName}`,
    );
  }
  console.log(`deleted retired Worker secret: ${input.workerName}/${input.secretName}`);
  return true;
}

/**
 * Delete a retired Doppler source only after its live runtime binding has been
 * revoked and verified. The second download catches inherited values or a
 * delete that targeted the wrong config; either condition keeps the deploy red.
 */
export function deleteDopplerSecretIfPresent(input: {
  project: string;
  config: string;
  secretName: string;
}): boolean {
  const current = loadDopplerSecrets(input.project, input.config);
  if (!Object.hasOwn(current, input.secretName)) {
    console.log(
      `retired Doppler secret absent: ${input.project}/${input.config}/${input.secretName}`,
    );
    return false;
  }

  const result = spawnSync(
    "doppler",
    [
      "secrets",
      "delete",
      input.secretName,
      "--project",
      input.project,
      "--config",
      input.config,
      "--yes",
      "--silent",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to delete retired Doppler secret ${input.project}/${input.config}/${input.secretName} (exit ${result.status}).`,
    );
  }

  const remaining = loadDopplerSecrets(input.project, input.config);
  if (Object.hasOwn(remaining, input.secretName)) {
    throw new Error(
      `Retired Doppler secret remains after deletion: ${input.project}/${input.config}/${input.secretName}`,
    );
  }
  console.log(
    `deleted retired Doppler secret: ${input.project}/${input.config}/${input.secretName}`,
  );
  return true;
}

/**
 * Find the single wrangler.json under dist/ a vite build produced and return
 * its absolute path — anything but exactly one match is a broken build.
 */
export function findBuiltWranglerConfig(appRoot: string): string {
  const builtConfigs = globSync("dist/**/wrangler.json", { cwd: appRoot });
  if (builtConfigs.length !== 1) {
    throw new Error(
      `Expected exactly one dist/**/wrangler.json from the build, found: ${builtConfigs.join(", ") || "none"}`,
    );
  }
  return join(appRoot, builtConfigs[0]);
}

/**
 * Collect the deploy's secret values from the env's Doppler config: every
 * `required` name must be present (throws listing all missing ones at once),
 * `optional` names ship only when the config carries a non-empty value.
 */
export function collectSecrets(
  ctx: { env: DeployableEnv; secrets: Record<string, string> },
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, string> {
  const secretValues: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of required) {
    const value = ctx.secrets[key];
    if (value === undefined || value === "") missing.push(key);
    else secretValues[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `Doppler config ${ctx.env.dopplerConfig} is missing required secrets: ${missing.join(", ")}. ` +
        `Set them (doppler secrets set --config ${ctx.env.dopplerConfig} ...) and retry.`,
    );
  }
  for (const key of optional) {
    const value = ctx.secrets[key];
    if (value) secretValues[key] = value;
  }
  return secretValues;
}

/**
 * Create-only D1 ensure: return the database named `name`, creating it when
 * missing. Never deletes or modifies an existing database.
 */
export async function ensureD1(
  ctx: CfContext,
  name: string,
): Promise<{ uuid: string; name: string }> {
  const databases = await ctx.cf<{ uuid: string; name: string }[]>(`/d1/database?per_page=1000`);
  const existing = databases.find((database) => database.name === name);
  if (existing) {
    console.log(`D1 database ${name} exists (${existing.uuid})`);
    return existing;
  }
  const created = await ctx.cf<{ uuid: string; name: string }>(`/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  console.log(`created D1 database ${name} (${created.uuid})`);
  return created;
}

/**
 * Create-only DNS ensure for a Worker-routed hostname: worker zone routes
 * only fire when a proxied DNS record answers the hostname, so create a
 * proxied originless AAAA (100::) when nothing exists. Any existing record
 * of any type counts as "exists" — we never fight an operator's hand-made
 * record. Warns (does not throw) when no zone in `zones` covers the host.
 */
export async function ensureProxiedDnsRecord(
  ctx: CfContext,
  zones: { id: string; name: string }[],
  host: string,
  comment: string,
) {
  // Wildcard hosts (`*.base`) match their zone by the bare name.
  const bare = host.replace(/^\*\./, "");
  const zone = zones.find(
    (candidate) => bare === candidate.name || bare.endsWith(`.${candidate.name}`),
  );
  if (!zone) {
    console.warn(`⚠ no zone for ${host} in this account — create the zone first, then re-run`);
    return;
  }
  const existing = await ctx.cfV4<unknown[]>(
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=5`,
  );
  if (existing.length > 0) {
    console.log(`DNS record for ${host} exists`);
    return;
  }
  await ctx.cfV4(`/zones/${zone.id}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "AAAA",
      name: host,
      content: "100::", // originless: traffic terminates at the Worker route
      proxied: true,
      comment,
    }),
  });
  console.log(`created proxied DNS record for ${host}`);
}

/**
 * Delete every row of every user table in a D1 database (skipping sqlite
 * internals, `_cf_*` and `d1_migrations`), logging per-table row counts.
 * One request = one session, so the pragma and every DELETE share a
 * transaction — FK ordering can't bite and the wipe is atomic. Schema and
 * migration history stay intact (rows are deleted, tables kept).
 */
export async function wipeD1Tables(ctx: CfContext, dbId: string) {
  const d1 = (sql: string) =>
    ctx.cf<{ results?: { name: string }[]; meta?: { changes?: number } }[]>(
      `/d1/database/${dbId}/query`,
      { method: "POST", body: JSON.stringify({ sql }) },
    );

  const tables = (
    await d1(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`,
    )
  )[0].results!;

  const wiped = await d1(
    [
      "PRAGMA defer_foreign_keys = on",
      ...tables.map((table) => `DELETE FROM "${table.name}"`),
    ].join("; "),
  );
  tables.forEach((table, index) => {
    console.log(`D1: cleared ${table.name} (${wiped[index + 1]?.meta?.changes ?? "?"} rows)`);
  });
}
