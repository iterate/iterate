import alchemy from "alchemy";
import { D1Database, TanStackStart } from "alchemy/cloudflare";
import { Exec } from "alchemy/os";
import { slugify } from "@iterate-com/shared/slugify";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateRoutes, parkWorkerRoutes } from "@iterate-com/shared/alchemy/iterate-app";
import { z } from "zod/v4";
import { AppConfig } from "./src/config.ts";
import { seedOAuthClients } from "./scripts/seed-oauth-clients.ts";

const APP_NAME = "auth";
const ADMIN_SEED_SQL_PATH = "./.alchemy/generated/auth-admin-seed.sql";

// Deploy infra env only (initAlchemy re-parses these too, but the `--park`
// path below and the stage-derived defaults need them here). Runtime config
// (secrets, origins, allowlists) is parsed separately from `APP_CONFIG_*` via
// src/config.ts — see `configEnv` below.
const AlchemyEnv = z.object({
  ALCHEMY_LOCAL: z.stringbool("ALCHEMY_LOCAL must be a boolean string").optional(),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  WORKER_ROUTES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .map((entry) => entry.replace(/\/\*$/, ""))
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .min(1)
          .refine(
            (hostname) => !hostname.includes("/") && !hostname.includes("://"),
            "WORKER_ROUTES entries must be hostnames without scheme or path",
          ),
      ),
    ),
});

// `--park` re-parks the slot edge after `--destroy`: placeholder script plus
// re-ensured, verified routes, so the next tenant's deploy finds live routes
// instead of creating them on its critical path (see parkWorkerRoutes).
// Chained as a separate invocation because alchemy exits the process inside
// the destroy phase.
if (process.argv.includes("--park")) {
  const parkEnv = AlchemyEnv.pick({
    ALCHEMY_LOCAL: true,
    ALCHEMY_STAGE: true,
    CLOUDFLARE_ACCOUNT_ID: true,
    CLOUDFLARE_API_TOKEN: true,
    WORKER_ROUTES: true,
  }).parse(process.env);
  if (!parkEnv.ALCHEMY_LOCAL) {
    await parkWorkerRoutes({
      hostnames: parkEnv.WORKER_ROUTES,
      slug: APP_NAME,
      stage: parkEnv.ALCHEMY_STAGE,
      workerName: slugify(`${APP_NAME}-${parkEnv.ALCHEMY_STAGE}`),
    });
  }
  process.exit(0);
}

const alchemyEnv = AlchemyEnv.parse(process.env);

// auth-plugins.ts derives isProduction from import.meta.env.VITE_APP_STAGE at
// build time; default it from the alchemy stage so prd builds report production.
// An explicit Doppler value still wins. (Set before initAlchemy resolves the
// stage so it's available to the `vite build` the worker runs.)
process.env.VITE_APP_STAGE ||= alchemyEnv.ALCHEMY_STAGE;

// Email OTP is on for dev stages by default; an explicit Doppler value wins.
const emailOtpEnabled =
  process.env.APP_CONFIG_EMAIL_OTP_ENABLED ??
  (alchemyEnv.ALCHEMY_STAGE.startsWith("dev") ? "true" : "false");

const deployEnvWithoutAppConfig = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== "APP_CONFIG" && !key.startsWith("APP_CONFIG_"),
  ),
);

// Map the auth config into `APP_CONFIG_*` env vars for initAlchemy. Doppler
// configs are expected to set the typed AppConfig names directly.
const configEnv: Record<string, string | undefined> = {
  ...deployEnvWithoutAppConfig,
  // initAlchemy requires ALCHEMY_LOCAL; the old auth schema defaulted it to
  // non-local when unset (only `alchemy dev` sets it true).
  ALCHEMY_LOCAL: process.env.ALCHEMY_LOCAL ?? "false",
  APP_CONFIG_AUTH_APP_ORIGIN: process.env.APP_CONFIG_AUTH_APP_ORIGIN,
  APP_CONFIG_PUBLIC_URL: process.env.APP_CONFIG_PUBLIC_URL,
  APP_CONFIG_BETTER_AUTH_SECRET: process.env.APP_CONFIG_BETTER_AUTH_SECRET,
  APP_CONFIG_SERVICE_AUTH_TOKEN: process.env.APP_CONFIG_SERVICE_AUTH_TOKEN,
  APP_CONFIG_GOOGLE_CLIENT_ID: process.env.APP_CONFIG_GOOGLE_CLIENT_ID,
  APP_CONFIG_GOOGLE_CLIENT_SECRET: process.env.APP_CONFIG_GOOGLE_CLIENT_SECRET,
  APP_CONFIG_RESEND_DOMAIN: process.env.APP_CONFIG_RESEND_DOMAIN,
  APP_CONFIG_RESEND_API_KEY: process.env.APP_CONFIG_RESEND_API_KEY,
  APP_CONFIG_SIGNUP_ALLOWLIST: process.env.APP_CONFIG_SIGNUP_ALLOWLIST,
  APP_CONFIG_ADMIN_ALLOWLIST: process.env.APP_CONFIG_ADMIN_ALLOWLIST,
  APP_CONFIG_EMAIL_OTP_ENABLED: emailOtpEnabled,
  APP_CONFIG_PROJECT_HOSTNAME_BASE: process.env.APP_CONFIG_PROJECT_HOSTNAME_BASE,
};

