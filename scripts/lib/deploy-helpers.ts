/**
 * Shared primitives for the per-app deploy/ensure-resources
 * scripts (apps/{os,auth,semaphore,tunnels,streams-example-app,dummy-petshop}/scripts).
 *
 * Each script stays an imperative top-to-bottom program; these are the
 * handful of moves they all make (spawn-and-fail-fast, smoke probes, the
 * wrangler secrets-file deploy dance, and DNS ensures). Plain functions with
 * explicit params — no config machinery.
 */
import { spawn, spawnSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployableEnv, EnvContext } from "./env-context.ts";

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
export async function smoke(
  url: string,
  ok: (status: number) => boolean,
  label: string,
  headers?: Record<string, string>,
) {
  await smokeResponse(url, (response) => ok(response.status), label, headers);
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
  headers?: Record<string, string>,
) {
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
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
 * Create-only DNS ensure for a Worker-routed hostname: worker zone routes
 * only fire when a proxied DNS record answers the hostname, so create a
 * proxied originless AAAA (100::) when nothing exists. Any existing record
 * of any type counts as "exists" — we never fight an operator's hand-made
 * record. Warns (does not throw) when no zone in `zones` covers the host.
 */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf" | "cfV4">;

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
