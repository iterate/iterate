import { execSync } from "node:child_process";
import * as fs from "node:fs";
import alchemy, { type Scope } from "alchemy";
import {
  Hyperdrive,
  R2Bucket,
  Container,
  DurableObjectNamespace,
  TanStackStart,
  WorkerLoader,
} from "alchemy/cloudflare";
import { Database, Branch, Role } from "alchemy/planetscale";
import * as R from "remeda";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { Exec } from "alchemy/os";
import z from "zod";
import { addSuperAdminUser } from "./sdk/cli/commands/admin.ts";

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

const app = await alchemy("iterate", {
  password: process.env.ALCHEMY_PASSWORD,
  stateStore,
  destroyOrphans: false,
});

if (!/^[\w-]+$/.test(app.stage)) {
  throw new Error(`Invalid stage: ${app.stage}`);
}

const isProduction = app.stage === "prd";
const isStaging = app.stage === "stg";
const isDevelopment = app.local;
// Either a PR or someone deploying locally
const isPreview = app.stage.startsWith("pr-") || app.stage.startsWith("local-");

async function verifyDopplerEnvironment() {
  if (process.env.SKIP_DOPPLER_CHECK) return;
  // Exit if the doppler environment is not prd when trying to deploy to production
  try {
    const dopplerConfig = z
      .object({ environment: z.string() })
      .parse(JSON.parse(execSync("doppler configs get --json", { encoding: "utf-8" })));

    if (isProduction && dopplerConfig.environment !== "prd") {
      throw new Error(
        `You are trying to deploy to production, but the doppler environment is set to ${dopplerConfig.environment}, exiting...`,
      );
    }

    if (isStaging && dopplerConfig.environment !== "stg") {
      throw new Error(
        `You are trying to deploy to staging, but the doppler environment is set to ${dopplerConfig.environment}, exiting...`,
      );
    }

    if (isDevelopment && !dopplerConfig.environment.startsWith("dev")) {
      throw new Error(
        `You are trying to develop locally, but the doppler environment is set to ${dopplerConfig.environment}, exiting...`,
      );
    }
  } catch (e) {
    throw new Error("Failed to determine doppler environment", { cause: e });
  }
}

async function uploadSourcemaps() {
  if (!isDevelopment) {
    await Exec("posthog-sourcemap-upload", {
      command: "pnpm posthog:sourcemaps:upload",
    });
  }
}
const Required = z.string().nonempty();
const Optional = z.string().optional();
const Env = z.object({
  OPENAI_API_KEY: Required,
  BETTER_AUTH_SECRET: Required,
  BRAINTRUST_API_KEY: Required,
  POSTHOG_PUBLIC_KEY: Required,
  GOOGLE_CLIENT_ID: Required,
  GOOGLE_CLIENT_SECRET: Required,
  SLACK_CLIENT_ID: Required,
  SLACK_CLIENT_SECRET: Required,
  SLACK_SIGNING_SECRET: Required,
  SLACK_ITERATE_TEAM_ID: Required,
  GITHUB_APP_CLIENT_ID: Required,
  GITHUB_APP_CLIENT_SECRET: Required,
  GITHUB_APP_PRIVATE_KEY: Required,
  GITHUB_APP_ID: Required,
  GITHUB_ESTATES_DEFAULT_INSTALLATION_ID: Required,
  EXPIRING_URLS_SIGNING_KEY: Required,
  GITHUB_WEBHOOK_SECRET: Required,
  PROJECT_NAME: Required,
  EXA_API_KEY: Required,
  CLOUDFLARE_API_TOKEN: Required,
  CLOUDFLARE_ACCOUNT_ID: Required,
  REPLICATE_API_TOKEN: Required,
  ITERATE_USER: Required,
  STRIPE_SECRET_KEY: Required,
  STRIPE_WEBHOOK_SECRET: Required,
  STRIPE_PRICING_PLAN_ID: Required,
  SERVICE_AUTH_TOKEN: Required,

  // optional keys
  ADMIN_EMAIL_HOSTS: Optional,
  TEST_USER_PATTERNS: Optional,
  POSTHOG_ENVIRONMENT: Optional,
  ONBOARDING_E2E_TEST_SETUP_PARAMS: Optional,
  ITERATE_NOTIFICATION_ESTATE_ID: Optional,
  RESEND_API_KEY: Optional,
  RESEND_FROM_EMAIL: Optional,
  /** comma-separated list of emails to invite to customer slack connect channels by default. e.g. "jonas@nustom.com,misha@nustom.com" */
  SLACK_CONNECT_DEFAULT_INVITEES: Optional,

  // Vite environment variables
  VITE_PUBLIC_URL: Required,
  VITE_APP_STAGE: Required,
  VITE_ENABLE_TEST_ADMIN_USER: Optional,
  VITE_ENABLE_EMAIL_OTP_SIGNIN: Optional,
  VITE_POSTHOG_PUBLIC_KEY: Optional,
  VITE_POSTHOG_PROXY_URI: Optional,
  VITE_TEST_ADMIN_CREDENTIALS: Optional,
} satisfies Record<string, typeof Required | typeof Optional>);
async function setupEnvironmentVariables() {
  const parsed = Env.safeParse({ ...process.env, VITE_APP_STAGE: app.stage, APP_STAGE: app.stage });
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  }
  return R.mapValues(parsed.data, alchemy.secret);
}

