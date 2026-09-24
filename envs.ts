/** Deployment configuration for OS and its first-party apps. Secrets live in Doppler. */

import type { IngressRouting } from "./packages/iterate/src/project-ingress.ts";

/** Cloudflare account names, IDs, and shared credentials for account-wide tooling.
 * dev/preview shares one account; use its preview credentials, not a preview slot. */
const cloudflareAccounts = {
  prd: {
    cloudflareAccountId: "04b3b57291ef2626c6a8daa9d47065a7",
    dopplerProject: "_shared",
    dopplerConfig: "prd",
  },
  "dev/preview": {
    cloudflareAccountId: "376ef7ed81b0573f93524de763666c15",
    dopplerProject: "_shared",
    dopplerConfig: "preview",
  },
};

/** The production Cloudflare account (iterate.com zones). */
export const PRD_ACCOUNT_ID = cloudflareAccounts.prd.cloudflareAccountId;
/** The shared dev/preview Cloudflare account (iterate-preview-N and dev zones). */
export const PREVIEW_AND_DEV_ACCOUNT_ID = cloudflareAccounts["dev/preview"].cloudflareAccountId;

/**
 * Placeholder for a Cloudflare resource that hasn't been created yet.
 * Deploy scripts refuse to ship it; `ensure-resources` replaces it.
 */
export const UNPROVISIONED = "UNPROVISIONED";

/** The Doppler project holding apps/os's secrets (and apps/spa's deploy credentials): one config per
 *  `osEnvs` deployment, each inheriting `_shared/<config>`. Every script that deploys, provisions,
 *  previews, erases or seeds an OS deployment reads its secrets from here. */
export const OS_DOPPLER_PROJECT = "os";

/** The PostHog project every app reports to — "iterate (prd)" in PostHog EU. A project key is public:
 *  it ships in every page that loads posthog-js. Only prd entries carry it, so previews send nothing. */
const ITERATE_POSTHOG_PROJECT_KEY = "phc_2MGb9SEJABGj4sCx4grFIbzMR7NjbcUgP5YmhSXfcr7";

/** apps/kit — the browser device installer (README there): a TanStack Start app like notes, an
 *  ordinary OAuth client of the platform, on the k.iterate.com custom domain. It owns no stateful
 *  Cloudflare resources. */
export interface KitEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `kit`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  /** PostHog's project key (`ITERATE_POSTHOG_PROJECT_KEY`), as every Start app's. Unset ⇒ no PostHog. */
  posthogProjectKey?: string;
}

export const kitEnvs = {
  // THE PARENT of kit's per-PR Worker Previews (apps/os/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's apps/os preview as its issuer. Nothing reads its
  // data. A preview lists and flashes the same GitHub releases as production
  // (apps/kit/src/firmware/releases.ts).
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "kit-preview",
    baseUrl: "https://kit-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    // The production account's workers.dev subdomain is `iterate`, making
    // this worker available at kiterate.iterate.workers.dev as well.
    workerName: "kiterate",
    baseUrl: "https://k.iterate.com",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
  },
} satisfies Record<string, KitEnv>;

