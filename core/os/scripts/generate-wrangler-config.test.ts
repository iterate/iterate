import { expect, test } from "vitest";
import { deploymentFromEnv, viteWranglerConfig } from "./generate-wrangler-config.ts";
import type { OsDeployableEnv } from "./os-env.ts";

// A deployment's Artifacts namespace, R2 bucket and D1 are `<resourceNamePrefix>-…`, the self-host
// config's prefix being `iterate` (./os-env.ts `osResourceNames`). iterate's own deployments' names
// are pinned with the rest of its tooling (scripts/os/preview.test.ts).
test("a deployment binds its resource name prefix's repos, files and db", () => {
  expect(viteWranglerConfig(acme, { localDev: false, port: "0" })).toMatchObject({
    artifacts: [{ binding: "ARTIFACTS", namespace: "acme-os-repos" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "acme-os-files" }],
    d1_databases: [{ binding: "DB", database_name: "acme-os-db" }],
  });
});

test("the self-host config binds iterate-repos, iterate-files and iterate-db", () => {
  expect(viteWranglerConfig("self-host", { localDev: false, port: "0" })).toMatchObject({
    artifacts: [{ binding: "ARTIFACTS", namespace: "iterate-repos" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "iterate-files" }],
    d1_databases: [{ binding: "DB", database_name: "iterate-db" }],
  });
});

test("a build gets its deployment from OS_DEPLOYMENT, as build.ts viteBuildOs hands it over", () => {
  expect(
    deploymentFromEnv({ CLOUDFLARE_ENV: "acme", OS_DEPLOYMENT: JSON.stringify(acme) }),
  ).toEqual(acme);
  expect(deploymentFromEnv({ CLOUDFLARE_ENV: "self-host" })).toBe("self-host");
  expect(deploymentFromEnv({ CLOUDFLARE_ENV: "" })).toBeUndefined();
  expect(deploymentFromEnv({})).toBeUndefined();
});

test("a named build without its deployment fails, rather than looking the name up", () => {
  expect(() => deploymentFromEnv({ CLOUDFLARE_ENV: "acme" })).toThrow(
    "core/os: CLOUDFLARE_ENV=acme needs OS_DEPLOYMENT",
  );
  expect(() =>
    deploymentFromEnv({ CLOUDFLARE_ENV: "prd", OS_DEPLOYMENT: JSON.stringify(acme) }),
  ).toThrow('core/os: CLOUDFLARE_ENV=prd but OS_DEPLOYMENT is "acme"');
  expect(() =>
    deploymentFromEnv({
      CLOUDFLARE_ENV: "acme",
      OS_DEPLOYMENT: JSON.stringify({ name: "acme", workerName: "acme-os" }),
    }),
  ).toThrow(/cloudflareAccountId/);
});

/** A deployment as its caller hands one over: someone's own, on their own account. */
const acme: OsDeployableEnv = {
  name: "acme",
  cloudflareAccountId: "0123456789abcdef0123456789abcdef",
  dopplerConfig: "acme",
  workerName: "acme-os",
  baseUrl: "https://os.acme.test",
  mcpBaseUrl: "https://os.acme.test/mcp",
  resourceNamePrefix: "acme-os",
};
