/**
 * The complete map of deployed Iterate environments.
 *
 * This file is the single source of truth for what makes one deployed
 * environment different from another: hostnames, worker names, Cloudflare
 * account, and the IDs of the handful of Cloudflare resources that carry
 * them (D1, KV). Everything here is non-secret and reviewed like any other
 * code; secrets live in Doppler (one config per env, named below).
 *
 * Consumers:
 *   - apps/os/scripts/generate-wrangler-config.ts expands this into
 *     apps/os/wrangler.jsonc env blocks (checked in, CI-verified fresh)
 *   - apps/os/scripts/{deploy,ensure-resources,erase-data}.ts take
 *     `--env <name>` and look the environment up here
 *
 * Local dev environments (`dev`, `dev_<you>`) are deliberately NOT listed:
 * they never deploy — `pnpm dev` runs the top-level wrangler config defaults
 * under your local Doppler context.
 *
 * Adding a preview slot: add `preview_<N>: previewSlot(<N>)`, run
 * `pnpm --dir apps/os ensure-resources --env preview_<N>`, paste the printed
 * resource IDs below, commit, deploy.
 */

/**
 * One deployed environment. A single environment spans apps — the os worker
 * and the auth worker (whose D1 the os erase-data script wipes) deploy into
 * the same env entry.
 */
export interface DeployedEnv {
  /**
   * Cloudflare account the env deploys into. Scripts fail loudly when the
   * Doppler-supplied CLOUDFLARE_ACCOUNT_ID disagrees — catching the classic
   * "right command, wrong doppler config" drift.
   */
  cloudflareAccountId: string;
  /** Doppler config (project `os`) supplying this env's secrets. */
  dopplerConfig: string;
  /** The os worker script name, e.g. `os-prd`. */
  osWorkerName: string;
  /** The auth worker script name, e.g. `auth-prd`. */
  authWorkerName: string;
  /** Dashboard origin, e.g. https://os.iterate.com */
  baseUrl: string;
  /** MCP host origin, e.g. https://mcp.iterate.com */
  mcpBaseUrl: string;
  /** Auth app origin, e.g. https://auth.iterate.com */
  authBaseUrl: string;
  /**
   * Base domains for deployed project hosts (`<slug>.<base>`). Routes are
   * generated as `base/*`, `*.base/*` and `*base/*` (the last because the
   * preview zone only reliably invoked the worker once the broad catch-all
   * existed).
   */
  projectHostnameBases: string[];
  /** IDs of the Cloudflare resources this env owns (created once by ensure-resources). */
  resources: {
    /** KV: slug -> project-id cache in front of the auth project directory. */
    projectDirectoryKvId: string;
    /** D1: the auth worker's database (identities, orgs, projects). */
    authDbId: string;
  };
}

/**
 * Everything about a preview slot follows from its number by convention;
 * only the Cloudflare-assigned resource IDs must be spelled out.
 */
function previewSlot(n: number, resources: DeployedEnv["resources"]): DeployedEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    osWorkerName: `os-preview-${n}`,
    authWorkerName: `auth-preview-${n}`,
    baseUrl: `https://os.iterate-preview-${n}.com`,
    mcpBaseUrl: `https://mcp.iterate-preview-${n}.com`,
    authBaseUrl: `https://auth.iterate-preview-${n}.com`,
    projectHostnameBases: [`iterate-preview-${n}.app`],
    resources,
  };
}

/** The production Cloudflare account (iterate.com zones). */
const PRD_ACCOUNT_ID = "04b3b57291ef2626c6a8daa9d47065a7";
/** The shared dev/preview Cloudflare account (iterate-preview-N and dev zones). */
const PREVIEW_AND_DEV_ACCOUNT_ID = "376ef7ed81b0573f93524de763666c15";

export const envs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    osWorkerName: "os-prd",
    authWorkerName: "auth-prd",
    baseUrl: "https://os.iterate.com",
    mcpBaseUrl: "https://mcp.iterate.com",
    authBaseUrl: "https://auth.iterate.com",
    projectHostnameBases: ["iterate.app"],
    resources: {
      projectDirectoryKvId: "68a1bca8ba934ee9ba23c44c13a698f5",
      authDbId: "f33fec8c-d5a3-44cf-b792-6a319ee1f729",
    },
  },
  preview_1: previewSlot(1, {
    projectDirectoryKvId: "6d35023e80cc47f5a8d43550fe4679dc",
    authDbId: "73e5042b-f076-43a3-9ada-c13caaae7a35",
  }),
  preview_2: previewSlot(2, {
    projectDirectoryKvId: "8eeea44cda5b45928ee8659701224ade",
    authDbId: "69acb8fa-7d81-49d0-a72a-63af707c00da",
  }),
  preview_3: previewSlot(3, {
    projectDirectoryKvId: "4cbef780af3846bda2cf3869082b807c",
    authDbId: "aeb45007-36ec-41f1-9e61-bdade6650a84",
  }),
  preview_4: previewSlot(4, {
    projectDirectoryKvId: "bc1f3ce2cfe44a559b1d744ecce100f8",
    authDbId: "fd193905-8deb-416d-9fe9-146485efc669",
  }),
  preview_5: previewSlot(5, {
    projectDirectoryKvId: "a0f87dc67b39465bb9c00bd05587eadc",
    authDbId: "f8542574-48e3-4374-910f-3186293137f0",
  }),
  preview_6: previewSlot(6, {
    projectDirectoryKvId: "c32330a310d64ccd8af2c2d760749066",
    authDbId: "0e9c6755-818a-44bb-9097-a1ac4cb5b27d",
  }),
  preview_7: previewSlot(7, {
    projectDirectoryKvId: "43d9f22bbd5b440a9f69c792c950d289",
    authDbId: "1be45b8c-e2ef-4dd4-8906-365fd34c283e",
  }),
  preview_8: previewSlot(8, {
    projectDirectoryKvId: "a981052b548843f2a643f4a4bc0d7109",
    authDbId: "51003bad-73c1-43b4-9905-2806067b4534",
  }),
} satisfies Record<string, DeployedEnv>;

/** A deployed environment name, e.g. "prd" or "preview_3". */
export type EnvName = keyof typeof envs;

/** Look up a deployed env by name, with a helpful error listing valid names. */
export function requireEnv(name: string): DeployedEnv {
  const env = (envs as Record<string, DeployedEnv>)[name];
  if (!env) {
    throw new Error(
      `Unknown environment ${JSON.stringify(name)}. Known: ${Object.keys(envs).join(", ")}`,
    );
  }
  return env;
}