async function setupDatabase() {
  const migrate = async (origin: string) => {
    if (!origin) throw new Error("Database connection string is not set");
    const res = await Exec("db-migrate", {
      env: {
        PSCALE_DATABASE_URL: origin,
      },
      command: "pnpm db:migrate",
    });

    if (res.exitCode !== 0) {
      throw new Error(`Failed to run migrations: ${res.stderr}`);
    }

    // "Production already has it" -- @Rahul
    await addSuperAdminUser(origin);
  };

  if (isDevelopment) {
    // In dev we don't need a planetscale db, just a hyperdrive that points to the local postgres instance
    const origin = "postgres://postgres:postgres@localhost:5432/iterate";
    const hyperdrive = await Hyperdrive("iterate-postgres", {
      origin,
      name: "iterate-postgres",
      adopt: true,
      dev: {
        origin,
      },
    });

    await migrate(origin);

    return {
      ITERATE_POSTGRES: hyperdrive,
    };
  }

  if (isPreview) {
    // In preview we use `dev` as the database name
    // And use branches from that database to keep separate data for each preview, with leaking production data
    const planetscaleDb = await Database("planetscale-db", {
      name: "dev",
      clusterSize: "PS_10",
      adopt: true,
      arch: "x86",
      kind: "postgresql",
      allowDataBranching: true,
      delete: false,
    });

    const branch = await Branch("db-preview-branch", {
      name: app.stage,
      database: planetscaleDb,
      isProduction: false,
      adopt: true,
      // Branch will be deleted when the PR is merged or the preview is deleted
      delete: true,
    });

    const role = await Role("db-role", {
      database: planetscaleDb,
      inheritedRoles: ["postgres"],
      branch,
      // Role will be deleted when the PR is merged or the preview is deleted
      delete: true,
    });

    const hyperdrive = await Hyperdrive("iterate-postgres", {
      origin: role.connectionUrl,
      adopt: true,
      caching: {
        disabled: true,
      },
    });

    await migrate(role.connectionUrl.unencrypted);

    return {
      ITERATE_POSTGRES: hyperdrive,
    };
  }

  if (isStaging) {
    const planetscaleDb = await Database("planetscale-db", {
      name: "staging",
      clusterSize: "PS_10",
      adopt: true,
      arch: "x86",
      kind: "postgresql",
      delete: false,
    });

    const role = await Role("db-role", {
      database: planetscaleDb,
      inheritedRoles: ["postgres"],
      delete: false,
    });

    const hyperdrive = await Hyperdrive("iterate-postgres", {
      origin: role.connectionUrl,
      adopt: true,
      caching: {
        disabled: true,
      },
    });

    // Use the preset admin connection string to run migrations
    await migrate(process.env.DRIZZLE_ADMIN_POSTGRES_CONNECTION_STRING!);

    return {
      ITERATE_POSTGRES: hyperdrive,
    };
  }

  if (isProduction) {
    // Use predefined connection strings for production
    const hyperdrive = await Hyperdrive("iterate-postgres", {
      origin: process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING!,
      adopt: true,
      caching: {
        disabled: true,
      },
    });

    await migrate(process.env.DRIZZLE_ADMIN_POSTGRES_CONNECTION_STRING!);

    return {
      ITERATE_POSTGRES: hyperdrive,
    };
  }

  throw new Error(`Unsupported environment: ${app.stage}`);
}

