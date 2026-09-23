// scripts/preview-prd-guard.ts — THE GUARD a preview's config passes before wrangler sees it
// (scripts/preview.ts calls it for every preview, on either account). A throwaway preview on the prd
// account (envs.ts `osEnvs["prd-account-e2e"]`) shares an account with production, so nothing it
// deploys, binds or deletes may be production's. The guard reads production's live names only from
// envs.ts, and refuses a config unless ALL of these hold:
//   1. The worker is not a production worker, and its name does not start with a production prefix.
//   2. On the prd account, the worker is the ONE throwaway parent (`osEnvs["prd-account-e2e"]`).
//   3. There is no route, route list or custom domain anywhere: workers.dev only.
//   4. Every D1 and Artifacts namespace is named `<worker>-<preview>-…`, the run's own, and none is
//      a production id or name.
//   5. KV and R2 are binding-only: wrangler provisions them for the preview, never an existing one.
//   6. Every URL the preview is told about is on workers.dev, never a production hostname.
// A delete by name follows from the same names: `<worker>-<preview>-…` (rule 1 keeps the prefix off
// production's), which `assertPreviewParentIsNotPrdLive` checks before any command runs.
import {
  agentsEnvs,
  dashEnvs,
  kitEnvs,
  notesEnvs,
  osEnvs,
  PRD_ACCOUNT_ID,
  spaEnvs,
  voiceEnvs,
  type OsEnv,
} from "../../../envs.ts";

/** Production's names, from envs.ts: what no preview may deploy as, bind, or delete. */
export type PrdLiveResources = {
  workerNames: string[];
  resourcePrefixes: string[];
  resourceIds: string[];
  resourceNames: string[];
  hostnames: string[];
  throwawayWorkerName: string;
};

export function prdLiveResources(): PrdLiveResources {
  const prd = osEnvs.prd!;
  const prdApps = [
    dashEnvs.prd,
    agentsEnvs.prd,
    notesEnvs.prd,
    voiceEnvs.prd,
    kitEnvs.prd,
    spaEnvs.prd,
  ];
  return {
    workerNames: [prd.workerName, ...prdApps.map((env) => env.workerName)],
    resourcePrefixes: [prd.resourceNamePrefix, prd.workerName],
    resourceIds: Object.values(prd.resources),
    resourceNames: [
      prd.artifactsNamespace,
      `${prd.resourceNamePrefix}-directory`,
      `${prd.resourceNamePrefix}-files`,
      `${prd.resourceNamePrefix}-oauth`,
      `${prd.resourceNamePrefix}-itx`,
    ],
    hostnames: [
      new URL(prd.baseUrl).hostname,
      new URL(prd.mcpBaseUrl).hostname,
      ...(prd.dashBaseUrl ? [new URL(prd.dashBaseUrl).hostname] : []),
      ...Object.keys(prd.temporaryCustomHostnames || {}),
      ...(prd.cloudflareForSaasProjectHostnameBases || []),
      ...(prd.projectWildcard ? [prd.projectWildcard.hostname] : []),
      ...prdApps.map((env) => new URL(env.baseUrl).hostname),
    ],
    throwawayWorkerName: osEnvs["prd-account-e2e"]!.workerName,
  };
}

/** The parts of a preview's wrangler config the guard reads (scripts/preview-config.ts builds it). */
export type GuardedPreviewConfig = {
  name: string;
  account_id: string;
  routes?: unknown;
  route?: unknown;
  previews: {
    routes?: unknown;
    route?: unknown;
    d1_databases?: { database_name?: string; database_id?: string }[];
    kv_namespaces?: Record<string, unknown>[];
    r2_buckets?: Record<string, unknown>[];
    artifacts?: { namespace?: string }[];
    vars?: Record<string, string | undefined>;
  };
};

/** Every rule the config breaks, in words; empty when it may deploy. Pure. */
export function prdLiveViolations(input: {
  config: GuardedPreviewConfig;
  previewName: string;
  live: PrdLiveResources;
}): string[] {
  const { config, previewName, live } = input;
  const own = `${config.name}-${previewName}-`;
  const violations: string[] = [];
  const isLiveName = (name: string) =>
    live.resourceNames.includes(name) ||
    live.resourcePrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`));
  // 1
  if (live.workerNames.includes(config.name) || isLiveName(config.name))
    violations.push(`the worker ${config.name} is a production worker`);
  // 2
  if (config.account_id === PRD_ACCOUNT_ID && config.name !== live.throwawayWorkerName)
    violations.push(
      `on the prd account a preview's parent must be ${live.throwawayWorkerName}, not ${config.name}`,
    );
  // 3
  for (const [where, block] of [
    ["the worker", config],
    ["the preview", config.previews],
  ] as const)
    for (const key of ["routes", "route"] as const)
      if (block[key] !== undefined) violations.push(`${where} declares ${key}: workers.dev only`);
  // 4
  for (const database of config.previews.d1_databases || []) {
    if (!database.database_name?.startsWith(own) || isLiveName(database.database_name))
      violations.push(`the D1 ${database.database_name} is not the run's own (${own}…)`);
    if (database.database_id && live.resourceIds.includes(database.database_id))
      violations.push(`the D1 id ${database.database_id} is production's`);
  }
  for (const artifacts of config.previews.artifacts || [])
    if (!artifacts.namespace?.startsWith(own) || isLiveName(artifacts.namespace))
      violations.push(
        `the Artifacts namespace ${artifacts.namespace} is not the run's own (${own}…)`,
      );
  // 5
  for (const [kind, resources] of [
    ["KV namespace", config.previews.kv_namespaces],
    ["R2 bucket", config.previews.r2_buckets],
  ] as const)
    for (const resource of resources || [])
      if (Object.keys(resource).some((key) => key !== "binding"))
        violations.push(`the ${kind} ${JSON.stringify(resource)} names an existing resource`);
  // 6
  for (const [key, value] of Object.entries(config.previews.vars || {})) {
    if (!value || !/^https?:\/\//.test(value)) continue;
    const hostname = new URL(value).hostname;
    if (!hostname.endsWith(".workers.dev") || live.hostnames.includes(hostname))
      violations.push(`${key} is ${value}, not a workers.dev URL of the run's own`);
  }
  return violations;
}

/** Throws unless `prdLiveViolations` is empty. */
export function assertPreviewConfigTouchesNoPrdLiveResource(
  config: GuardedPreviewConfig,
  previewName: string,
): void {
  const violations = prdLiveViolations({ config, previewName, live: prdLiveResources() });
  if (violations.length > 0)
    throw new Error(
      `refusing preview ${previewName}: it could touch production\n  ${violations.join("\n  ")}`,
    );
}

/** Rules 1 and 2 for the parent alone, before any command (a delete included) runs. */
export function assertPreviewParentIsNotPrdLive(parent: OsEnv): void {
  const live = prdLiveResources();
  if (
    live.workerNames.includes(parent.workerName) ||
    live.resourcePrefixes.some((prefix) => parent.workerName.startsWith(prefix)) ||
    (parent.cloudflareAccountId === PRD_ACCOUNT_ID &&
      parent.workerName !== live.throwawayWorkerName)
  )
    throw new Error(
      `refusing to run with ${parent.workerName} as a preview's parent: it is production's`,
    );
}
