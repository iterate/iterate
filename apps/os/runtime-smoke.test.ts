/**
 * Default `pnpm test` checks local sqlfu assets only.
 * Full runtime checks require Cloudflare local/prod env: `pnpm test:smoke`
 * (`RUNTIME_SMOKE_FULL=1`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { x, type Result } from "tinyexec";
import { describe, expect, test } from "vitest";

const appRoot = dirname(fileURLToPath(import.meta.url));
const CF_DEV_PORT = 3015;
const hasCfWranglerLocal = existsSync(join(appRoot, ".alchemy/local/wrangler.jsonc"));
const runFullSmoke = process.env.RUNTIME_SMOKE_FULL === "1";
const describeRuntimeSmoke = process.env.CI ? describe.skip : describe.sequential;
/**
 * Fixture admin secret: `stripInheritedAppConfig` removes any Doppler-provided
 * `APP_CONFIG_ADMIN_API_SECRET` from the server's env, so the smoke bakes its
 * own known secret into `APP_CONFIG` (redacted field — never reaches
 * publicConfig).
 */
const SMOKE_ADMIN_API_SECRET = "runtime-smoke-admin-api-secret";
const smokeEnv = {
  APP_CONFIG: JSON.stringify({
    adminApiSecret: SMOKE_ADMIN_API_SECRET,
    openAiApiKey: "runtime-smoke-openai-key",
  }),
};

/** Drop inherited `APP_CONFIG` / `APP_CONFIG_*` so Doppler (or local shells) cannot override smoke fixtures. */
function stripInheritedAppConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) {
      delete next[key];
    }
  }
  return next;
}

function runWithDrainedOutput(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
      process.stdout.write(data);
    });

    child.stderr?.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
      process.stderr.write(data);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function parseAlchemyDeployUrl(output: string): string | undefined {
  const fromLog =
    output.match(/url:\s*'(https:\/\/[^']+)'/)?.[1] ??
    output.match(/url:\s*"(https:\/\/[^"]+)"/)?.[1];

  if (fromLog) {
    return fromLog.replace(/\/$/, "");
  }

  const workers = output.match(/(https:\/\/[a-z0-9][-a-z0-9.]*\.workers\.dev)\/?/i);
  return workers?.[1]?.replace(/\/$/, "");
}

async function assertSsrHtml(httpBaseUrl: string) {
  const res = await fetch(new URL("/sign-in", httpBaseUrl), {
    signal: AbortSignal.timeout(3_000),
  });

  expect(res.ok).toBe(true);

  const html = await res.text();
  expect(html).toContain("Sign in to OS");
}

/** The plain `/api/health` route that replaced the oRPC `__internal.health` procedure. */
async function assertHealthRoute(httpBaseUrl: string) {
  const res = await fetch(new URL("/api/health", httpBaseUrl), {
    signal: AbortSignal.timeout(3_000),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { ok?: unknown; app?: unknown };
  expect(body.ok).toBe(true);
  expect(body.app).toBe("os");
}

async function assertFullStack(httpBaseUrl: string) {
  await assertSsrHtml(httpBaseUrl);
  await assertHealthRoute(httpBaseUrl);
}

async function waitForReady(httpBaseUrl: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/sign-in", httpBaseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok && (await res.text()).includes("Sign in to OS")) {
        return;
      }
      last = new Error(`GET /sign-in -> ${res.status}`);
    } catch (error) {
      last = error;
    }

    await delay(300);
  }

  throw last;
}

async function readChildOutput(child: Result) {
  try {
    const result = await Promise.resolve(child);
    return `${result.stdout}${result.stderr}`;
  } catch (childError) {
    if (childError instanceof Error && "output" in childError) {
      const output = childError.output as { stdout?: string; stderr?: string };
      return `${output.stdout ?? ""}${output.stderr ?? ""}`;
    }

    return childError instanceof Error ? childError.message : String(childError);
  }
}

async function stopService(child: Result) {
  if (child.exitCode !== null || child.killed) return;

  child.kill("SIGTERM");
  await Promise.race([
    Promise.resolve(child).then(
      () => undefined,
      () => undefined,
    ),
    delay(3_000).then(() => child.kill("SIGKILL")),
  ]);
}

async function withServer(
  command: string,
  args: string[],
  env: Record<string, string>,
  httpBaseUrl: string,
  run: () => Promise<void>,
) {
  const child = x(command, args, {
    persist: true,
    throwOnError: false,
    nodeOptions: {
      cwd: appRoot,
      env: { ...stripInheritedAppConfig(process.env), ...env },
      stdio: "pipe",
    },
  });

  try {
    await waitForReady(httpBaseUrl);
    await run();
  } catch (error) {
    child.kill("SIGTERM");
    const output = await readChildOutput(child);
    throw new Error(`${String(error)}\n--- server log ---\n${output}`);
  } finally {
    await stopService(child);
  }
}

describe("sqlfu assets", () => {
  test("generated query and migration bundles exist", () => {
    expect(existsSync(join(appRoot, "src/db/queries/.generated/index.ts"))).toBe(true);
    expect(existsSync(join(appRoot, "src/db/migrations/.generated/migrations.ts"))).toBe(true);
  });
});

describeRuntimeSmoke("runtime smoke", () => {
  test.skipIf(!runFullSmoke || !hasCfWranglerLocal)("pnpm cf:dev", async () => {
    const base = `http://127.0.0.1:${CF_DEV_PORT}`;
    await withServer("pnpm", ["run", "cf:dev"], smokeEnv, base, () => assertFullStack(base));
  });

  test.skipIf(!runFullSmoke)(
    "pnpm cf:deploy",
    async () => {
      const { code, output } = await runWithDrainedOutput("pnpm", ["run", "cf:deploy"], {
        cwd: appRoot,
        env: { ...stripInheritedAppConfig(process.env), ...smokeEnv },
      });

      if (code !== 0) {
        throw new Error(`cf:deploy exited with code ${code}`);
      }

      const deployUrl = parseAlchemyDeployUrl(output);
      if (!deployUrl) {
        throw new Error(`Could not find deployed workers.dev URL in cf:deploy output:\n${output}`);
      }

      await assertFullStack(deployUrl);
    },
    600_000,
  );
});
