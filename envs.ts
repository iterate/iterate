/**
 * The complete map of deployed Iterate environments, for every app.
 *
 * This file is the single source of truth for what makes one deployed
 * environment different from another: hostnames, worker names, Cloudflare
 * account, and the IDs of the handful of Cloudflare resources that carry
 * them (D1, KV). Everything here is non-secret and reviewed like any other
 * code; secrets live in Doppler (one config per env per app, named below).
 *
 * Each app has its own map (envs/os, authEnvs, semaphoreEnvs, tunnelsEnvs,
 * streamsExampleEnvs, dummyPetshopEnvs) because apps deploy to different
 * subsets of environments — forcing them into one record would mean optional
 * fields that lie. Hostnames follow conventions (`previewSlot(n)` derives them);
 * resource IDs are Cloudflare-assigned and must be spelled out.
 *
 * Consumers: each app's scripts/{generate-wrangler-config,deploy,
 * ensure-resources,erase-data}.ts, via scripts/lib/env-context.ts. All take
 * `--env <name>` and look the environment up here. The generated
 * wrangler.jsonc files are gitignored — this file is the reviewed artifact.
 *
 * Local dev environments (`dev`, `dev_<you>`) are deliberately NOT listed:
 * they never deploy — `pnpm dev` runs each app's top-level wrangler config
 * defaults under your local Doppler context.
 *
 * Bringing up a new env (e.g. a new preview slot): add its entry with
 * `UNPROVISIONED` resource IDs, run that app's
 * `pnpm ensure-resources --env <name>` (creates whatever is missing and
 * prints the real IDs), paste them here, commit, regenerate wrangler config,
 * deploy. Deploys refuse to ship UNPROVISIONED IDs.
 */

/** The production Cloudflare account (iterate.com zones). */
export const PRD_ACCOUNT_ID = "04b3b57291ef2626c6a8daa9d47065a7";
/** The shared dev/preview Cloudflare account (iterate-preview-N and dev zones). */
export const PREVIEW_AND_DEV_ACCOUNT_ID = "376ef7ed81b0573f93524de763666c15";

/**
 * Placeholder for a Cloudflare resource that hasn't been created yet.
 * Deploy scripts refuse to ship it; `ensure-resources` replaces it.
 */
export const UNPROVISIONED = "UNPROVISIONED";

/**
 * One deployed environment of the OS product. A single environment spans
 * apps — the os worker and the auth worker (whose D1 the os erase-data
 * script wipes) deploy into the same env entry.
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
  /** Public event type docs origin, e.g. https://events.iterate.com */
  eventDocsBaseUrl: string;
  /** Auth app origin, e.g. https://auth.iterate.com */
  authBaseUrl: string;
  /**
   * Base domains for deployed project hosts (`<slug>.<base>`). Worker routes are
   * generated for the built-in project host patterns.
   */
  projectHostnameBases: string[];
  /**
   * Project hostname bases that are Cloudflare for SaaS enabled. These get the
   * provider-zone catch-all route required for custom hostnames using the worker
   * as origin. Keep this a subset of `projectHostnameBases`; preview zones have
   * no SSL-for-SaaS quota unless Cloudflare explicitly provisions it.
   */
  cloudflareForSaasProjectHostnameBases: string[];
  /**
   * How agent LLM turns travel through the Cloudflare AI Gateway: `unified`
   * = partner models on Cloudflare's unified billing; `byok` = the gateway's
   * universal endpoint with our own OpenAI key (correct prompt-cache
   * pricing, and the only path where the gateway's response cache works).
   */
  cloudflareAiGatewayTransport: "unified" | "byok";
  /**
   * Opts the BYOK lane into the AI Gateway RESPONSE cache (whole-answer
   * replay for byte-identical normalized requests — see
   * cloudflareAiGatewayResponseCacheKey). Only for envs whose conversations
   * are synthetic: previews and dev, where e2e reruns should replay
   * yesterday's answers for free. Leave unset on prd — a real user must
   * never receive a cached agent reply.
   */
  cloudflareAiGatewayResponseCacheTtlSeconds?: number;
  /** IDs of the Cloudflare resources this env owns (created once by ensure-resources). */
  resources: {
    /** KV: slug -> project-id cache in front of the auth project directory. */
    projectDirectoryKvId: string;
    /** KV: content-addressed dynamic worker build artifact cache. Every
     * entry is reproducible from its deterministic build key, so the
     * namespace is safe to wipe. */
    workerBuildCacheKvId: string;
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
    eventDocsBaseUrl: `https://events.iterate-preview-${n}.com`,
    authBaseUrl: `https://auth.iterate-preview-${n}.com`,
    projectHostnameBases: [`iterate-preview-${n}.app`],
    cloudflareForSaasProjectHostnameBases: [],
    cloudflareAiGatewayTransport: "byok",
    // 7 days: long enough that overnight marathons and PR-lifetime reruns
    // replay each other, short enough that stale answers age out on their own.
    cloudflareAiGatewayResponseCacheTtlSeconds: 7 * 24 * 60 * 60,
    resources,
  };
}

