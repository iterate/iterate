/**
 * Runtime smoke: boots the OS dev server and
 * probes SSR, `/api/health`, and itx admin auth. Skipped by default and in
 * CI — run `pnpm test:smoke` (`RUNTIME_SMOKE_FULL=1`) locally.
 */
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { x, type Result } from "tinyexec";
import { describe, expect, test } from "vitest";

const appRoot = dirname(fileURLToPath(import.meta.url));
const CF_DEV_PORT = 3015;
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

/**
 * Operator sessions are the HTTP-visible browser auth gate on the api worker.
 * Probe anonymous rejection, issuance with the matching deployment secret,
 * same-origin redemption, and the hardened cookie attributes.
 */
async function assertItxAdminAuth(httpBaseUrl: string) {
  const sessionsUrl = new URL("/api/operator-sessions", httpBaseUrl);

  const anonymous = await fetch(sessionsUrl, {
    body: JSON.stringify({ kind: "admin", operatorId: "runtime-smoke" }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  expect(anonymous.status).toBe(401);

  const admin = await fetch(sessionsUrl, {
    body: JSON.stringify({ kind: "admin", operatorId: "runtime-smoke" }),
    headers: {
      authorization: `Bearer ${SMOKE_ADMIN_API_SECRET}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  expect(admin.status, await admin.clone().text()).toBe(200);
  const issued = (await admin.json()) as { browserUrl?: unknown; token?: unknown };
  expect(typeof issued.browserUrl).toBe("string");
  expect(issued.browserUrl).toContain("/api/operator-sessions/redeem#token=");
  expect(issued.browserUrl).not.toContain(SMOKE_ADMIN_API_SECRET);
  expect(typeof issued.token).toBe("string");

  const redeemUrl = new URL("/api/operator-sessions/redeem", httpBaseUrl);
  const crossOrigin = await fetch(redeemUrl, {
    body: issued.token as string,
    headers: { "content-type": "text/plain", origin: "https://attacker.example" },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  expect(crossOrigin.status).toBe(403);

  const redeemed = await fetch(redeemUrl, {
    body: issued.token as string,
    headers: { "content-type": "text/plain", origin: new URL(httpBaseUrl).origin },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  expect(redeemed.status, await redeemed.clone().text()).toBe(200);
  const cookie = redeemed.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("iterate-operator-session=");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).not.toContain(SMOKE_ADMIN_API_SECRET);
}

async function assertFullStack(httpBaseUrl: string) {
  await assertSsrHtml(httpBaseUrl);
  await assertHealthRoute(httpBaseUrl);
  await assertItxAdminAuth(httpBaseUrl);
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

describeRuntimeSmoke("runtime smoke", () => {
  test.skipIf(!runFullSmoke)("OS local dev server", async () => {
    const base = `http://127.0.0.1:${CF_DEV_PORT}`;
    await withServer(
      "pnpm",
      ["exec", "tsx", "./scripts/dev.ts", "start", "--skip-doppler"],
      {
        ...smokeEnv,
        PORT: String(CF_DEV_PORT),
      },
      base,
      () => assertFullStack(base),
    );
  });
});
