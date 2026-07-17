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
import { CloudflareApiError, type DeployableEnv, type EnvContext } from "./env-context.ts";

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
 * Refuse to deploy while a forbidden secret remains bound to the Worker.
 *
 * `wrangler deploy --secrets-file` deliberately preserves omitted secrets, so
 * removing a name from generated config is not enough to prove it is absent.
 * This is an assertion, not migration machinery: remediation is an explicit
 * operator action, and a normal deploy never mutates credential state.
 *
 * Omitted-secret semantics: https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code
 */
export async function assertWorkerSecretAbsent(input: {
  cf: (path: string, init?: RequestInit) => Promise<unknown>;
  workerName: string;
  secretName: string;
}): Promise<void> {
  const scriptPath = `/workers/scripts/${encodeURIComponent(input.workerName)}/secrets`;
  let current: z.infer<typeof SecretBindings>;
  try {
    current = SecretBindings.parse(await input.cf(scriptPath));
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      console.log(
        `Worker not created; forbidden secret absent: ${input.workerName}/${input.secretName}`,
      );
      return;
    }
    throw error;
  }
  if (current.some((binding) => binding.name === input.secretName)) {
    throw new Error(
      `Forbidden Worker secret is present: ${input.workerName}/${input.secretName}. Remove it explicitly before deploying.`,
    );
  }

  console.log(`forbidden Worker secret absent: ${input.workerName}/${input.secretName}`);
}

/**
 * Remove an explicit allowlist of retired secrets from an existing Worker and
 * prove they are absent afterwards. This belongs only in destructive
 * erase/handover flows; normal deploys use {@link assertWorkerSecretAbsent}
 * and never mutate credential state.
 */
export async function removeWorkerSecrets(input: {
  cf: (path: string, init?: RequestInit) => Promise<unknown>;
  workerName: string;
  secretNames: readonly string[];
}): Promise<string[]> {
  const scriptPath = `/workers/scripts/${encodeURIComponent(input.workerName)}/secrets`;
  let current: z.infer<typeof SecretBindings>;
  try {
    current = SecretBindings.parse(await input.cf(scriptPath));
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      console.log(`Worker not created; no retired secrets to remove: ${input.workerName}`);
      return [];
    }
    throw error;
  }

  const retired = new Set(input.secretNames);
  const present = current
    .map((binding) => binding.name)
    .filter((name) => retired.has(name))
    .sort();
  for (const secretName of present) {
    await input.cf(`${scriptPath}/${encodeURIComponent(secretName)}`, { method: "DELETE" });
    console.log(`removed retired Worker secret: ${input.workerName}/${secretName}`);
  }

  if (present.length === 0) {
    console.log(`retired Worker secrets absent: ${input.workerName}`);
    return [];
  }

  const remaining = SecretBindings.parse(await input.cf(scriptPath));
  const stale = remaining
    .map((binding) => binding.name)
    .filter((name) => retired.has(name))
    .sort();
  if (stale.length > 0) {
    throw new Error(
      `Retired Worker secrets remain after deletion: ${input.workerName}/${stale.join(", ")}`,
    );
  }
  console.log(`verified retired Worker secrets absent: ${input.workerName}`);
  return present;
}

/**
 * Refuse to deploy when the resolved Doppler config contains a forbidden
 * secret. Checking the already-resolved config catches direct and inherited
 * values without issuing a second download or exposing the value.
 */
export function assertDopplerSecretAbsent(input: {
  project: string;
  config: string;
  secretName: string;
  secrets: Record<string, string>;
}): void {
  if (Object.hasOwn(input.secrets, input.secretName)) {
    throw new Error(
      `Forbidden Doppler secret is present: ${input.project}/${input.config}/${input.secretName}. Remove it explicitly before deploying.`,
    );
  }
  console.log(
    `forbidden Doppler secret absent: ${input.project}/${input.config}/${input.secretName}`,
  );
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
 * One TTL to rule the preview fleet: a preview slot's disposable data (search
 * corpus, project files, sandbox backups) is expired 3 hours after it was last
 * written. Short because previews are synthetic and churn constantly, and the
 * whole point is cost — abandoned data should not linger. Prd keeps its own,
 * much longer retention (see `SANDBOX_BACKUP_TTL_SECONDS_PRD`); this constant
 * is never applied there. See docs/preview-resource-gc.md.
 */
