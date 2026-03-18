import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import alchemy, { type Scope } from "alchemy";
import { z } from "zod/v4";
import { D1Database, TanStackStart } from "alchemy/cloudflare";

const APP_NAME = "auth";

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
    .trim()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    ),
  // ================================
  VITE_AUTH_APP_ORIGIN: z.url(),
  BETTER_AUTH_SECRET: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
});

const alchemyEnv = AlchemyEnv.parse(process.env);

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

const app = await alchemy(APP_NAME, {
  password: alchemyEnv.ALCHEMY_PASSWORD,
  stage: alchemyEnv.ALCHEMY_STAGE,
  ...(alchemyEnv.ALCHEMY_LOCAL ? { local: true } : {}),
  adopt: true,
  stateStore,
});

const workerName = `${app.stage}-${APP_NAME}`;

const DB = await D1Database("auth-db", {
  name: `${workerName}-auth-db`,
  migrationsDir: "./src/server/db/migrations",
});

const worker = await TanStackStart(APP_NAME, {
  name: workerName,
  bindings: {
    DB,
    VITE_AUTH_APP_ORIGIN: alchemy.secret(alchemyEnv.VITE_AUTH_APP_ORIGIN),
    BETTER_AUTH_SECRET: alchemy.secret(alchemyEnv.BETTER_AUTH_SECRET),
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

await app.finalize();

export { worker };