export interface OsEnv {
  cloudflareAccountId: string;
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  mcpBaseUrl: string;
  /** PostHog's project key (`ITERATE_POSTHOG_PROJECT_KEY`): the worker's `POSTHOG_PROJECT_KEY`, and
   *  the issuer's own pages start posthog-js with it. Unset ⇒ no PostHog. */
  posthogProjectKey?: string;
  /** The dash's origin for this deployment (apps/dash) — where the platform's landing page `/` sends
   *  a person, the platform being headless. Unset ⇒ the page names no dash (a preview has none). */
  dashBaseUrl?: string;
  /** How projects are reached over HTTP (`APP_CONFIG urls.ingressRouting`): `subdomains` hangs
   *  `<app>--<project>.<hostname>` and the apex `<project>.<hostname>` under a wildcard route the
   *  generator adds on `hostname`'s zone (ensure-resources creates the wildcard DNS record); `paths`
   *  serves `<baseUrl>/projects/<project>/<app>/…` from the one origin. Unset ⇒ no ingress. */
  ingressRouting?: NonNullable<IngressRouting>;
  /** The Artifacts namespace the `ARTIFACTS` binding names, `<workerName>-…`; ensure-resources
   *  creates it. A namespace cannot be renamed, and no other Worker may bind it: erase-data refuses a
   *  shared store, and another Worker would read every project's repos. */
  artifactsNamespace: string;
  /** The prefix of the deployment's named Cloudflare resources (KV `<prefix>-oauth|-itx`, R2
   *  `<prefix>-files`). Today it is the worker name; it is its own field so a worker can be renamed
   *  without renaming the data it binds. `ensure-resources`, erase-data and the wrangler generator
   *  derive the names from this, never from the worker name. */
  resourceNamePrefix: string;
  /** An owned zone served as the named project's config-worker apex: the zone's apex and every
   *  first-level name under it, each with a route and a proxied DNS record (ensure-resources). More
   *  specific Worker routes on that zone continue to take precedence. */
  projectWildcard?: { hostname: string; project: string; excludedHostnames?: string[] };
  /** The zone this deployment serves projects' own hostnames on as a Cloudflare for SaaS provider
   *  (apps/os src/project/custom-hostnames.ts): its fallback origin `cname.<zone>` is the
   *  deployment's, reached through the one `*\/*` route the generator adds. The worker creates each
   *  custom hostname at runtime with `APP_CONFIG.cloudflareApiToken` (Doppler). `dcvDelegationUuid`
   *  is the zone's Delegated DCV id (`GET /zones/:id/dcv_delegation/uuid`), which the owner's
   *  `_acme-challenge` CNAME names. */
  cloudflareForSaas?: { zone: string; zoneId: string; dcvDelegationUuid: string };
  resources: { oauthKvId: string; itxKvId: string };
}
export const osEnvs: Record<string, OsEnv> = {
  // THE PARENT OF EVERY PER-PR PREVIEW (apps/os/scripts/preview.ts, the cloudflare-os recipe): a
  // Worker Preview is a branch of an existing worker, and this is that worker on the dev/preview
  // account — `pr<n>-<branch>-os-preview.<subdomain>.workers.dev`. Each preview has resources of
  // its own; nothing reads this worker's data, and nobody browses to it. workers.dev only.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "os-preview",
    baseUrl: "https://os-preview.iterate-dev-preview.workers.dev",
    mcpBaseUrl: "https://os-preview.iterate-dev-preview.workers.dev/mcp",
    // Projects as paths on the one origin (`/projects/<slug>/<app>/…`): workers.dev has no wildcard
    // subdomains, and every preview inherits this.
    ingressRouting: { type: "paths" },
    artifactsNamespace: "os-preview-repos",
    resourceNamePrefix: "os-preview",
    resources: {
      oauthKvId: "1abac70698334cae90f861869042f53f",
      itxKvId: "c4ff804bf3fe48fbbbf99a73fe31d4a5",
    },
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "os-prd",
    // THE HEADLESS PLATFORM: sign-in, consent, `/api`, the OAuth endpoints — two no-build pages and
    // the OAuth endpoints, nothing else a person looks at. `dash.iterate.com` is the dash (apps/dash): sessions,
    // projects and organizations — an ordinary OAuth client of this issuer, like every other app.
    baseUrl: "https://os.iterate.com",
    mcpBaseUrl: "https://mcp.iterate.com",
    dashBaseUrl: "https://dash.iterate.com",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    ingressRouting: { type: "subdomains", hostname: "iterate.app" },
    // iterate.com and its first-level names are the iterate project's site; other domains are the
    // projects' own custom hostnames (garple.com, lispwoso.com, templestein.com), on iterate.app
    projectWildcard: {
      hostname: "iterate.com",
      project: "iterate",
      // These first-party origins have their own routes and OAuth clients. A missing route must
      // never make their client IDs look like clients of the cheese-game project at consent.
      excludedHostnames: [
        "os.iterate.com",
        "mcp.iterate.com",
        "dash.iterate.com",
        "agents.iterate.com",
        "notes.iterate.com",
        "k.iterate.com",
        "voice.iterate.com",
        "install.iterate.com",
      ],
    },
    cloudflareForSaas: {
      zone: "iterate.app",
      zoneId: "4dcf5f055005471a00eb7f7befb29e54",
      dcvDelegationUuid: "248299803bb79c97",
    },
    // Not `os-prd-repos`: the legacy platform's namespace of that name (2026-05-18) is still bound
    // by its artifact viewer, cf-artifact-viewer-prd (artifacts.iterate.com).
    artifactsNamespace: "os-prd-project-repos",
    resourceNamePrefix: "os-prd",
    resources: {
      oauthKvId: "5d23b869bff94a32a8f8049edc7de122",
      itxKvId: "c8432f0a49c94ae3984040c4f503b8c2",
    },
  },
};
/** apps/dash — THE DASH: sessions and personal access tokens, projects and organizations — the
 *  fat first-party TanStack Start app (README there), an ordinary OAuth client of the headless
 *  platform at os.iterate.com, on a custom domain (dash.iterate.com). */
