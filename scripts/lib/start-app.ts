/**
 * The scripts of a TanStack Start app on Workers — dash, agents, notes, voice and kit. An app
 * describes itself in apps/<app>/scripts/app.ts (a StartApp below), its vite.config.ts hands the
 * Cloudflare Vite plugin `startAppWorkerConfig`, and its package scripts run `startAppCli`:
 *
 *   deploy                     vite build → wrangler deploy with secrets → /healthz smoke (deploy-app.ts)
 *   ensure-resources           the proxied DNS record for a custom-domain baseUrl (dash, kit); a
 *                              workers.dev baseUrl has no zone in the account, so it only warns
 *   generate-route-tree        regenerate src/routeTree.gen.ts outside `vite dev`/`vite build`; `--check`
 *                              fails (and restores the file) when the checked-in tree is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Generator, getConfig } from "@tanstack/router-generator";
import { createCli, t } from "trpc-cli";
import { z } from "zod";
import { agentsEnvs, dashEnvs, kitEnvs, notesEnvs, osEnvs, voiceEnvs } from "../../envs.ts";
import { deployApp } from "./deploy-app.ts";
import { ensureProxiedDnsRecord, viteBuild } from "./deploy-helpers.ts";
import { resolveEnvContext, type DeployableEnv } from "./env-context.ts";
import { COMPATIBILITY_DATE, OBSERVABILITY, registrableDomainOf } from "./wrangler-config.ts";

/** One deployed environment of a start app: what every deploy needs, plus the worker and its origin. */
export interface StartAppEnv extends DeployableEnv {
  workerName: string;
  baseUrl: string;
  /** PostHog's project key (envs.ts `ITERATE_POSTHOG_PROJECT_KEY`): the worker's
   *  `POSTHOG_PROJECT_KEY`, and the app's pages start posthog-js with it. Unset ⇒ no PostHog. */
  posthogProjectKey?: string;
}

/** What apps/<app>/scripts/app.ts declares; everything in this module is the same program over it. */
export interface StartApp {
  /** "dash": the directory under apps/, the Doppler project and the local-dev worker all carry this name. */
  name: string;
  /** The app's directory — `new URL("..", import.meta.url)` from scripts/app.ts. */
  root: URL;
  /** The app's map in envs.ts. */
  envs: Record<string, StartAppEnv>;
}

/** The zone one of our own ORIGINS denies: its registrable domain — except on workers.dev, where that
 *  is the whole account's `<subdomain>.workers.dev`, shared with every worker anyone on the account
 *  deploys (a self-host tried out on it included). Nothing there is userspace: a workers.dev host is
 *  a worker script, and projects on one are paths on its origin. So the host itself. */
function ownOriginZone(url: string): string {
  const hostname = new URL(url).hostname;
  return hostname.endsWith(".workers.dev") ? hostname : registrableDomainOf(hostname);
}

/** THE ZONES THAT ARE OURS, from envs.ts: every OS deployment's origins, its project wildcard
 *  and custom apexes, and the first-party apps' origins — deduped and sorted. The browser-auth gate
 *  (`appAuth` `denyZones`) refuses to connect an app to an issuer under any of them: a project host
 *  or a custom apex is userspace and could serve a look-alike issuer. */
export function ownZones(): string[] {
  // These existing userspace hosts remain untrusted issuers even after their deployment code is removed.
  const zones = new Set([
    "iterate.app",
    "iterate.com",
    ...Array.from({ length: 19 }, (_, i) => `iterate-preview-${i + 1}.app`),
  ]);
  for (const env of Object.values(osEnvs)) {
    zones.add(ownOriginZone(env.baseUrl));
    zones.add(ownOriginZone(env.mcpBaseUrl));
    if (env.dashBaseUrl) zones.add(ownOriginZone(env.dashBaseUrl));
    if (env.ingressRouting?.type === "subdomains") zones.add(env.ingressRouting.hostname);
    if (env.projectWildcard) zones.add(env.projectWildcard.hostname);
    for (const hostname of Object.keys(env.temporaryCustomHostnames || {})) zones.add(hostname);
  }
  for (const envs of [dashEnvs, agentsEnvs, notesEnvs, voiceEnvs, kitEnvs])
    for (const env of Object.values(envs) as { baseUrl: string }[])
      zones.add(ownOriginZone(env.baseUrl));
  return [...zones].sort();
}

