import { execSync } from "node:child_process";
import alchemy, { type Scope } from "alchemy";
import {
  Hyperdrive,
  R2Bucket,
  Container,
  DurableObjectNamespace,
  ReactRouter,
} from "alchemy/cloudflare";
import { Database, Branch, Role } from "alchemy/planetscale";
import * as R from "remeda";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { Exec } from "alchemy/os";
import z from "zod";

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

const app = await alchemy("iterate", {
  password: process.env.ALCHEMY_PASSWORD,
  stateStore,
});

const isProduction = app.stage === "prd";
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

async function setupEnvironmentVariables() {
  const env = [
    "VITE_PUBLIC_URL",
    "OPENAI_API_KEY",
    "BRAINTRUST_API_KEY",
    "POSTHOG_PUBLIC_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_SLUG",
    "GITHUB_ESTATES_TOKEN",
    "EXPIRING_URLS_SIGNING_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "PROJECT_NAME",
    "EXA_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "REPLICATE_API_TOKEN",
    "ITERATE_USER",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICING_PLAN_ID",
    "SERVICE_AUTH_TOKEN",
  ] as const;

  R.forEach(env, (env) => {
    if (!process.env[env]) {
      throw new Error(
        `${env} is not set in process.env, if its an optional env, use the optionalEnv Array`,
      );
    }
  });

  const envBindings = R.fromEntries(
    R.map(env, (env) => [env, alchemy.secret(process.env[env])] as const),
  );

  const optionalEnv = [
    "ADMIN_EMAIL_HOSTS",
    "TEST_USER_PATTERNS",
    "POSTHOG_ENVIRONMENT",
    "ONBOARDING_E2E_TEST_SETUP_PARAMS",
    "ITERATE_NOTIFICATION_ESTATE_ID",
  ] as const;

  const optionalEnvBindings = R.fromEntries(
    R.filter(optionalEnv, (env) => Boolean(process.env[env])).map(
      (env) => [env, alchemy.secret(process.env[env])] as const,
    ),
  );

  return {
    ...envBindings,
    ...optionalEnvBindings,
  };
}

async function setupDatabase() {
  const migrate = async (origin: string) => {
    const res = await Exec("db-migrate", {
      env: {
        PSCALE_DATABASE_URL: origin,
      },
      command: "pnpm db:migrate",
    });
    if (res.exitCode !== 0) {
      throw new Error(`Failed to run migrations: ${res.stderr}`);
    }
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
    });

    await migrate(role.connectionUrl.unencrypted);

    return {
      ITERATE_POSTGRES: hyperdrive,
    };
  }

  if (isProduction) {
    // In production, we use the existing production planetscale db without any branching
    const planetscaleDb = await Database("planetscale-db", {
      name: "production",
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
    });

    await migrate(role.connectionUrl.unencrypted);

    return {
      ITERATE_POSTGRES: hyperdrive,
    };
  }

  throw new Error(`Unsupported environment: ${app.stage}`);
}

async function setupDurableObjects() {
  const SANDBOX = await Container<import("./backend/worker.ts").Sandbox>("sandbox", {
    className: "Sandbox",
    build: {
      dockerfile: "Dockerfile",
      context: "./backend/sandbox",
      platform: "linux/amd64",
    },
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

  return { ITERATE_AGENT, SLACK_AGENT, ONBOARDING_AGENT, ORGANIZATION_WEBSOCKET, SANDBOX };
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

async function deployWorker() {
  const worker = await ReactRouter("os", {
    bindings: {
      ...(await setupDatabase()),
      ...(await setupStorage()),
      ...(await setupDurableObjects()),
      ...(await setupEnvironmentVariables()),
    },
    name: isProduction ? "os" : undefined,
    domains: isProduction ? ["os.iterate.com", "os.iterateproxy.com"] : [],
    compatibilityFlags: ["enable_ctx_exports"],
    main: "./backend/worker.ts",
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

verifyDopplerEnvironment();
export const worker = await deployWorker();
await uploadSourcemaps();
await app.finalize();