export const envs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    osWorkerName: "os-prd",
    authWorkerName: "auth-prd",
    baseUrl: "https://os.iterate.com",
    mcpBaseUrl: "https://mcp.iterate.com",
    eventDocsBaseUrl: "https://events.iterate.com",
    authBaseUrl: "https://auth.iterate.com",
    projectHostnameBases: ["iterate.app"],
    cloudflareForSaasProjectHostnameBases: ["iterate.app"],
    // BYOK, like every other env: unified billing meters OpenAI-prompt-cached
    // tokens at the uncached price (~6x at our hit rate), and BYOK benchmarked
    // latency-neutral-or-better. NO response cache here — that knob stays
    // preview/dev-only; a real user must never receive a cached agent reply.
    cloudflareAiGatewayTransport: "byok",
    resources: {
      projectDirectoryKvId: "79d78df2e83b46d2b9083533e9f189c4",
      workerBuildCacheKvId: "43306c224d364c7aa804c3ff762c4d08",
      authDbId: "f33fec8c-d5a3-44cf-b792-6a319ee1f729",
    },
  },
  preview_1: previewSlot(1, {
    projectDirectoryKvId: "6d35023e80cc47f5a8d43550fe4679dc",
    workerBuildCacheKvId: "e02fcfb5dc30454489ce1004cf5f3499",
    authDbId: "73e5042b-f076-43a3-9ada-c13caaae7a35",
  }),
  preview_2: previewSlot(2, {
    projectDirectoryKvId: "237cc9a316a146e98f04f00218b0a69c",
    workerBuildCacheKvId: "6cbee4966b99490e9b43bd01b957b834",
    authDbId: "c5a24ab5-e10b-4ca5-a2f2-2451803bc146",
  }),
  preview_3: previewSlot(3, {
    projectDirectoryKvId: "dd06b3a37bbd4b9f838fadc895e5a6d6",
    workerBuildCacheKvId: "3cb31a916afd41cd82ede40718547fdd",
    authDbId: "2017a0b9-ebd5-482c-b2b8-894a27733dbc",
  }),
  preview_4: previewSlot(4, {
    projectDirectoryKvId: "d0b6679c68114add86e024cf7d0a7646",
    workerBuildCacheKvId: "855531fbd02740f78d27c1465cac3202",
    authDbId: "bd115332-9515-4bbf-96d5-f041e628bcf9",
  }),
  preview_5: previewSlot(5, {
    projectDirectoryKvId: "a0f87dc67b39465bb9c00bd05587eadc",
    workerBuildCacheKvId: "34f27e888b6243189e42a0ea5a93291f",
    authDbId: "f8542574-48e3-4374-910f-3186293137f0",
  }),
  preview_6: previewSlot(6, {
    projectDirectoryKvId: "e414e68c13e1471a8a3c41f5e50136e4",
    workerBuildCacheKvId: "2fecfd3043184552af0e833dca7d7a4a",
    authDbId: "bd78258a-2167-429f-a504-9e1eb1c18ef2",
  }),
  preview_7: previewSlot(7, {
    projectDirectoryKvId: "619f43ebb6d647229693e41b51ab2a32",
    workerBuildCacheKvId: "fad0de53747645369f8aa3aa99049886",
    authDbId: "d2ff0612-3487-4196-ae21-19681020e7b0",
  }),
  preview_8: previewSlot(8, {
    projectDirectoryKvId: "b36864421f924ac2b6d382c17a20cddc",
    workerBuildCacheKvId: "14554ce1beba4d868de4227c27c6e5fa",
    authDbId: "d59dd035-41f9-47be-bc31-260ef1784ed0",
  }),
  preview_9: previewSlot(9, {
    projectDirectoryKvId: "9fac543a7e994b7f972328c6a07152ac",
    workerBuildCacheKvId: "3599fdcb79db418db0ead561f1ef85f7",
    authDbId: "ebf149cb-d3ed-48c5-a2d0-010166b25033",
  }),
} satisfies Record<string, DeployedEnv>;

