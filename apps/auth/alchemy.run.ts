import alchemy from "alchemy";
import { D1Database, TanStackStart } from "alchemy/cloudflare";
import { Exec } from "alchemy/os";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { ensureProxiedDnsForHostnames } from "@iterate-com/shared/alchemy/iterate-app";
import { z } from "zod/v4";
import { AppConfig } from "./src/config.ts";
import { seedOAuthClients } from "./scripts/seed-oauth-clients.ts";

const APP_NAME = "auth";
const ADMIN_SEED_SQL_PATH = "./.alchemy/generated/auth-admin-seed.sql";

const AlchemyEnv = z.object({
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

const alchemyEnv = AlchemyEnv.parse(process.env);

// auth-plugins.ts derives isProduction from import.meta.env.VITE_APP_STAGE at
// build time; default it from the alchemy stage so prd builds report production.
// An explicit Doppler value still wins. (Set before initAlchemy resolves the
// stage so it's available to the `vite build` the worker runs.)
process.env.VITE_APP_STAGE ||= process.env.ALCHEMY_STAGE ?? "";

// Email OTP is on for dev stages by default; an explicit Doppler value wins.
const emailOtpEnabled =
  process.env.APP_CONFIG_EMAIL_OTP_ENABLED ??
  process.env.VITE_ENABLE_EMAIL_OTP_SIGNIN?.trim() ??
  (process.env.ALCHEMY_STAGE?.startsWith("dev") ? "true" : "false");

// Map the auth config into `APP_CONFIG_*` env vars for initAlchemy. New Doppler
// configs set these directly; the `?? <legacy>` fallbacks let existing configs
// (and the client's build-time `VITE_AUTH_APP_ORIGIN`) keep working through the
// transition — the same pattern apps/os uses. See src/config.ts for the schema.
const configEnv: Record<string, string | undefined> = {
  ...process.env,
  // initAlchemy requires ALCHEMY_LOCAL; the old auth schema defaulted it to
  // non-local when unset (only `alchemy dev` sets it true).
  ALCHEMY_LOCAL: process.env.ALCHEMY_LOCAL ?? "false",
  APP_CONFIG_AUTH_APP_ORIGIN:
    process.env.APP_CONFIG_AUTH_APP_ORIGIN ?? process.env.VITE_AUTH_APP_ORIGIN,
  APP_CONFIG_PUBLIC_URL:
    process.env.APP_CONFIG_PUBLIC_URL ??
    process.env.VITE_PUBLIC_URL ??
    process.env.VITE_AUTH_APP_ORIGIN,
  APP_CONFIG_BETTER_AUTH_SECRET:
    process.env.APP_CONFIG_BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET,
  APP_CONFIG_SERVICE_AUTH_TOKEN:
    process.env.APP_CONFIG_SERVICE_AUTH_TOKEN ?? process.env.SERVICE_AUTH_TOKEN,
  APP_CONFIG_GOOGLE_CLIENT_ID:
    process.env.APP_CONFIG_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID,
  APP_CONFIG_GOOGLE_CLIENT_SECRET:
    process.env.APP_CONFIG_GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET,
  APP_CONFIG_RESEND_DOMAIN: process.env.APP_CONFIG_RESEND_DOMAIN ?? process.env.RESEND_BOT_DOMAIN,
  APP_CONFIG_RESEND_API_KEY:
    process.env.APP_CONFIG_RESEND_API_KEY ?? process.env.RESEND_BOT_API_KEY,
  APP_CONFIG_SIGNUP_ALLOWLIST:
    process.env.APP_CONFIG_SIGNUP_ALLOWLIST ?? process.env.SIGNUP_ALLOWLIST,
  APP_CONFIG_ADMIN_ALLOWLIST: process.env.APP_CONFIG_ADMIN_ALLOWLIST ?? process.env.ADMIN_ALLOWLIST,
  APP_CONFIG_EMAIL_OTP_ENABLED: emailOtpEnabled,
};

const ctx = await initAlchemy(APP_NAME, AppConfig, configEnv);
const { app, workerName, runtimeConfig } = ctx;

const primaryUrl = alchemyEnv.WORKER_ROUTES[0]
  ? `https://${alchemyEnv.WORKER_ROUTES[0]}`
  : undefined;

await Exec("render-admin-seed", {
  command: `tsx ./scripts/render-admin-seed.ts ${ADMIN_SEED_SQL_PATH}`,
  env: {
    SERVICE_AUTH_TOKEN: alchemy.secret(runtimeConfig.serviceAuthToken.exposeSecret()),
    ADMIN_ALLOWLIST: runtimeConfig.adminAllowlist,
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
  routes: alchemyEnv.WORKER_ROUTES.map((pattern) => ({ pattern: `${pattern}/*`, adopt: true })),
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

// Worker routes need proxied DNS on the zone to fire; ensure originless
// records for every routed hostname (e.g. auth.iterate-preview-N.com).
if (!app.local) {
  await ensureProxiedDnsForHostnames({
    hostnames: alchemyEnv.WORKER_ROUTES,
    comment: `Managed by auth alchemy (${app.stage}).`,
  });
}

// Seed declarative OAuth clients (Doppler → DB) after every deployed run, so
// the database always matches AUTH_SEED_OAUTH_CLIENTS in the selected config.
// Local dev (`alchemy dev`) skips this: the server isn't up until later — run
// `pnpm seed-oauth-clients` against it manually if needed.
if (!app.local && process.env.AUTH_SEED_OAUTH_CLIENTS) {
  // Seed through the workers.dev URL, which is live immediately — a fresh
  // custom hostname (auth.iterate-preview-N.com on its first deploy) can take
  // minutes to get an edge cert, which would time out the readiness probe.
  await seedOAuthClients(process.env, { baseUrl: worker.url });
}

export { worker };
