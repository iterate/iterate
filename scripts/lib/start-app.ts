/**
 * The scripts of a TanStack Start app on Workers — dash, agents, notes and voice. Each carried
 * byte-identical copies of generate-wrangler-config, deploy, ensure-resources, erase-data and
 * generate-route-tree that differed only in the app's name; this is the one copy. An app
 * describes itself in apps/<app>/scripts/app.ts (a StartApp below) and its package scripts run
 * `startAppCli`, whose commands keep the old scripts' names:
 *
 *   generate-wrangler-config   expand the app's envs.ts map into its gitignored wrangler.jsonc.
 *                              vite.config.ts calls writeWranglerConfig before the cloudflare plugin
 *                              reads the file, so dev/build never see a stale one.
 *   deploy                     vite build → wrangler deploy with secrets → /healthz smoke (deploy-app.ts)
 *   ensure-resources           the proxied DNS record for a custom-domain baseUrl (dash); a workers.dev
 *                              baseUrl has no zone in the account, so it only warns
 *   erase-data                 nothing to erase — these apps own no server data; the line says where it lives
 *   generate-route-tree        regenerate src/routeTree.gen.ts outside `vite dev`/`vite build`; `--check`
 *                              fails (and restores the file) when the checked-in tree is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Generator, getConfig } from "@tanstack/router-generator";
import { createCli, t } from "trpc-cli";
import { z } from "zod";
import { deployApp } from "./deploy-app.ts";
import { ensureProxiedDnsRecord } from "./deploy-helpers.ts";
import { resolveEnvContext, type DeployableEnv } from "./env-context.ts";
import { OBSERVABILITY, writeGeneratedWranglerConfig } from "./wrangler-config.ts";

/** One deployed environment of a start app: what every deploy needs, plus the worker and its origin. */
export interface StartAppEnv extends DeployableEnv {
  workerName: string;
  baseUrl: string;
}

/** What apps/<app>/scripts/app.ts declares; everything in this module is the same program over it. */
export interface StartApp {
  /** "dash": the directory under apps/, the Doppler project and the local-dev worker all carry this name. */
  name: string;
  /** The app's directory — `new URL("..", import.meta.url)` from scripts/app.ts. */
  root: URL;
  /** The app's map in envs.ts. */
  envs: Record<string, StartAppEnv>;
  /** erase-data's whole output: the app owns no server data, and this says where the data lives instead. */
  nothingToErase: string;
}

/** Write the app's gitignored wrangler.jsonc from its envs.ts map and return the path. */
export function writeWranglerConfig(app: StartApp) {
  const bindings = {
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    durable_objects: { bindings: [{ name: "BROWSER_SESSION", class_name: "BrowserSession" }] },
    exports: { BrowserSession: { type: "durable-object", storage: "sqlite" } },
    vars: {
      ITERATE_ORIGIN: "https://os.iterate2.com",
      // our own zones: project hosts and custom apexes are userspace and could serve a look-alike
      // issuer, so the browser-auth gate refuses to CONNECT to an issuer under them (the default
      // issuer is exempt) — envs.ts osNextEnvs.prd names the same hostnames
      ITERATE_DENY_ZONES:
        "iterate2.app,project-worker.iterate.com,iterate2.com,iterate.com,iterate.workers.dev,iterate-dev-preview.workers.dev,garple.com,lispwoso.com,templestein.com",
    },
    observability: OBSERVABILITY,
    assets: { binding: "ASSETS", not_found_handling: "none", run_worker_first: true },
  };
  return writeGeneratedWranglerConfig({
    configUrl: new URL("wrangler.jsonc", app.root),
    appLabel: `apps/${app.name}`,
    config: {
      $schema: "node_modules/wrangler/config-schema.json",
      name: app.name,
      main: "src/worker.ts",
      compatibility_date: "2026-09-01",
      ...bindings,
      env: Object.fromEntries(
        Object.entries(app.envs).map(([name, env]) => [
          name,
          {
            name: env.workerName,
            account_id: env.cloudflareAccountId,
            workers_dev: true,
            ...bindings,
            // A workers.dev baseUrl is served by workers_dev itself — no custom route. A custom
            // domain (a real zone) gets a route bound to that zone.
            ...(new URL(env.baseUrl).hostname.endsWith(".workers.dev")
              ? {}
              : {
                  routes: [
                    {
                      pattern: `${new URL(env.baseUrl).hostname}/*`,
                      zone_name: new URL(env.baseUrl).hostname.split(".").slice(-2).join("."),
                    },
                  ],
                }),
          },
        ]),
      ),
    },
  });
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

async function eraseData(app: StartApp, options: { env: string }) {
  const ctx = await resolveEnvContext({
    envs: app.envs,
    dopplerProject: app.name,
    env: options.env,
  });
  console.log(`${ctx.name}: ${app.nothingToErase}`);
}

/**
 * Regenerates src/routeTree.gen.ts with the same generator + config that @tanstack/react-start's vite
 * plugin uses (apps/auth/scripts/generate-route-tree.ts, verbatim but for the paths). `check` fails
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

/**
 * The app's command line: `tsx scripts/app.ts <command> [--env <name>]` behind its package scripts.
 * `--env` names the envs.ts entry; deploy and ensure-resources fall back to CI's DOPPLER_CONFIG
 * (env-context.ts), erase-data never does.
 */
export function startAppCli(app: StartApp) {
  const env = z.string().describe("Target environment name from envs.ts");
  return createCli({
    name: app.name,
    router: t.router({
      deploy: t.procedure
        .input(z.object({ env: env.optional() }))
        .handler(({ input }) => deploy(app, input)),
      generateWranglerConfig: t.procedure.handler(() => console.log(writeWranglerConfig(app))),
      ensureResources: t.procedure
        .input(z.object({ env: env.optional() }))
        .handler(({ input }) => ensureResources(app, input)),
      eraseData: t.procedure.input(z.object({ env })).handler(({ input }) => eraseData(app, input)),
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
