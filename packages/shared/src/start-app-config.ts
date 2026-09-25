// start-app-config.ts — THE CONFIGURATION OF AN APP ON TOP of the platform: dash, agents, notes,
// admin, voice and kit, TanStack Start apps that are each an OAuth client of apps/os and nothing
// else. The platform's mechanism (app-config.ts): one `APP_CONFIG` object, and any key set alone
// as an `APP_CONFIG_*` var merged on top.
//
//   { urls: { os, dash, agents, notes, admin, voice, kit }, denyZones, posthogProjectKey }
//
// scripts/lib/start-app.ts writes it from envs.ts as the Worker's one `APP_CONFIG` var
// (`startAppWorkerConfig`), and a per-PR preview swaps in the same PR's origins
// (`startAppPreviewConfig`). The apps hold no secrets, so nothing comes from Doppler. Local dev
// starts from prd's and names a local platform, or a local app, in the app's gitignored
// `.dev.vars`:
//
//   APP_CONFIG_URLS__OS=http://localhost:8788
//   APP_CONFIG_URLS__NOTES=http://localhost:5174

import { z } from "zod";
import { dnsName, httpOrigin, optionalOrigin, parseAppConfigVars } from "./app-config.ts";

/** THE SCHEMA. `urls` names the platform and every first-party app (scripts/lib/start-app.ts
 *  `FIRST_PARTY_APPS` is typed against it, so an app added there is added here). */
export const StartAppConfig = z.object({
  urls: z
    .object({
      /** THE PLATFORM this app signs in against (apps/os): the default issuer, and `/api` on it the
       *  resource. Kit can also sign a device in to another platform a link names (device-auth.ts). */
      os: httpOrigin,
      // THE FIRST-PARTY APPS, what a link from one app to another follows: the dash's directory of
      // apps (apps/dash/src/apps.ts), Kit's link to the sessions in the dash, the admin app's "View
      // dash as". The same environment's as `os`. Blank ⇒ no link: a per-PR preview names only the
      // apps its run deploys, because production does not know the preview's projects.
      dash: optionalOrigin,
      agents: optionalOrigin,
      notes: optionalOrigin,
      admin: optionalOrigin,
      voice: optionalOrigin,
      kit: optionalOrigin,
    })
    // the prefault must satisfy the input type; `os: ""` then fails naming urls.os
    .prefault({ os: "" }),
  /** OUR OWN ZONES (scripts/lib/start-app.ts `ownZones`, from envs.ts): project hosts and custom
   *  apexes are userspace and could serve a look-alike issuer, so the browser-auth gate (`appAuth`
   *  `denyZones`, the SDK's `issuerOriginOf`) refuses to connect to an issuer under one. The
   *  default issuer, `urls.os`, is exempt. */
  denyZones: z.array(dnsName),
  /** PostHog's project key (envs.ts `posthogProjectKey`, prd only): the app's pages start
   *  posthog-js with it. A public key, not a secret. Blank ⇒ no PostHog. */
  posthogProjectKey: z.string().trim().default(""),
});

export type StartAppConfig = z.output<typeof StartAppConfig>;

const startAppConfigByEnv = new WeakMap<object, StartAppConfig>();

/** The configuration of the isolate `env` belongs to (`import { env } from "cloudflare:workers"`):
 *  parsed on first use, then the same object every time. A malformed field throws HERE, on the
 *  first request, naming the field. */
export function startAppConfigOf(env: object): StartAppConfig {
  let config = startAppConfigByEnv.get(env);
  if (!config) {
    config = parseAppConfigVars(env, StartAppConfig);
    startAppConfigByEnv.set(env, config);
  }
  return config;
}
