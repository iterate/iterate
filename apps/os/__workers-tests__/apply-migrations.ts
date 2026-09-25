// __workers-tests__/apply-migrations.ts — every Workers-suite file's setup: the control plane's D1,
// empty in each file's own storage, migrated as a deployment's is (vitest.config.ts reads the
// migrations; `applyD1Migrations` applies each one with its history row in one batch).
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
