import { expect, test } from "vitest";
import { viteWranglerConfig } from "./generate-wrangler-config.ts";

// Every deployment's Artifacts namespace, R2 bucket and D1 are `<resourceNamePrefix>-…`, the
// self-host config's prefix being `iterate` (envs.ts `osResourceNames`).
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
  expect(viteWranglerConfig(name, { localDev: false, port: "0" })).toMatchObject({
    artifacts: [{ binding: "ARTIFACTS", namespace: repos }],
    r2_buckets: [{ binding: "FILES", bucket_name: files }],
    d1_databases: [{ binding: "DB", database_name: db }],
  });
});