const ctx = await initAlchemy(APP_NAME, AppConfig, configEnv);
const { app, workerName, runtimeConfig } = ctx;

const primaryUrl = alchemyEnv.WORKER_ROUTES[0]
  ? `https://${alchemyEnv.WORKER_ROUTES[0]}`
  : undefined;

await Exec("render-admin-seed", {
  command: `tsx ./scripts/render-admin-seed.ts ${ADMIN_SEED_SQL_PATH}`,
  env: {
    APP_CONFIG_SERVICE_AUTH_TOKEN: alchemy.secret(runtimeConfig.serviceAuthToken.exposeSecret()),
    APP_CONFIG_ADMIN_ALLOWLIST: runtimeConfig.adminAllowlist,
  },
  cwd: import.meta.dirname,
});

const DB = await D1Database("auth-db", {
  name: `${workerName}-auth-db`,
  migrationsDir: "./src/server/db/migrations",
  importFiles: [ADMIN_SEED_SQL_PATH],
});

const worker = await TanStackStart(APP_NAME, {
  name: workerName,
  bindings: {
    DB,
    // Single typed config blob, parsed at runtime by src/config.ts's
    // parseConfig(env). Local dev keeps it plain-JSON for readability; deploys
    // wrap it in alchemy.secret() so Cloudflare never logs it.
    APP_CONFIG: app.local
      ? JSON.stringify(ctx.rawRuntimeConfig, null, 2)
      : alchemy.secret(JSON.stringify(ctx.rawRuntimeConfig, null, 2)),
  },
  adopt: true,
  // Without this flag, same-zone subrequests (e.g. SSR calling our own
  // /api/auth/get-session via the public hostname) bypass Worker routes and
  // hang against the originless zone for ~20s per page load.
  compatibilityFlags: ["global_fetch_strictly_public"],
  assets: {
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*"],
  },
  wrangler: {
    main: "./src/server/worker.ts",
  },
  build: {
    command: "vite build",
  },
  dev: {
    command: "vite dev --port 7101",
  },
});

console.dir(
  {
    url: primaryUrl ?? worker.url,
    workersDevUrl: worker.url,
  },
  { depth: null },
);

await app.finalize();

// Routes + DNS ensured after finalize, DNS-before-routes, edge-verified
// (see iterate-app.ts). Auth previously declared routes on the Worker
// resource and only ensured DNS afterwards — exactly the ordering that
// produces zombie routes (visible in the API, dead at the edge, every
// sign-in 522s) on fresh slots.
await IterateRoutes({ app, slug: APP_NAME }, { worker, hostnames: alchemyEnv.WORKER_ROUTES });

// Seed declarative OAuth clients (Doppler → DB) after every deployed run, so
// the database always matches AUTH_SEED_OAUTH_CLIENTS in the selected config.
// Local dev (`alchemy dev`) skips this: the server isn't up until later — run
// `pnpm seed-oauth-clients` against it manually if needed.
if (!app.local && process.env.AUTH_SEED_OAUTH_CLIENTS) {
  // Prefer the workers.dev URL, which is live immediately — a fresh custom
  // hostname (auth.iterate-preview-N.com on its first deploy) can take
  // minutes to get an edge cert, which would time out the readiness probe.
  // The custom-domain origin stays as a fallback inside seedOAuthClients:
  // some slots' workers.dev subdomains are dead at the edge (CF 1042s).
  await seedOAuthClients(process.env, { baseUrl: worker.url });
}

export { worker };