/** A deployed environment name, e.g. "prd" or "preview_3". */
export type EnvName = keyof typeof envs;

/**
 * apps/auth deploys everywhere os does, PLUS `dev_global`
 * (auth.iterate-dev.com) — the shared issuer every local dev environment
 * signs in through. The subset of fields auth's scripts need.
 */
export interface AuthDeployedEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `auth`) supplying this env's secrets. */
  dopplerConfig: string;
  authWorkerName: string;
  authBaseUrl: string;
  /** Enables fixed `+test@nustom.com` OTPs for test automation. */
  fixedTestOtpEnabled: boolean;
  resources: { authDbId: string };
}

function authEnvFromDeployedEnv(
  env: DeployedEnv,
  options: { fixedTestOtpEnabled: boolean },
): AuthDeployedEnv {
  return {
    cloudflareAccountId: env.cloudflareAccountId,
    dopplerConfig: env.dopplerConfig,
    authWorkerName: env.authWorkerName,
    authBaseUrl: env.authBaseUrl,
    fixedTestOtpEnabled: options.fixedTestOtpEnabled,
    resources: { authDbId: env.resources.authDbId },
  };
}

export const authEnvs = {
  prd: authEnvFromDeployedEnv(envs.prd, { fixedTestOtpEnabled: false }),
  preview_1: authEnvFromDeployedEnv(envs.preview_1, { fixedTestOtpEnabled: true }),
  preview_2: authEnvFromDeployedEnv(envs.preview_2, { fixedTestOtpEnabled: true }),
  preview_3: authEnvFromDeployedEnv(envs.preview_3, { fixedTestOtpEnabled: true }),
  preview_4: authEnvFromDeployedEnv(envs.preview_4, { fixedTestOtpEnabled: true }),
  preview_5: authEnvFromDeployedEnv(envs.preview_5, { fixedTestOtpEnabled: true }),
  preview_6: authEnvFromDeployedEnv(envs.preview_6, { fixedTestOtpEnabled: true }),
  preview_7: authEnvFromDeployedEnv(envs.preview_7, { fixedTestOtpEnabled: true }),
  preview_8: authEnvFromDeployedEnv(envs.preview_8, { fixedTestOtpEnabled: true }),
  preview_9: authEnvFromDeployedEnv(envs.preview_9, { fixedTestOtpEnabled: true }),
  dev_global: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "dev_global",
    authWorkerName: "auth-dev-global",
    authBaseUrl: "https://auth.iterate-dev.com",
    fixedTestOtpEnabled: true,
    resources: { authDbId: "a4e70d97-74aa-4f9f-8da9-4540e552b2a9" },
  },
} satisfies Record<EnvName | "dev_global", AuthDeployedEnv>;

/**
 * apps/semaphore — the preview-slot lease coordinator. prd serves all real
 * leasing (its coordinator DO holds live lease state — deploy over it, never
 * erase it); preview slots deploy it too so semaphore PRs get previews.
 */
export interface SemaphoreEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `semaphore`) supplying this env's secrets. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  /**
   * The env's apps/auth deployment. Semaphore is a relying party of the same
   * issuer as os: deploys bake the issuer's JWKS and requests authenticate
   * with iterate sessions or bearer access tokens.
   */
  authBaseUrl: string;
  resources: {
    /** D1: lease inventory (`<worker>-resources`). */
    resourcesDbId: string;
  };
}

function semaphorePreviewSlot(n: number, resourcesDbId: string): SemaphoreEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    workerName: `semaphore-preview-${n}`,
    baseUrl: `https://semaphore.iterate-preview-${n}.com`,
    authBaseUrl: `https://auth.iterate-preview-${n}.com`,
    resources: { resourcesDbId },
  };
}

export const semaphoreEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "semaphore-prd",
    baseUrl: "https://semaphore.iterate.com",
    authBaseUrl: "https://auth.iterate.com",
    resources: { resourcesDbId: "2a393c91-3f01-455c-a462-2486653b0a10" },
  },
  preview_1: semaphorePreviewSlot(1, "1a5b713d-eba3-4538-a356-0e5c3e2e8251"),
  preview_2: semaphorePreviewSlot(2, "711994bd-4faa-42f0-80ac-fc292d68569d"),
  preview_3: semaphorePreviewSlot(3, "17493958-1589-4a2c-a280-0a55bc11a92c"),
  preview_4: semaphorePreviewSlot(4, "f61083ef-23b5-4201-8731-8d3d46ebfeaa"),
  preview_5: semaphorePreviewSlot(5, "eea19312-34e2-4e5c-be19-fe6929636544"),
  preview_6: semaphorePreviewSlot(6, "eff27a10-2f52-4077-9372-05dcf1c77ccd"),
  preview_7: semaphorePreviewSlot(7, "f4b1b641-71bd-4952-8726-3c2c543383fe"),
  preview_8: semaphorePreviewSlot(8, "77af433e-c870-43a6-be8e-1d2452feb23d"),
  preview_9: semaphorePreviewSlot(9, "53522759-5f82-4055-b0c2-248d66988b7d"),
} satisfies Record<string, SemaphoreEnv>;

