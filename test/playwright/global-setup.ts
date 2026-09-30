import { fileURLToPath } from "node:url";
import { z } from "zod";
import { deployedTarget } from "../helpers/deployed-target.ts";
import { checkoutPublishedPackageCommit } from "../../apps/os/scripts/published-package-commit.ts";
import { OsPlaywrightAuthEnv } from "../helpers/auth-config.ts";
import { workerBaseUrl } from "../helpers/worker-base-url.ts";

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
  // the pkg.pr.new commit of this checkout's packages (published-package-commit.ts), which the specs
  // that install one wait for: worked out once, since in a shallow CI checkout it fetches history
  process.env.PUBLISHED_PACKAGE_COMMIT = checkoutPublishedPackageCommit(
    fileURLToPath(new URL("../..", import.meta.url)),
    process.env.PREVIEW_HEAD_SHA,
  );
  console.log(`[playwright] auth setup complete (${Date.now() - startedAt}ms)`);
}

/** A local worker (apps/os/scripts/dev.ts) has fixed dev credentials and routes projects by
 *  subdomain under localhost. A deployment's come out of its own `APP_CONFIG` under `doppler run`
 *  (test/helpers/deployed-target.ts, which the vitest e2e suite reads too). */
function osTargetEnv(): Record<string, string> {
  if (new URL(workerBaseUrl).hostname === "localhost") {
    return {
      APP_CONFIG_SECRETS__ADMIN_BEARER: "dev-admin-api-secret",
      LOGIN_PASSWORD: "dev",
      PROJECT_INGRESS_ROUTING: JSON.stringify({ type: "subdomains", hostname: "localhost" }),
      MCP_BASE_URL: `${workerBaseUrl}/mcp`,
    };
  }
  const target = deployedTarget(workerBaseUrl);
  return {
    APP_CONFIG_SECRETS__ADMIN_BEARER: target.adminBearer,
    LOGIN_PASSWORD: target.loginPassword,
    PROJECT_INGRESS_ROUTING: target.ingressRouting,
    MCP_BASE_URL: target.mcpBaseUrl,
  };
}
