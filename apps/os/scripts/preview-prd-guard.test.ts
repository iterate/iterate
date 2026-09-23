import { expect, test } from "vitest";
import { osEnvs, PRD_ACCOUNT_ID, PREVIEW_AND_DEV_ACCOUNT_ID } from "../../../envs.ts";
import {
  assertPreviewParentIsNotPrdLive,
  prdLiveResources,
  prdLiveViolations,
  type GuardedPreviewConfig,
} from "./preview-prd-guard.ts";

const live = prdLiveResources();

test("production's live names come from envs.ts", () => {
  expect(live).toMatchObject({
    workerNames: expect.arrayContaining(["os-next-prd", "dash", "notes"]),
    resourceIds: Object.values(osEnvs.prd!.resources),
    resourceNames: expect.arrayContaining(["project-worker-prd-repos"]),
    hostnames: expect.arrayContaining(["os.iterate.com", "iterate.com"]),
    throwawayWorkerName: "os-prd-account-e2e",
  });
});

test.each<{ rule: string; change: (config: GuardedPreviewConfig) => void; violation?: RegExp }>([
  { rule: "the run's own throwaway preview passes", change: () => {} },
  {
    rule: "1: a production worker",
    change: (config) => void (config.name = "os-next-prd"),
    violation: /the worker os-next-prd is a production worker/,
  },
  {
    rule: "1: a production resource prefix",
    change: (config) => void (config.name = "project-worker-prd-x"),
    violation: /production worker/,
  },
  {
    rule: "2: on the prd account, any other worker",
    change: (config) => void (config.name = "some-other-worker"),
    violation: /must be os-prd-account-e2e/,
  },
  {
    rule: "3: a route",
    change: (config) => void (config.routes = [{ pattern: "os.iterate.com/*" }]),
    violation: /the worker declares routes/,
  },
  {
    rule: "3: a route in the preview block",
    change: (config) => void (config.previews.route = "x.iterate.com/*"),
    violation: /the preview declares route/,
  },
  {
    rule: "4: a production resource id as a D1's",
    change: (config) =>
      void (config.previews.d1_databases![0]!.database_id = osEnvs.prd!.resources.oauthKvId),
    violation: /the D1 id .* is production's/,
  },
  {
    rule: "4: production's D1 by name",
    change: (config) =>
      void (config.previews.d1_databases![0]!.database_name = "project-worker-prd-directory"),
    violation: /the D1 project-worker-prd-directory is not the run's own/,
  },
  {
    rule: "4: another preview's D1",
    change: (config) =>
      void (config.previews.d1_databases![0]!.database_name = "os-prd-account-e2e-other-db"),
    violation: /is not the run's own \(os-prd-account-e2e-main-abc1234-…\)/,
  },
  {
    rule: "4: production's Artifacts namespace",
    change: (config) =>
      void (config.previews.artifacts![0]!.namespace = "project-worker-prd-repos"),
    violation: /the Artifacts namespace project-worker-prd-repos/,
  },
  {
    rule: "5: an existing KV namespace",
    change: (config) =>
      void (config.previews.kv_namespaces![0] = {
        binding: "ITX_KV",
        id: osEnvs.prd!.resources.itxKvId,
      }),
    violation: /the KV namespace .* names an existing resource/,
  },
  {
    rule: "5: an existing R2 bucket",
    change: (config) =>
      void (config.previews.r2_buckets![0] = {
        binding: "FILES",
        bucket_name: "project-worker-prd-files",
      }),
    violation: /the R2 bucket .* names an existing resource/,
  },
  {
    rule: "6: a production hostname",
    change: (config) => void (config.previews.vars!.APP_CONFIG_URLS__OS = "https://os.iterate.com"),
    violation: /APP_CONFIG_URLS__OS is https:\/\/os\.iterate\.com/,
  },
])("rule $rule", ({ change, violation }) => {
  const config = throwawayConfig();
  change(config);
  const violations = prdLiveViolations({ config, previewName: "main-abc1234", live });
  if (!violation) return expect(violations).toEqual([]);
  expect(violations.join("\n")).toMatch(violation);
});

test("the dev/preview account's PR previews pass unchanged", () => {
  const config = throwawayConfig();
  Object.assign(config, { name: "os-next-preview", account_id: PREVIEW_AND_DEV_ACCOUNT_ID });
  config.previews.d1_databases = [
    { database_name: "os-next-preview-pr123-x-db", database_id: "d1-id" },
  ];
  config.previews.artifacts = [{ namespace: "os-next-preview-pr123-x-repos" }];
  config.previews.vars = {
    APP_CONFIG_URLS__OS: "https://pr123-x-os-next-preview.iterate-dev-preview.workers.dev",
  };
  expect(prdLiveViolations({ config, previewName: "pr123-x", live })).toEqual([]);
});

test.each([
  { parent: "preview", refused: false },
  { parent: "prd-account-e2e", refused: false },
  { parent: "prd", refused: true },
])("a command with $parent as the parent is refused: $refused", ({ parent, refused }) => {
  const check = () => assertPreviewParentIsNotPrdLive(osEnvs[parent]!);
  if (refused) expect(check).toThrow(/it is production's/);
  else expect(check).not.toThrow();
});

/** The config scripts/preview-config.ts builds for `main-abc1234` of the prd account's parent. */
function throwawayConfig(): GuardedPreviewConfig {
  return {
    name: "os-prd-account-e2e",
    account_id: PRD_ACCOUNT_ID,
    previews: {
      d1_databases: [
        { database_name: "os-prd-account-e2e-main-abc1234-db", database_id: "fresh-d1-id" },
      ],
      kv_namespaces: [{ binding: "ITX_KV" }, { binding: "OAUTH_KV" }],
      r2_buckets: [{ binding: "FILES" }],
      artifacts: [{ namespace: "os-prd-account-e2e-main-abc1234-repos" }],
      vars: {
        APP_CONFIG_URLS__OS: "https://main-abc1234-os-prd-account-e2e.iterate.workers.dev",
        APP_CONFIG_URLS__DASH: undefined,
        APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      },
    },
  };
}
