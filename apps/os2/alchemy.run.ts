import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy, { type Scope } from "alchemy";
import { DurableObjectNamespace, TanStackStart, WorkerLoader } from "alchemy/cloudflare";
import { Database, Branch, Role } from "alchemy/planetscale";
import * as R from "remeda";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { Exec } from "alchemy/os";
import { z } from "zod/v4";
import dedent from "dedent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

const app = await alchemy("os2", {
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
const isPreview =
  app.stage.startsWith("pr-") ||
  app.stage === "dev" ||
  app.stage.startsWith("dev-") ||
  app.stage.startsWith("local-");

const LOCAL_DOCKER_IMAGE_NAME = "iterate-sandbox:local";

function ensureLocalDockerImage() {
  const result = spawnSync("docker", ["images", "-q", LOCAL_DOCKER_IMAGE_NAME], {
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    console.log("Docker not available, skipping local sandbox image build");
    return;
  }

  const imageExists = result.stdout.trim().length > 0;

  if (!imageExists) {
    console.log(`Building local Docker image ${LOCAL_DOCKER_IMAGE_NAME}...`);
    const buildResult = spawnSync(
      "docker",
      ["build", "-t", LOCAL_DOCKER_IMAGE_NAME, "-f", "apps/os2/sandbox/Dockerfile", "."],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );

    if (buildResult.status !== 0) {
      throw new Error(
        `Failed to build ${LOCAL_DOCKER_IMAGE_NAME}. Check Docker is running and try again.`,
      );
    } else {
      console.log(`Successfully built ${LOCAL_DOCKER_IMAGE_NAME}`);
    }
  } else {
    console.log(`Local Docker image ${LOCAL_DOCKER_IMAGE_NAME} already exists`);
  }
}

async function verifyDopplerEnvironment() {
  if (process.env.SKIP_DOPPLER_CHECK) return;
  const dopplerConfig = z
    .object({ environment: z.string() })
    .parse(JSON.parse(execSync("doppler configs get --json", { encoding: "utf-8" })));

  if (isProduction && !dopplerConfig.environment.startsWith("prd")) {
    throw new Error(
      `You are trying to deploy to production, but the doppler environment is set to ${dopplerConfig.environment}, exiting...`,
    );
  }

  if (isStaging && !dopplerConfig.environment.startsWith("stg")) {
    throw new Error(
      `You are trying to deploy to staging, but the doppler environment is set to ${dopplerConfig.environment}, exiting...`,
    );
  }

  if (isDevelopment && !dopplerConfig.environment.startsWith("dev")) {
    throw new Error(
      `You are trying to develop locally, but the doppler environment is set to ${dopplerConfig.environment}, exiting...`,
    );
  }
}

const Required = z.string().nonempty();
const Optional = z.string().optional();
const Env = z.object({
  BETTER_AUTH_SECRET: Required,
  DAYTONA_API_KEY: Required,
  GOOGLE_CLIENT_ID: Required,
  GOOGLE_CLIENT_SECRET: Required,
  OPENAI_API_KEY: Required,
  SLACK_CLIENT_ID: Required,
  SLACK_CLIENT_SECRET: Required,
  SLACK_SIGNING_SECRET: Required,
  GITHUB_APP_CLIENT_ID: Required,
  GITHUB_APP_CLIENT_SECRET: Required,
  GITHUB_APP_SLUG: Required,
  GITHUB_APP_ID: Required,
  GITHUB_APP_PRIVATE_KEY: Required,
  SERVICE_AUTH_TOKEN: Required,
  VITE_PUBLIC_URL: Required,
  VITE_APP_STAGE: Required,
  ENCRYPTION_SECRET: Required,
  ITERATE_USER: Optional,
  VITE_POSTHOG_PUBLIC_KEY: Optional,
  VITE_POSTHOG_PROXY_URI: Optional,
  POSTHOG_KEY: Optional,
  ALLOW_SIGNUP_FROM_EMAILS: z.string().default("*@example.com"),
  VITE_ENABLE_EMAIL_OTP_SIGNIN: Optional,
  STRIPE_SECRET_KEY: Required,
  STRIPE_WEBHOOK_SECRET: Required,
  STRIPE_METERED_PRICE_ID: Required,
} satisfies Record<string, typeof Required | typeof Optional | z.ZodDefault<z.ZodString>>);

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
  };

  if (isDevelopment) {
    const origin = "postgres://postgres:postgres@localhost:5432/os2";
    await migrate(origin);
    return {
      DATABASE_URL: origin,
    };
  }

  if (isPreview) {
    const planetscaleDb = await Database("planetscale-db", {
      name: "os2-dev",
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
      delete: true,
    });

    const role = await Role("db-role", {
      database: planetscaleDb,
      inheritedRoles: ["postgres"],
      branch,
      delete: true,
    });

    await migrate(role.connectionUrl.unencrypted);

    return {
      DATABASE_URL: role.connectionUrlPooled.unencrypted,
    };
  }

  if (isStaging) {
    const planetscaleDb = await Database("planetscale-db", {
      name: "os2-staging",
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

    await migrate(role.connectionUrl.unencrypted);

    return {
      DATABASE_URL: role.connectionUrlPooled.unencrypted,
    };
  }

  if (isProduction) {
    const planetscaleDb = await Database("planetscale-db", {
      name: "os2-production",
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

    await migrate(role.connectionUrl.unencrypted);

    return {
      DATABASE_URL: role.connectionUrlPooled.unencrypted,
    };
  }

  throw new Error(`Unsupported environment: ${app.stage}`);
}

const subdomain = `os2-${app.stage}`
  .replace(/^os2-prd$/, "os2")
  .replace(/^os2-stg$/, "os2-staging");

const domains = [`${subdomain}.iterate.com`];

async function deployWorker() {
  const REALTIME_PUSHER = DurableObjectNamespace<import("./backend/worker.ts").RealtimePusher>(
    "realtime-pusher",
    {
      className: "RealtimePusher",
      sqlite: true,
    },
  );

  const worker = await TanStackStart("os2", {
    bindings: {
      ...(await setupDatabase()),
      ...(await setupEnvironmentVariables()),
      WORKER_LOADER: WorkerLoader(),
      ALLOWED_DOMAINS: domains.join(","),
      DAYTONA_SNAPSHOT_PREFIX: `${app.stage}--`,
      REALTIME_PUSHER,
    },
    name: isProduction ? "os2" : isStaging ? "os2-staging" : undefined,
    assets: {
      _headers: dedent`
        /assets/*
          ! Cache-Control
            Cache-Control: public, immutable, max-age=31536000
      `,
    },
    domains,
    wrangler: {
      main: "./backend/worker.ts",
    },
    adopt: true,
    build: {
      command: "pnpm build",
    },
    dev: {
      command: "pnpm dev:vite",
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

if (isDevelopment) {
  ensureLocalDockerImage();
}

export const worker = await deployWorker();

await app.finalize();

if (!app.local) process.exit(0);
