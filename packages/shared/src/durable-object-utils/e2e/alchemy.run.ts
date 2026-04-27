import { createHash } from "node:crypto";
import alchemy, { type Scope } from "alchemy";
import { D1Database, DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { z } from "zod";
import { slugify } from "../../slugify.ts";
import type {
  InitializeTestRoom,
  InspectorTestRoom,
  ListedRoom,
} from "../test-harness/initialize-fronting-worker.ts";

const APP_NAME = "shared-durable-object-utils-e2e";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool().default(false),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .min(1)
          .refine(
            (hostname) => !hostname.includes("/") && !hostname.includes("://"),
            "DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES entries must be hostnames without scheme or path",
          ),
      ),
    ),
  DURABLE_OBJECT_UTILS_E2E_OUTPUT_JSON: z.stringbool().default(false),
});

const env = AlchemyEnv.parse(process.env);
const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

// Alchemy treats CI as non-interactive by default. Local Alchemy runs are a
// developer workflow, so let Alchemy use its local behavior when requested.
if (env.ALCHEMY_LOCAL) delete process.env.CI;

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
  stateStore,
});

const workerName = makeWorkerName(APP_NAME, app.stage);
const rooms = DurableObjectNamespace<InitializeTestRoom>("rooms", {
  className: "InitializeTestRoom",
  // The initialize mixin relies on SQLite-backed DO synchronous KV.
  sqlite: true,
});
const inspectors = DurableObjectNamespace<InspectorTestRoom>("inspectors", {
  className: "InspectorTestRoom",
  // The inspector routes exercise both `ctx.storage.sql` and synchronous KV.
  sqlite: true,
});
const listedRooms = DurableObjectNamespace<ListedRoom>("listed-rooms", {
  className: "ListedRoom",
  // The listed room combines local SQLite-backed init state with a D1 mirror.
  sqlite: true,
});
const listings = await D1Database("listings", {
  name: `${workerName}-listings`,
  // E2E stages are intentionally reusable by name. `adopt` lets reruns cleanly
  // take ownership instead of failing if a previous run left resources behind.
  adopt: true,
});

export const worker = await Worker(APP_NAME, {
  name: workerName,
  adopt: true,
  bindings: {
    ROOMS: rooms,
    INSPECTORS: inspectors,
    LISTED_ROOMS: listedRooms,
    DO_LISTINGS: listings,
  },
  entrypoint: "./src/durable-object-utils/test-harness/initialize-fronting-worker.ts",
  // Optional routes let CI or a developer bind the ephemeral worker to a real
  // hostname. Without them, tests use the workers.dev URL returned by Alchemy.
  routes: env.DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES.map((hostname) => ({
    pattern: `${hostname}/*`,
    adopt: true,
  })),
});

const deployment = {
  url: worker.url,
  routes: env.DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES,
};

if (env.DURABLE_OBJECT_UTILS_E2E_OUTPUT_JSON) {
  console.log(JSON.stringify(deployment));
} else {
  console.dir(deployment, { depth: null });
}

await app.finalize();

function makeWorkerName(appName: string, stage: string): string {
  const name = slugify(`${appName}-${stage}`);

  if (name.length <= 63) {
    return name;
  }

  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, 54)}-${hash}`;
}
