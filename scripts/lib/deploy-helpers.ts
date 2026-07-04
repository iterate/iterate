/**
 * Shared primitives for the per-app deploy/ensure-resources/erase-data
 * scripts (apps/{os,auth,semaphore,tunnels,streams-example-app}/scripts).
 *
 * Each script stays an imperative top-to-bottom program; these are the
 * handful of moves they all make (spawn-and-fail-fast, smoke probes, the
 * wrangler secrets-file deploy dance, create-only Cloudflare resource
 * ensures, D1 wipes). Plain functions with explicit params — no config
 * machinery.
 */
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeployableEnv, EnvContext } from "./env-context.ts";

/** The slice of EnvContext these helpers actually need: the Cloudflare API fetchers. */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf" | "cfV4">;

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
 * Probe a deployed URL until `ok(status)` holds (5 attempts, 3s apart) and
 * throw when it never does — a deploy is only done once the env answers.
 */
export async function smoke(url: string, ok: (status: number) => boolean, label: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (ok(response.status)) {
        console.log(`smoke ok: ${label} (${url} → ${response.status})`);
        return;
      }
      console.warn(`smoke attempt ${attempt}: ${label} → ${response.status}`);
    } catch (error) {
      console.warn(`smoke attempt ${attempt}: ${label} → ${error}`);
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(
    `Smoke failed: ${label} (${url}) never answered healthily — the deploy is NOT verified.`,
  );
}

/**
 * Adopt a Durable Object migration tag on an alchemy-era worker script.
 *
 * Alchemy-era scripts carry live Durable Object classes but a null
 * migration_tag (alchemy submitted untagged migration steps). Deploying
 * wrangler.jsonc's `migrations: [{tag:"v1", …}]` over such a script fails
 * with "Cannot apply new-sqlite-class migration to class … that is already
 * depended on" (code 10074). The fix, verified empirically 2026-07-03: a
 * settings PATCH with an empty tagged migration adopts the tag without
 * touching classes; wrangler then sees old_tag v1 and submits no steps.
 * No-op for fresh scripts (absent) and already-adopted ones.
 *
 * TRANSITION: delete once every env in envs.ts has deployed post-alchemy.
 */
export async function adoptDoMigrationTag(ctx: CfContext, workerName: string) {
  const scripts = await ctx.cf<{ id: string; migration_tag: string | null }[]>(
    `/workers/scripts?per_page=1000`,
  );
  const script = scripts.find((candidate) => candidate.id === workerName);
  // Loose != also catches the list endpoint omitting the field (undefined).
  if (!script || script.migration_tag != null) return;
  console.log(`Adopting DO migration tag v1 on ${workerName} (was untagged/alchemy-era)`);
  const form = new FormData();
  form.set("settings", JSON.stringify({ migrations: { new_tag: "v1", steps: [] } }));
  await ctx.cf(`/workers/scripts/${workerName}/settings`, {
    method: "PATCH",
    body: form,
  });
}

/**
 * `wrangler deploy --secrets-file` with the secrets in a 0600 tmpfile that is
 * always cleaned up — code + secrets land atomically in one worker version.
 *
 * When `ensureClassesFor` is given, first checks the live worker for Durable
 * Object bindings and runs a plain (secrets-less) deploy when there are none.
 * Gotcha (observed live 2026-07-03): a worker with NO Durable Object classes
 * yet (fresh, or an alchemy-era "parked" placeholder) fails
 * `wrangler deploy --secrets-file` with 10061 — initial class migrations
 * don't ride that upload path. The plain deploy establishes the classes
 * (existing secrets are preserved across versions), then the secrets deploy
 * lands code+secrets atomically as usual. Apps without DO classes skip it.
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
  /** DO-class-carrying apps pass this to get the plain-deploy-first guard. */
  ensureClassesFor?: { ctx: CfContext; workerName: string };
}) {
  const deployArgs = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    input.builtConfig,
    ...(input.extraDeployArgs ?? []),
  ];

  if (input.ensureClassesFor) {
    const { ctx, workerName } = input.ensureClassesFor;
    const remote = await ctx
      .cf<{ bindings?: { type: string }[] }>(`/workers/scripts/${workerName}/settings`)
      .catch(() => null);
    if (!remote?.bindings?.some((binding) => binding.type === "durable_object_namespace")) {
      console.log(
        "Worker has no Durable Object classes yet — plain deploy first to establish them.",
      );
      // The bootstrap deploy carries no --secrets-file, and a classless
      // worker has no existing secrets either — wrangler's secrets.required
      // enforcement would fail it. Deploy from a config copy without the
      // `secrets` block; the real deploy below re-enforces it.
      const { secrets: _secrets, ...config } = JSON.parse(readFileSync(input.builtConfig, "utf8"));
      // Wrangler resolves relative paths (assets, containers) against the
      // config's directory, so the copy must live next to the original.
      const bootstrapConfig = join(dirname(input.builtConfig), "wrangler.bootstrap.json");
      writeFileSync(bootstrapConfig, JSON.stringify(config));
      try {
        run(
          "pnpm",
          [
            "exec",
            "wrangler",
            "deploy",
            "--config",
            bootstrapConfig,
            ...(input.extraDeployArgs ?? []),
          ],
          { cwd: input.cwd, env: input.credentials },
        );
      } finally {
        rmSync(bootstrapConfig, { force: true });
      }
    }
  }

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
  required: string[],
  optional: string[] = [],
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
