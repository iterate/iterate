import { z } from "zod";

/** ONE core/os DEPLOYMENT: what ./generate-wrangler-config.ts turns into a wrangler config. The
 *  root envs.ts lists iterate's own (`osEnvs`, `previewDeployment`). A schema, because a build
 *  receives its deployment as JSON (`OS_DEPLOYMENT`, ./build.ts `viteBuildOs`). */
export const OsEnv = z.object({
  cloudflareAccountId: z.string(),
  dopplerConfig: z.string(),
  workerName: z.string(),
  baseUrl: z.string(),
  mcpBaseUrl: z.string(),
  /** PostHog's project key: the worker's `APP_CONFIG posthogProjectKey`, which the issuer's own
   *  pages start posthog-js with. Unset ⇒ no PostHog. */
  posthogProjectKey: z.string().optional(),
  /** The dash's origin for this deployment (packages/dash) — where the platform's landing page `/` sends
   *  a person, the platform being headless. Unset ⇒ the page names no dash (a preview has none). */
  dashBaseUrl: z.string().optional(),
  /** The platform admins (src/app-config.ts `admins`): exact email addresses, not secrets, so in
   *  the deployment's entry rather than in Doppler; the generator hands them to the worker as
   *  `APP_CONFIG_ADMINS`. */
  admins: z.array(z.string()).optional(),
  /** How projects are reached over HTTP (`APP_CONFIG urls.ingressRouting`, iterate/project-ingress
   *  `IngressRouting`): `subdomains` hangs `<routingSlug>--<project>.<hostname>` and the apex
   *  `<project>.<hostname>` under a wildcard route the generator adds on `hostname`'s zone
   *  (ensure-resources creates the wildcard DNS record); `paths` serves
   *  `<baseUrl>/projects/<project>/<routingSlug>/…` from the one origin. Unset ⇒ no ingress. */
  ingressRouting: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("subdomains"), hostname: z.string() }),
      z.object({ type: z.literal("paths") }),
    ])
    .optional(),
  /** The prefix of the deployment's named Cloudflare resources (KV `<prefix>-oauth|-itx`, R2
   *  `<prefix>-files`, the control plane's D1 `<prefix>-db`, the Artifacts namespace
   *  `<prefix>-repos`; `osResourceNames`). It is its own field, not the worker name, so a worker can
   *  be renamed without renaming the data it binds. `ensure-resources`, erase-data and the wrangler
   *  generator derive the names from this, never from the worker name. No other Worker may bind
   *  them: erase-data refuses a shared store, and another Worker would read every project's repos. */
  resourceNamePrefix: z.string(),
  /** An owned zone served as the named project's config-worker apex: the zone's apex and every
   *  first-level name under it, each with a route and a proxied DNS record (ensure-resources). More
   *  specific Worker routes on that zone continue to take precedence. */
  projectWildcard: z
    .object({
      hostname: z.string(),
      project: z.string(),
      /** A verified Email Routing destination (the account's Destination addresses) that every
       *  message to an address on `hostname` is also forwarded to, as it arrived, once the project
       *  has it (src/integrations/email.ts). */
      forwardEmailTo: z.string().optional(),
      excludedHostnames: z.array(z.string()).optional(),
    })
    .optional(),
  /** The zone this deployment serves projects' own hostnames on as a Cloudflare for SaaS provider
   *  (src/project/custom-hostnames.ts): its fallback origin `cname.<zone>` is the deployment's,
   *  reached through the one `*\/*` route the generator adds. The worker creates each custom
   *  hostname at runtime with `APP_CONFIG.cloudflareApiToken` (Doppler). `dcvDelegationUuid` is the
   *  zone's Delegated DCV id (`GET /zones/:id/dcv_delegation/uuid`), which the owner's
   *  `_acme-challenge` CNAME names. */
  cloudflareForSaas: z
    .object({ zone: z.string(), zoneId: z.string(), dcvDelegationUuid: z.string() })
    .optional(),
  /** Another iterate deployment whose word on who a browser is this one takes, for its `admins`
   *  alone (src/app-config.ts `login.adminIssuer`, src/admin-sign-in.ts): prd, for a per-commit
   *  deployment, whose admins sign in through it and sign an app in as the PR's test person from
   *  the consent page. app-config.ts refuses it off an https workers.dev origin. */
  adminIssuer: z.string().optional(),
  /** The reserved domain of the deployment's test people (src/app-config.ts
   *  `login.testEmailDomain`): the pet shop's fake sign-ins admit addresses under it alone, and a
   *  PR body's sign-in link pre-fills one of them for an admin. A per-commit deployment's only. */
  testEmailDomain: z.string().optional(),
  /** The dummy pet shop's origin (internal-packages/dummy-petshop), whose fakes are iterate's own Slack app,
   *  Google, X and Cloudflare OAuth clients and GitHub App (./preview-*-app.ts, at this origin), and
   *  people sign in with Google, Cloudflare and GitHub through them. A per-commit deployment's only:
   *  prd's and main on dev's integrations are their Doppler `APP_CONFIG`'s. */
  petshopOrigin: z.string().optional(),
  /** The ids of the resources `resourceNamePrefix` names, which ensure-resources creates and
   *  envs.ts records. Unset for a per-commit deployment (envs.ts `previewDeployment`), whose own
   *  deploy creates them by name (./deploy.ts). */
  resources: z.object({ oauthKvId: z.string(), itxKvId: z.string(), dbId: z.string() }).optional(),
});
export type OsEnv = z.infer<typeof OsEnv>;

/** A deployment and the name it was found by (envs.ts `getOsEnv`): what the deploy, preview and
 *  sweep scripts hold once they have looked their `--env` up, and what a build is handed. */
export const OsDeployableEnv = OsEnv.extend({ name: z.string() });
export type OsDeployableEnv = z.infer<typeof OsDeployableEnv>;

/** The named resources an core/os deployment binds, from its `resourceNamePrefix`: the Artifacts
 *  namespace, the R2 bucket and the control plane's D1. The self-host config's prefix is `iterate`. */
export function osResourceNames(prefix: string) {
  return { repos: `${prefix}-repos`, files: `${prefix}-files`, db: `${prefix}-db` };
}
