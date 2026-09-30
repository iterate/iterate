import { expect, test } from "vitest";
import { getOsEnv } from "../../../envs.ts";
import { deploymentFromEnv, viteWranglerConfig } from "./generate-wrangler-config.ts";

// Every deployment's Artifacts namespace, R2 bucket and D1 are `<resourceNamePrefix>-…`, the
// self-host config's prefix being `iterate` (./os-env.ts `osResourceNames`).
test.for([
  { name: "prd", repos: "os-prd-repos", files: "os-prd-files", db: "os-prd-db" },
  { name: "preview", repos: "os-parent-repos", files: "os-parent-files", db: "os-parent-db" },
  {
    name: "pr3144-a1b2c3d",
    repos: "pr3144-a1b2c3d-os-repos",
    files: "pr3144-a1b2c3d-os-files",
    db: "pr3144-a1b2c3d-os-db",
  },
  { name: "self-host", repos: "iterate-repos", files: "iterate-files", db: "iterate-db" },
])("$name binds $repos, $files and $db", ({ name, repos, files, db }) => {
  const deployment = name === "self-host" ? name : getOsEnv(name);
  if (deployment === "self-host") {
    expect(() => viteWranglerConfig(deployment, { localDev: false, port: "0" })).toThrow(
      "self-host build needs ITERATE_SELF_HOST_ORIGIN",
    );
    return;
  }
  expect(viteWranglerConfig(deployment, { localDev: false, port: "0" })).toMatchObject({
    artifacts: [{ binding: "ARTIFACTS", namespace: repos }],
    r2_buckets: [{ binding: "FILES", bucket_name: files }],
    d1_databases: [{ binding: "DB", database_name: db }],
  });
});

test("a build gets its deployment from OS_DEPLOYMENT, as build.ts viteBuildOs hands it over", () => {
  const prd = getOsEnv("prd");
  expect(deploymentFromEnv({ CLOUDFLARE_ENV: "prd", OS_DEPLOYMENT: JSON.stringify(prd) })).toEqual(
    prd,
  );
  expect(deploymentFromEnv({ CLOUDFLARE_ENV: "self-host" })).toBe("self-host");
  expect(deploymentFromEnv({ CLOUDFLARE_ENV: "" })).toBeUndefined();
  expect(deploymentFromEnv({})).toBeUndefined();
});

test("a named build without its deployment fails, rather than looking the name up", () => {
  expect(() => deploymentFromEnv({ CLOUDFLARE_ENV: "prd" })).toThrow(
    "apps/os: CLOUDFLARE_ENV=prd needs OS_DEPLOYMENT",
  );
  expect(() =>
    deploymentFromEnv({
      CLOUDFLARE_ENV: "prd",
      OS_DEPLOYMENT: JSON.stringify(getOsEnv("preview")),
    }),
  ).toThrow('apps/os: CLOUDFLARE_ENV=prd but OS_DEPLOYMENT is "preview"');
  expect(() =>
    deploymentFromEnv({
      CLOUDFLARE_ENV: "prd",
      OS_DEPLOYMENT: JSON.stringify({ name: "prd", workerName: "os-prd" }),
    }),
  ).toThrow(/cloudflareAccountId/);
});
