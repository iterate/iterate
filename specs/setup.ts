import { z } from "zod";
import { deployedTarget } from "../apps/os/e2e/support/deployed-target.ts";
import { OsPlaywrightAuthEnv } from "./test-support/auth-config.ts";

/** Runs once before test workers; their environments inherit the prepared values. */
export default function setup() {
  const startedAt = Date.now();
  let targetEnv: Record<string, string>;
  try {
    targetEnv = osTargetEnv();
  } catch (error) {
    throw new Error(
      [
        "Playwright auth setup failed. Run with `doppler run --project os --config preview -- pnpm spec` against a preview.",
        error instanceof Error ? error.message : String(error),
      ].join("\n\n"),
    );
  }
  const env = OsPlaywrightAuthEnv.safeParse(targetEnv);
  if (!env.success)
    throw new Error(
      "Playwright auth setup failed: the OS deployment's APP_CONFIG does not supply valid auth settings.\n" +
        z.prettifyError(env.error),
    );
  Object.assign(process.env, env.data);
  console.log(`[playwright] auth setup complete (${Date.now() - startedAt}ms)`);
}

/** A local worker (apps/os/scripts/dev.ts) has fixed dev credentials and routes projects by
 *  subdomain under localhost. A deployment's come out of its own `APP_CONFIG` under `doppler run`
 *  (apps/os/e2e/support/deployed-target.ts, which the vitest e2e suite reads too). */
function osTargetEnv(): Record<string, string> {
  const origin = new URL(
    process.env.WORKER_BASE_URL || `http://localhost:${process.env.DEMO_PORT || 8788}`,
  ).origin;
  if (new URL(origin).hostname === "localhost") {
    return {
      ADMIN_API_SECRET: "dev-admin-api-secret",
      LOGIN_PASSWORD: "dev",
      PROJECT_INGRESS_ROUTING: JSON.stringify({ type: "subdomains", hostname: "localhost" }),
      MCP_BASE_URL: `${origin}/mcp`,
      OS_BASE_URL: origin,
    };
  }
  const target = deployedTarget(origin);
  return {
    ADMIN_API_SECRET: target.adminApiSecret,
    LOGIN_PASSWORD: target.loginPassword,
    PROJECT_INGRESS_ROUTING: target.ingressRouting,
    MCP_BASE_URL: target.mcpBaseUrl,
    OS_BASE_URL: origin,
  };
}