/** The app's Worker config for one envs.ts environment — or, with none, local dev — which its
 *  vite.config.ts hands the Cloudflare Vite plugin (`cloudflare({ config })`); there is no wrangler
 *  file. `vite build` snapshots it into dist/server/wrangler.json, what deploy and a per-PR preview
 *  ship. The environment is CLOUDFLARE_ENV, as deployApp and buildStartApp set it. */
export function startAppWorkerConfig(app: StartApp, envName: string | undefined) {
  const env = envName ? app.envs[envName] : undefined;
  if (envName && !env)
    throw new Error(
      `apps/${app.name}: unknown env ${JSON.stringify(envName)}; known envs: ${Object.keys(app.envs).join(", ")}`,
    );
  return {
    name: env?.workerName ?? app.name,
    main: "src/server.ts",
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    durable_objects: { bindings: [{ name: "BROWSER_SESSION", class_name: "BrowserSession" }] },
    exports: { BrowserSession: { type: "durable-object" as const, storage: "sqlite" as const } },
    vars: {
      // the default issuer: prd's platform origin (envs.ts always has a prd entry); a per-PR preview's
      // config swaps in the same PR's os-next preview (startAppPreviewConfig), and local dev takes a
      // local one from a gitignored .dev.vars
      ITERATE_ORIGIN: osEnvs.prd!.baseUrl,
      // our own zones: project hosts and custom apexes are userspace and could serve a look-alike
      // issuer, so the browser-auth gate refuses to CONNECT to an issuer under them (the default
      // issuer is exempt) — derived from envs.ts, never spelled twice
      ITERATE_DENY_ZONES: ownZones().join(","),
      // unset ⇒ no var, no PostHog
      ...(env?.posthogProjectKey && { POSTHOG_PROJECT_KEY: env.posthogProjectKey }),
    },
    observability: OBSERVABILITY,
    assets: { binding: "ASSETS", not_found_handling: "none" as const, run_worker_first: true },
    ...(env && {
      account_id: env.cloudflareAccountId,
      workers_dev: true,
    }),
    // A workers.dev baseUrl is served by workers_dev itself — no custom route. A custom domain (a
    // real zone) gets a route bound to that zone.
    ...(env &&
      !new URL(env.baseUrl).hostname.endsWith(".workers.dev") && {
        routes: [
          {
            pattern: `${new URL(env.baseUrl).hostname}/*`,
            zone_name: registrableDomainOf(env.baseUrl),
          },
        ],
      }),
  };
}

async function deploy(app: StartApp, options: { env?: string }) {
  await deployApp({
    appRoot: fileURLToPath(app.root),
    appLabel: `apps/${app.name}`,
    envs: app.envs,
    dopplerProject: app.name,
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    smokes: (env) => [
      { url: `${env.baseUrl}/healthz`, ok: (status) => status === 200, label: "health" },
    ],
  });
}

