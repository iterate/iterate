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
import { spawn, spawnSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CloudflareApiError, type DeployableEnv, type EnvContext } from "./env-context.ts";

/** The slice of EnvContext these helpers actually need: the Cloudflare API fetchers. */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf" | "cfV4">;

const SecretBindings = z.array(z.object({ name: z.string(), type: z.string() }));
// Wrangler does not expose Retry-After, but a direct API call in the same live
// incident returned 120s. The final attempt therefore lands just beyond that
// observed window instead of exhausting the budget at 110s.
const CLOUDFLARE_COMMAND_429_BACKOFF_MS = [5_000, 15_000, 30_000, 75_000] as const;
const CAPTURED_COMMAND_OUTPUT_LIMIT = 64 * 1024;

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
 * Async sibling of {@link run} for the rare deploy steps that deliberately
 * overlap independent host work. Output stays attached to the parent and a
 * nonzero exit still rejects loudly; callers must await the returned promise
 * before mutating the deployed Worker.
 */
export function runAsync(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<void> {
  console.log(`$ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: "inherit",
      env: { ...process.env, ...opts.env },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
          ),
        );
      }
    });
  });
}

/**
 * Run one Cloudflare CLI command with a bounded retry for an explicit HTTP
 * 429. Wrangler retries some API calls itself, but not the Worker service and
 * version lookups performed by `wrangler deploy`; a shared-account rate-limit
 * window otherwise makes parallel preview deploys fail at random.
 *
 * Output remains live and only a bounded tail is retained for classification.
 * Every non-429 failure surfaces immediately, and the final 429 still fails
 * after the same 5-attempt schedule used by our direct Cloudflare fetches.
 */
export async function runCloudflareCommandWith429Retry(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
  retryOpts: {
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const backoffMs = retryOpts.backoffMs ?? CLOUDFLARE_COMMAND_429_BACKOFF_MS;
  const sleep =
    retryOpts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= backoffMs.length + 1; attempt++) {
    const result = await runStreamingCaptured(command, args, opts);
    if (result.code === 0) {
      return;
    }

    const failure = new Error(
      `${command} ${args.join(" ")} exited with ${result.code ?? `signal ${result.signal ?? "unknown"}`}`,
    );
    const rateLimitIndex = result.output.lastIndexOf("429 Too Many Requests");
    const terminalErrorIndex = result.output.lastIndexOf("ERROR");
    const isRateLimited =
      rateLimitIndex >= 0 && (terminalErrorIndex < 0 || rateLimitIndex > terminalErrorIndex);
    if (!isRateLimited || attempt > backoffMs.length) {
      throw failure;
    }

    const delayMs = backoffMs[attempt - 1];
    console.warn(
      `Cloudflare API rate limited (429) during ${command} ${args.join(" ")} ` +
        `(attempt ${attempt}/${backoffMs.length + 1}); retrying command in ${Math.round(delayMs / 1000)}s...`,
    );
    await sleep(delayMs);
  }
}

async function runStreamingCaptured(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  console.log(`$ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    let output = "";
    const relay = (destination: NodeJS.WriteStream) => (chunk: Buffer) => {
      destination.write(chunk);
      output = `${output}${chunk.toString("utf8")}`.slice(-CAPTURED_COMMAND_OUTPUT_LIMIT);
    };
    child.stdout.on("data", relay(process.stdout));
    child.stderr.on("data", relay(process.stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
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
    await runCloudflareCommandWith429Retry("pnpm", [...deployArgs, "--secrets-file", secretsFile], {
      cwd: input.cwd,
      env: input.credentials,
    });
  } finally {
    rmSync(secretsDir, { recursive: true, force: true });
  }
}

/**
 * Remove an explicit allowlist of retired secrets from an existing Worker and
 * prove they are absent afterwards (fails if a deletion does not stick).
 *
 * `wrangler deploy --secrets-file` deliberately preserves omitted secrets
 * (https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code),
 * so removing a name from generated config is not enough. Deploy scripts are
 * the ONLY writers of Worker secrets, which is why normal deploys may run
 * this convergence rather than fail closed: a lingering retired name can
 * only mean the Worker was last deployed by older code. Doppler-side
 * retirement stays an assertion ({@link assertDopplerSecretAbsent}) because
 * Doppler is human-edited — a reappearance there is drift for a human.
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

  if (!present.length) {
    console.log(`retired Worker secrets absent: ${input.workerName}`);
    return [];
  }

  const remaining = SecretBindings.parse(await input.cf(scriptPath));
  const stale = remaining
    .map((binding) => binding.name)
    .filter((name) => retired.has(name))
    .sort();
  if (stale.length) {
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
    if (!value || value === "") missing.push(key);
    else secretValues[key] = value;
  }
  if (missing.length) {
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

/** Preview project-file storage (itx.files) expires after 3h. */
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
  // per_page must exceed the records a routed apex accumulates (A plus Email
  // Routing MX/TXT can pass 5, which trips the paginate guard in cfV4).
  const existing = await ctx.cfV4<unknown[]>(
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=50`,
  );
  if (existing.length) {
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