export const PREVIEW_DISPOSABLE_TTL_SECONDS = 3 * 60 * 60;

/** Prd sandbox workspace backups: 90 days, matching the DO's SANDBOX_BACKUP_TTL_SECONDS. */
export const SANDBOX_BACKUP_TTL_SECONDS_PRD = 90 * 24 * 60 * 60;

/**
 * The sandbox workspace backup expiry rule — shared id + `backups/` prefix so
 * ensure-resources and erase-data install the SAME rule (the ttl differs: 3h on
 * preview, 90 days on prd). Sandboxes snapshot `/workspace` under `backups/`
 * and the DO only checks the ttl at restore time, so this rule is what actually
 * reaps them.
 */
export const SANDBOX_BACKUP_EXPIRY_RULE = {
  ruleId: "expire-sandbox-workspace-backups",
  prefix: "backups/",
} as const;

/**
 * The disposable per-slot R2 corpus (the itx.search `-search-index` bucket):
 * pure derived state the worker re-mirrors, which on a churned preview slot
 * grows to thousands of objects. Erasing it object-by-object is the single
 * biggest source of the cleanup 429 storm that used to leak preview leases
 * (2026-07-15: 1521 objects, rate-limited mid-delete). Preview slots let R2
 * lifecycle expire it server-side — zero control-plane calls — and skip the
 * object walk in erase-data. NOT applied to prd, whose corpus must persist.
 */
export const PREVIEW_SEARCH_INDEX_OBJECT_EXPIRY = {
  ruleId: "expire-preview-search-index",
  ttlSeconds: PREVIEW_DISPOSABLE_TTL_SECONDS,
} as const;

/** Preview project-file storage (itx.files): same disposable 3h expiry as the corpus. */
export const PREVIEW_FILES_OBJECT_EXPIRY = {
  ruleId: "expire-preview-files",
  ttlSeconds: PREVIEW_DISPOSABLE_TTL_SECONDS,
} as const;

/**
 * Pure builder for a "delete every matching object `ttlSeconds` after it was
 * written" R2 lifecycle policy. `prefix` scopes the rule; an empty prefix (the
 * default) covers all objects/uploads, per the R2 lifecycle API. The Age
 * transition takes seconds.
 */
export function buildR2ObjectExpiryLifecycleRules(input: {
  ruleId: string;
  ttlSeconds: number;
  prefix?: string;
}) {
  return [
    {
      id: input.ruleId,
      enabled: true,
      conditions: { prefix: input.prefix ?? "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: input.ttlSeconds } },
    },
  ];
}

/**
 * Put a single "expire matching objects after `ttlSeconds`" lifecycle rule on
 * an R2 bucket, so Cloudflare garbage-collects the objects server-side instead
 * of erase-data walking the bucket with one rate-limited DELETE per object. PUT
 * replaces the bucket's lifecycle config wholesale — fine while this is the
 * only rule the target buckets carry.
 */
export async function ensureR2ObjectExpiryLifecycle(
  ctx: CfContext,
  bucketName: string,
  input: { ruleId: string; ttlSeconds: number; prefix?: string },
): Promise<void> {
  await ctx.cf(`/r2/buckets/${bucketName}/lifecycle`, {
    method: "PUT",
    body: JSON.stringify({ rules: buildR2ObjectExpiryLifecycleRules(input) }),
  });
  console.log(
    `R2 bucket ${bucketName} lifecycle: objects under "${input.prefix ?? ""}" expire ${input.ttlSeconds}s after write (${input.ruleId})`,
  );
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