/**
 * apps/tunnels — the captun gateway. prd only; dev tunnels ride prd.
 * No per-env resources (one DO class, no D1/KV), so its checked-in
 * wrangler.jsonc is hand-written rather than generated.
 */
export interface TunnelsEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `tunnels`) supplying this env's secrets. */
  dopplerConfig: string;
  workerName: string;
  /** Gateway hostname; tunnels live at `<name>.<hostname>`. */
  hostname: string;
}

export const tunnelsEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "tunnels-prd",
    hostname: "tunnels.iterate.com",
  },
} satisfies Record<string, TunnelsEnv>;

/**
 * apps/streams-example-app — the streams browser UI. Served on a custom
 * domain (`streams.<env zone>`) like every other app, not workers.dev:
 * workers.dev routes on this account have a documented drift class (routes
 * dead at the edge while the API says healthy), and a websocket-first app
 * feels every edge wobble. The deploy ensures the DNS record (create-only);
 * no other resources.
 */
export interface StreamsExampleEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `streams-example-app`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  /** The env's public origin (`https://streams.<env zone>`). */
  baseUrl: string;
  /**
   * The env's apps/auth deployment. The playground is a relying party of the
   * same issuer as os: deploys bake the issuer's JWKS and requests
   * authenticate with iterate sessions or bearer access tokens.
   */
  authBaseUrl: string;
}

/**
 * apps/dummy-petshop — the fake third-party "Pet Shop" service that
 * integration e2e tests connect to (OAuth 2.0 provider, legacy login, pets
 * API, signed webhooks, test backdoor). S0 of
 * apps/os/docs/integrations-and-secrets-design.md §7. Deploys everywhere os
 * does so every environment's integration specs have a real third party to
 * talk to. No Cloudflare resources beyond DNS — state is one Durable Object.
 */
export interface DummyPetshopEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `dummy-petshop`) supplying this env's secrets. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
}

function dummyPetshopPreviewSlot(n: number): DummyPetshopEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    workerName: `dummy-petshop-preview-${n}`,
    baseUrl: `https://dummy-petshop.iterate-preview-${n}.com`,
  };
}

export const dummyPetshopEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "dummy-petshop-prd",
    baseUrl: "https://dummy-petshop.iterate.com",
  },
  preview_1: dummyPetshopPreviewSlot(1),
  preview_2: dummyPetshopPreviewSlot(2),
  preview_3: dummyPetshopPreviewSlot(3),
  preview_4: dummyPetshopPreviewSlot(4),
  preview_5: dummyPetshopPreviewSlot(5),
  preview_6: dummyPetshopPreviewSlot(6),
  preview_7: dummyPetshopPreviewSlot(7),
  preview_8: dummyPetshopPreviewSlot(8),
  preview_9: dummyPetshopPreviewSlot(9),
} satisfies Record<string, DummyPetshopEnv>;

function streamsExamplePreviewSlot(n: number): StreamsExampleEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    workerName: `streams-example-app-preview-${n}`,
    baseUrl: `https://streams.iterate-preview-${n}.com`,
    authBaseUrl: `https://auth.iterate-preview-${n}.com`,
  };
}

export const streamsExampleEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "streams-example-app-prd",
    baseUrl: "https://streams.iterate.com",
    authBaseUrl: "https://auth.iterate.com",
  },
  preview_1: streamsExamplePreviewSlot(1),
  preview_2: streamsExamplePreviewSlot(2),
  preview_3: streamsExamplePreviewSlot(3),
  preview_4: streamsExamplePreviewSlot(4),
  preview_5: streamsExamplePreviewSlot(5),
  preview_6: streamsExamplePreviewSlot(6),
  preview_7: streamsExamplePreviewSlot(7),
  preview_8: streamsExamplePreviewSlot(8),
  preview_9: streamsExamplePreviewSlot(9),
} satisfies Record<string, StreamsExampleEnv>;
