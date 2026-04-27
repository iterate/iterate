import { compileRawAppConfigFromEnv, parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { slugify } from "@iterate-com/shared/slugify";
import alchemy, { type Scope } from "alchemy";
import {
  Ai,
  D1Database,
  DurableObjectNamespace,
  Self,
  TanStackStart,
  Worker,
  WorkerLoader,
} from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { z } from "zod";
import { AppConfig } from "./src/app.ts";
import type { IterateAgent } from "./src/durable-objects/iterate-agent.ts";

const APP_NAME = "agents";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool(),
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

const env = AlchemyEnv.parse(process.env);
const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);
const primaryUrl = env.WORKER_ROUTES[0] ? `https://${env.WORKER_ROUTES[0]}` : undefined;
const compiledAppConfig = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});
const rawAppConfig = compileRawAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});

if (env.ALCHEMY_LOCAL) delete process.env.CI;

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
  stateStore,
});

// Cloudflare's edge-preview endpoint (used by wrangler's remote-binding proxy
// worker for AI/etc. in local dev) silently fails with `InferenceUpstreamError`
// when the worker name contains characters outside `[a-z0-9-]` (e.g. Doppler
// personal configs use `dev_<username>` as the stage).
const workerName = slugify(`${APP_NAME}-${app.stage}`);
const db = await D1Database("agents-db", {
  name: `${workerName}-db`,
  migrationsDir: "./drizzle",
  adopt: true,
});
const iterateAgent = DurableObjectNamespace<IterateAgent>("iterate-agent", {
  className: "IterateAgent",
  sqlite: true,
});
// Deliberately no `<ChildStreamAutoSubscriber>` type parameter here: combined
// with `DurableObjectNamespace<IterateAgent>` above, TS ends up following
// `Agent<CloudflareEnv>` → `typeof worker.Env` → back to both DOs and reports
// `worker` as recursively referencing itself. Skipping the type parameter on
// the second binding breaks that cycle without losing correctness: the class
// itself still extends `Agent<CloudflareEnv>`, and `entry.workerd.ts` imports
// it by value.
const childStreamAutoSubscriber = DurableObjectNamespace("child-stream-auto-subscriber", {
  className: "ChildStreamAutoSubscriber",
  sqlite: true,
});
// No `<MCPClient>` type parameter — see comment on `childStreamAutoSubscriber`
// above. The DO is imported by value in `entry.workerd.ts`, so the binding
// type is inferred from the alchemy resource.
const mcpClient = DurableObjectNamespace("mcp-client", {
  className: "MCPClient",
  sqlite: true,
});

export const worker = await TanStackStart(APP_NAME, {
  name: workerName,
  adopt: true,
  bindings: {
    DB: db,
    ITERATE_AGENT: iterateAgent,
    CHILD_STREAM_AUTO_SUBSCRIBER: childStreamAutoSubscriber,
    MCP_CLIENT: mcpClient,
    LOADER: WorkerLoader(),
    AI: Ai(),
    APP_CONFIG: alchemy.secret(JSON.stringify(rawAppConfig, null, 2)),
    // Same pattern as `apps/events/alchemy.run.ts` + `DynamicWorkerEgressGateway`: nested
    // codemode workers need a real `Fetcher` for `globalOutbound`, not `globalThis.fetch`.
    CODEMODE_OUTBOUND_FETCH: Worker.experimentalEntrypoint(Self, "CodemodeOutboundFetch"),
  },
  compatibilityFlags: ["enable_request_signal"],
  wrangler: {
    main: "./src/entry.workerd.ts",
  },
  routes: env.WORKER_ROUTES.map((hostname) => ({
    pattern: `${hostname}/*`,
    adopt: true,
  })),
  observability: {
    enabled: true,
    headSamplingRate: 1,
    logs: {
      enabled: true,
      headSamplingRate: 1,
      persist: true,
      invocationLogs: true,
    },
    traces: {
      enabled: true,
      persist: true,
      headSamplingRate: 1,
    },
  },
});

console.dir(
  {
    config: compiledAppConfig,
    url: primaryUrl ?? worker.url,
    workersDevUrl: worker.url,
  },
  { depth: null },
);

await app.finalize();
