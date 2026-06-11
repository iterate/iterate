import alchemy, { type Scope } from "alchemy";
import { D1Database, TanStackStart } from "alchemy/cloudflare";
import { Exec } from "alchemy/os";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { slugify } from "@iterate-com/shared/slugify";
import { z } from "zod/v4";
import { seedOAuthClients } from "./scripts/seed-oauth-clients.ts";

const APP_NAME = "auth";
const ADMIN_SEED_SQL_PATH = "./.alchemy/generated/auth-admin-seed.sql";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
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
  // ================================
  VITE_AUTH_APP_ORIGIN: z.url(),
  VITE_PUBLIC_URL: z.url().optional(),
  BETTER_AUTH_SECRET: z.string(),
  SERVICE_AUTH_TOKEN: z.string(),
  RESEND_BOT_DOMAIN: z.string(),
  RESEND_BOT_API_KEY: z.string(),
  SIGNUP_ALLOWLIST: z.string(),
  ADMIN_ALLOWLIST: z.string().default("*@nustom.com"),
  VITE_ENABLE_EMAIL_OTP_SIGNIN: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
});

const alchemyEnv = AlchemyEnv.parse(process.env);
const publicUrl = alchemyEnv.VITE_PUBLIC_URL ?? alchemyEnv.VITE_AUTH_APP_ORIGIN;

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);
const primaryUrl = alchemyEnv.WORKER_ROUTES[0]
  ? `https://${alchemyEnv.WORKER_ROUTES[0]}`
  : undefined;

const app = await alchemy(APP_NAME, {
  password: alchemyEnv.ALCHEMY_PASSWORD,
  stage: alchemyEnv.ALCHEMY_STAGE,
  ...(alchemyEnv.ALCHEMY_LOCAL ? { local: true } : {}),
  adopt: true,
  stateStore,
});

const workerName = slugify(`${APP_NAME}-${app.stage}`);
const emailOtpEnabled =
  alchemyEnv.VITE_ENABLE_EMAIL_OTP_SIGNIN?.trim() || (app.stage.startsWith("dev") ? "true" : "");

// auth-plugins.ts derives isProduction from import.meta.env.VITE_APP_STAGE at
// build time; default it from the alchemy stage so prd builds actually report
// production. An explicit Doppler value still wins.
process.env.VITE_APP_STAGE ||= app.stage;

await Exec("render-admin-seed", {
  command: `tsx ./scripts/render-admin-seed.ts ${ADMIN_SEED_SQL_PATH}`,
  env: {
    SERVICE_AUTH_TOKEN: alchemy.secret(alchemyEnv.SERVICE_AUTH_TOKEN),
    ADMIN_ALLOWLIST: alchemyEnv.ADMIN_ALLOWLIST,
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
    VITE_AUTH_APP_ORIGIN: alchemy.secret(alchemyEnv.VITE_AUTH_APP_ORIGIN),
    VITE_PUBLIC_URL: alchemy.secret(publicUrl),
    BETTER_AUTH_SECRET: alchemy.secret(alchemyEnv.BETTER_AUTH_SECRET),
    SERVICE_AUTH_TOKEN: alchemy.secret(alchemyEnv.SERVICE_AUTH_TOKEN),
    RESEND_BOT_DOMAIN: alchemy.secret(alchemyEnv.RESEND_BOT_DOMAIN),
    RESEND_BOT_API_KEY: alchemy.secret(alchemyEnv.RESEND_BOT_API_KEY),
    SIGNUP_ALLOWLIST: alchemy.secret(alchemyEnv.SIGNUP_ALLOWLIST),
    ADMIN_ALLOWLIST: alchemy.secret(alchemyEnv.ADMIN_ALLOWLIST),
    VITE_ENABLE_EMAIL_OTP_SIGNIN: alchemy.secret(emailOtpEnabled),
    GOOGLE_CLIENT_ID: alchemy.secret(alchemyEnv.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: alchemy.secret(alchemyEnv.GOOGLE_CLIENT_SECRET),
  },
  routes: alchemyEnv.WORKER_ROUTES.map((pattern) => ({ pattern: `${pattern}/*`, adopt: true })),
  adopt: true,
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

// Seed declarative OAuth clients (Doppler → DB) after every deployed run, so
// the database always matches AUTH_SEED_OAUTH_CLIENTS in the selected config.
// Local dev (`alchemy dev`) skips this: the server isn't up until later — run
// `pnpm seed-oauth-clients` against it manually if needed.
if (!app.local && process.env.AUTH_SEED_OAUTH_CLIENTS) {
  await seedOAuthClients(process.env);
}

export { worker };