export const dashEnvs = {
  // THE PARENT of dash's per-PR Worker Previews (apps/os/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's apps/os preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "dash-preview",
    baseUrl: "https://dash-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "dash",
    baseUrl: "https://dash.iterate.com",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
  },
};

/** apps/agents — the agents page (README there); the notes app's shape, on a custom domain. */
export const agentsEnvs = {
  // THE PARENT of agents's per-PR Worker Previews (apps/os/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's apps/os preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "agents-preview",
    baseUrl: "https://agents-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "agents",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    // This exact Worker route takes precedence over the iterate project's *.iterate.com route.
    baseUrl: "https://agents.iterate.com",
  },
};

export const notesEnvs = {
  // THE PARENT of notes's per-PR Worker Previews (apps/os/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's apps/os preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "notes-preview",
    baseUrl: "https://notes-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "notes",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    // This exact Worker route takes precedence over the iterate project's *.iterate.com route.
    baseUrl: "https://notes.iterate.com",
  },
};

export const voiceEnvs = {
  // THE PARENT of voice's per-PR Worker Previews (apps/os/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's apps/os preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "voice-preview",
    baseUrl: "https://voice-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "voice",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    // This exact Worker route takes precedence over the iterate project's *.iterate.com route.
    baseUrl: "https://voice.iterate.com",
  },
};

/** Static OAuth example and downloadable unpacked Chrome extension. Credentials share the platform's Doppler project. */
export const spaEnvs = {
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "iterate-spa-preview",
    baseUrl: "https://iterate-spa-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "iterate-spa",
    baseUrl: "https://iterate-spa.iterate.workers.dev",
  },
};

/** apps/dummy-petshop — the fake third party apps/os's tests connect to over the real network (a
 *  plain Worker, no Start). Production only: its workers.dev origin, no routes, no DNS. */
export interface DummyPetshopEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `dummy-petshop`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
}

export const dummyPetshopEnvs: Record<string, DummyPetshopEnv> = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "dummy-petshop",
    baseUrl: "https://dummy-petshop.iterate.workers.dev",
  },
};

/** apps/ci-reports — the viewer for CI traces and Playwright HTML reports (docs/ci-traces.md): a plain
 *  Worker serving public Depot artifacts. CI tooling, so it lives on the dev/preview account with CI's
 *  Doppler config (_shared/preview supplies both the Cloudflare and the Depot token): its workers.dev
 *  origin, no routes, no DNS. The env is named for its use, not its Doppler config: deploy with
 *  `--env ci`. */
export const ciReportsEnvs: Record<
  string,
  { cloudflareAccountId: string; dopplerConfig: string; workerName: string; baseUrl: string }
> = {
  ci: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "ci-reports",
    baseUrl: "https://ci-reports.iterate-dev-preview.workers.dev",
  },
};