async function setupDurableObjects() {
  const SANDBOX = await Container<import("./backend/worker.ts").Sandbox>("sandbox", {
    className: "Sandbox",
    name: isProduction ? "os-sandbox" : undefined,
    build: {
      dockerfile: "Dockerfile",
      context: "./backend/sandbox",
      platform: "linux/amd64",
    },
    instanceType: "standard-4",
    maxInstances: 10,
    // todo: ask sam to support rollout_active_grace_period
    adopt: true,
  });

  const ITERATE_AGENT = DurableObjectNamespace<import("./backend/worker.ts").IterateAgent>(
    "iterate-agent",
    {
      className: "IterateAgent",
      sqlite: true,
    },
  );

  const SLACK_AGENT = DurableObjectNamespace<import("./backend/worker.ts").SlackAgent>(
    "slack-agent",
    {
      className: "SlackAgent",
      sqlite: true,
    },
  );

  const ONBOARDING_AGENT = DurableObjectNamespace<import("./backend/worker.ts").OnboardingAgent>(
    "onboarding-agent",
    {
      className: "OnboardingAgent",
      sqlite: true,
    },
  );

  const ORGANIZATION_WEBSOCKET = DurableObjectNamespace<
    import("./backend/worker.ts").OrganizationWebSocket
  >("organization-websocket", {
    className: "OrganizationWebSocket",
    sqlite: true,
  });

  const ADVISORY_LOCKER = DurableObjectNamespace<import("./backend/worker.ts").AdvisoryLocker>(
    "advisory-lock",
    {
      className: "AdvisoryLocker",
      sqlite: true,
    },
  );

  const ESTATE_BUILD_TRACKER = DurableObjectNamespace<
    import("./backend/worker.ts").EstateBuildTracker
  >("estate-build-tracker", {
    className: "EstateBuildTracker",
    sqlite: true,
  });

  const LOADER = WorkerLoader();

  return {
    ITERATE_AGENT,
    SLACK_AGENT,
    ONBOARDING_AGENT,
    ORGANIZATION_WEBSOCKET,
    SANDBOX,
    ADVISORY_LOCKER,
    ESTATE_BUILDS: ESTATE_BUILD_TRACKER,
    LOADER,
  };
}

async function setupStorage() {
  if (isProduction) {
    // In production, we use the existing r2 bucket, make sure it can't deleted or emptied
    return {
      ITERATE_FILES: await R2Bucket("iterate-files", {
        name: "iterate-files",
        adopt: true,
        delete: false,
        empty: false,
      }),
    };
  } else {
    return {
      ITERATE_FILES: await R2Bucket("iterate-files", { adopt: true }),
    };
  }
}

const subdomain = `os-${app.stage}`
  .replace(/^os-prd$/, "os") // production domain is just "os"
  .replace(/^os-stg$/, "os-staging"); // staging domain is "os-staging" for historical reasons

const domains = [
  `${subdomain}.iterate.com`, // main domain
  `${subdomain}.iterateproxy.com`, // proxy, used for callback urls to ourselves, sometimes
];

async function deployWorker() {
  const worker = await TanStackStart("os", {
    bindings: {
      ...(await setupDatabase()),
      ...(await setupStorage()),
      ...(await setupDurableObjects()),
      ...(await setupEnvironmentVariables()),
    },
    name: isProduction ? "os" : isStaging ? "os-staging" : undefined,
    domains,
    compatibilityFlags: ["enable_ctx_exports"],
    wrangler: {
      main: "./backend/worker.ts",
    },
    crons: ["0 0 * * *"],
    adopt: true,
    build: {
      command: "pnpm build && pnpm posthog:sourcemaps:inject",
    },
    dev: {
      command: "pnpm iterate dev start",
    },
  });

  return worker;
}

if (process.env.GITHUB_OUTPUT) {
  const workerUrl = `https://${domains[0]}`;
  console.log(`Writing worker URL to GitHub output: ${workerUrl}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `worker_url=${workerUrl}\n`);
}

await verifyDopplerEnvironment();
export const worker = await deployWorker();
await uploadSourcemaps();

await app.finalize();

console.log("Deployment complete");
if (!app.local) process.exit(0);