async function ensureResources(app: StartApp, options: { env?: string }) {
  const ctx = await resolveEnvContext({
    envs: app.envs,
    dopplerProject: app.name,
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  await ensureProxiedDnsRecord(
    ctx,
    zones,
    new URL(ctx.env.baseUrl).hostname,
    `${app.name[0].toUpperCase()}${app.name.slice(1)} app`,
  );
}

/**
 * Regenerates src/routeTree.gen.ts with the same generator + config that @tanstack/react-start's vite
 * plugin uses. `check` fails
 * (and restores the original file) when the checked-in tree is stale, so route files added or renamed
 * without regenerating are caught.
 */
async function generateRouteTree(app: StartApp, options: { check?: boolean }) {
  const root = path.resolve(fileURLToPath(app.root));
  const routeTreePath = path.resolve(root, "src/routeTree.gen.ts");

  const config = getConfig(
    {
      routesDirectory: path.resolve(root, "src/routes"),
      generatedRouteTree: routeTreePath,
      target: "react",
      // Mirrors the router options in vite.config.ts.
      addExtensions: true,
      semicolons: true,
      quoteStyle: "double",
      // @tanstack/start-plugin-core appends this Register block when the vite plugin runs the
      // generator; mirror it so this script produces the same output as the build. Source of the
      // footer (pin bumps may change it):
      // https://github.com/TanStack/router/blob/main/packages/start-plugin-core/src/start-compiler-plugin/route-tree-footer.ts
      routeTreeFileFooter: [
        [
          'import type { getRouter } from "./router.tsx";',
          'import type { createStart } from "@tanstack/react-start";',
          'declare module "@tanstack/react-start" {',
          "  interface Register {",
          "    ssr: true;",
          "    router: Awaited<ReturnType<typeof getRouter>>;",
          "  }",
          "}",
        ].join("\n"),
      ],
    },
    root,
  );

  // Generator.run() writes the file in place. In check mode we always restore the original afterwards
  // (even if run() throws) so a failed/interrupted check never leaves a mutated working tree that a
  // later check would compare against.
  let before = "";
  try {
    before = readFileSync(routeTreePath, "utf8");
  } catch {
    /* first generation: no file yet */
  }
  let after = before;
  try {
    await new Generator({ config, root }).run();
    after = readFileSync(routeTreePath, "utf8");
  } finally {
    if (options.check) writeFileSync(routeTreePath, before);
  }

  if (before === after) {
    console.log("routeTree.gen.ts is up to date");
  } else if (options.check) {
    console.error(
      "routeTree.gen.ts is stale. Run `pnpm routes:generate` (or `pnpm dev`) and commit the result.",
    );
    process.exit(1);
  } else {
    console.log("routeTree.gen.ts regenerated");
  }
}

/** `vite build` for one env: the cloudflare plugin snapshots that env's Worker config
 *  (startAppWorkerConfig) into dist/server/wrangler.json, which is what a preview deploy of the app
 *  starts from. */
export function buildStartApp(app: StartApp, env: string) {
  return viteBuild(fileURLToPath(app.root), env);
}

/** The config `wrangler preview` reads for one per-PR preview of a start app, as a pure function
 *  of the built config (dist/server/wrangler.json, the `preview` env's) — the shape of
 *  cloudflare-os's `buildPreviewConfigs`. An app on top of the platform is an OAuth client and
 *  nothing else: no secrets, no data of its own, one Durable Object class for the browser session,
 *  and its vars with the issuer swapped for the same PR's os-next preview. The top level is
 *  the parent worker (what `wrangler preview` branches from; deployed from this same config the
 *  first time it is missing) with the class as a legacy `migrations` entry, because the pkg.pr.new
 *  wrangler build that provisions previews predates `exports`; the `previews` block is the one
 *  preview's own — assets are not a `previews` key and are inherited from the top level. */
export function startAppPreviewConfig(
  built: Record<string, any>,
  input: { issuer: string },
): Record<string, unknown> {
  const { exports, topLevelName, ...config } = built;
  return {
    ...config,
    preview_urls: true,
    migrations: [{ tag: "v1", new_sqlite_classes: Object.keys(exports) }],
    previews: {
      observability: config.observability,
      durable_objects: config.durable_objects,
      // Every var the built worker carries (ITERATE_DENY_ZONES among them), the issuer swapped for this
      // PR's os-next preview.
      vars: { ...config.vars, ITERATE_ORIGIN: input.issuer },
    },
  };
}

/** Write dist/server/wrangler.preview.json from the build and return its path. */
export function writeStartAppPreviewConfig(app: StartApp, input: { issuer: string }): string {
  const dir = path.join(fileURLToPath(app.root), "dist/server");
  const built = JSON.parse(readFileSync(path.join(dir, "wrangler.json"), "utf8"));
  const file = path.join(dir, "wrangler.preview.json");
  writeFileSync(file, `${JSON.stringify(startAppPreviewConfig(built, input), null, 2)}\n`);
  return file;
}

/**
 * The app's command line: `tsx scripts/app.ts <command> [--env <name>]` behind its package scripts.
 * `--env` names the envs.ts entry; deploy and ensure-resources fall back to CI's DOPPLER_CONFIG
 * (env-context.ts).
 */
export function startAppCli(app: StartApp) {
  const env = z.string().describe("Target environment name from envs.ts");
  return createCli({
    name: app.name,
    router: t.router({
      deploy: t.procedure
        .input(z.object({ env: env.optional() }))
        .handler(({ input }) => deploy(app, input)),
      ensureResources: t.procedure
        .input(z.object({ env: env.optional() }))
        .handler(({ input }) => ensureResources(app, input)),
      generateRouteTree: t.procedure
        .input(
          z.object({
            check: z
              .boolean()
              .optional()
              .describe("Fail when the checked-in tree is stale instead of rewriting it"),
          }),
        )
        .handler(({ input }) => generateRouteTree(app, input)),
    }),
  });
}
