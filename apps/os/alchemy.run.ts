import { execSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy, { type Scope } from "alchemy";
import { DurableObjectNamespace, TanStackStart, Tunnel, WorkerLoader } from "alchemy/cloudflare";
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

const app = await alchemy("os", {
  password: process.env.ALCHEMY_PASSWORD,
  stateStore,
  destroyOrphans: false,
});

// Export STAGE so child processes (Vite) can use it
process.env.STAGE = app.stage;

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

/**
 * Get the current git branch name for dev mode.
 * Used to automatically set ITERATE_GIT_REF for Daytona sandboxes.
 */
function getCurrentGitRef(): string | undefined {
  if (!isDevelopment) return undefined;
  try {
    return execSync("git branch --show-current", { encoding: "utf-8", cwd: repoRoot }).trim();
  } catch {
    return undefined;
  }
}

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
      ["build", "-t", LOCAL_DOCKER_IMAGE_NAME, "-f", "apps/os/sandbox/Dockerfile", "."],
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

/**
 * DEV_TUNNEL: "0"/"false"/empty = disabled, "1"/"true" = auto, other = custom subdomain
 * Auto mode uses stage (e.g., os-dev-jonas.dev.iterate.com)
 */
function getDevTunnelConfig() {
  const devTunnel = process.env.DEV_TUNNEL;
  if (!devTunnel || devTunnel === "0" || devTunnel === "false") return null;

  const subdomain = devTunnel === "1" || devTunnel === "true" ? `os-${app.stage}` : devTunnel;

  return { hostname: `${subdomain}.dev.iterate.com`, subdomain };
}

/**
 * Wait for vite dev server to be ready by polling localhost:5173
 */
async function waitForVite(port = 5173, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://localhost:${port}`, { method: "HEAD", redirect: "manual" });
      // Accept any response - vite is responding (including 302 redirects from force-public-url plugin)
      if (res.ok || res.status === 302 || res.status === 404) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Vite did not start within ${maxWaitMs}ms`);
}

/**
 * Create a Cloudflare Tunnel for dev mode.
 * Sets VITE_PUBLIC_URL for the vite child process.
 * Returns a function to start cloudflared (call after vite is ready).
 *
 * The tunnel persists in Cloudflare between sessions (adopt: true) so DNS records
 * stay stable. Only cloudflared needs to restart each dev session.
 */
async function setupDevTunnel() {
  const config = getDevTunnelConfig();
  if (!config) return null;

  console.log(`Setting up dev tunnel: ${config.hostname}`);

  const tunnel = await Tunnel(`dev-tunnel-${config.subdomain}`, {
    name: config.subdomain,
    adopt: true, // Don't fail if tunnel already exists from previous session
    ingress: [
      { hostname: config.hostname, service: "http://localhost:5173" },
      { service: "http_status:404" },
    ],
  });

  // Set for vite child process
  process.env.VITE_PUBLIC_URL = `https://${config.hostname}`;

  // Return function to start cloudflared (call after vite is ready)
  return async () => {
    console.log("Waiting for vite to be ready on port 5173...");
    await waitForVite();

    console.log(`Starting cloudflared tunnel: https://${config.hostname}`);

    const cloudflared = spawn(
      "cloudflared",
      [
        "tunnel",
        "--loglevel",
        "info",
        "--no-autoupdate",
        "run",
        "--token",
        tunnel.token.unencrypted,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );

    cloudflared.on("error", (err) => {
      console.error("Failed to start cloudflared:", err.message);
      console.error("Make sure cloudflared is installed: brew install cloudflared");
    });

    cloudflared.on("spawn", () => {
      console.log(`Cloudflared started (pid ${cloudflared.pid})`);
    });

    cloudflared.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`Cloudflared exited with code ${code}`);
      } else if (signal) {
        console.log(`Cloudflared killed by signal ${signal}`);
      }
    });

    // Clean up cloudflared when the process exits
    process.on("exit", () => cloudflared.kill());
    process.on("SIGINT", () => {
      cloudflared.kill();
      process.exit(0);
    });
  };
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

const NonEmpty = z.string().nonempty();
const Required = NonEmpty;
// Treat empty strings as undefined for optional fields
const Optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(NonEmpty.optional());
const BoolyString = z.enum(["true", "false"]).optional();
/** needed by the deploy script, but not at runtime */
const Env = z.object({
  // you'll need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this to work, but not at runtime

  BETTER_AUTH_SECRET: Required,
  CLOUDFLARE_TUNNEL_HOST: Optional,
  DAYTONA_API_KEY: Required,
  DAYTONA_SNAPSHOT_PREFIX: Required,
  GOOGLE_CLIENT_ID: Required,
  GOOGLE_CLIENT_SECRET: Required,
  OPENAI_API_KEY: Required,
  ANTHROPIC_API_KEY: Required,
  SLACK_CLIENT_ID: Required,
  SLACK_CLIENT_SECRET: Required,
  SLACK_SIGNING_SECRET: Required,
  GITHUB_APP_CLIENT_ID: Required,
  GITHUB_APP_CLIENT_SECRET: Required,
  GITHUB_APP_SLUG: Required,
  GITHUB_APP_ID: Required,
  GITHUB_APP_PRIVATE_KEY: Required,
  STRIPE_SECRET_KEY: Required,
  STRIPE_WEBHOOK_SECRET: Required,
  STRIPE_METERED_PRICE_ID: Required,
  POSTHOG_KEY: Required,
  // SERVICE_AUTH_TOKEN: Required,
  VITE_PUBLIC_URL: Required,
  VITE_APP_STAGE: Required,
  ENCRYPTION_SECRET: Required,
  // ITERATE_USER: Optional,
  VITE_POSTHOG_PUBLIC_KEY: Optional,
  VITE_POSTHOG_PROXY_URI: Optional,
  SIGNUP_ALLOWLIST: NonEmpty.default("*@nustom.com"),
  VITE_ENABLE_EMAIL_OTP_SIGNIN: BoolyString,
} satisfies Record<string, z.ZodType<unknown, string | undefined>>);

// Type for env vars wrapped as alchemy secrets
type EnvSecrets = {
  [K in keyof z.output<typeof Env>]-?: z.output<typeof Env>[K] extends string
    ? ReturnType<typeof alchemy.secret<string>>
    : never;
};

async function setupEnvironmentVariables(): Promise<EnvSecrets> {
  const parsed = Env.safeParse({ ...process.env, VITE_APP_STAGE: app.stage, APP_STAGE: app.stage });
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  }
  // Filter out undefined values before wrapping in alchemy.secret
  const defined = R.pickBy(parsed.data, (v) => v !== undefined) as Record<string, string>;
  return R.mapValues(defined, alchemy.secret) as unknown as EnvSecrets;
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
    const origin = "postgres://postgres:postgres@localhost:5432/os";
    await migrate(origin);
    return {
      DATABASE_URL: origin,
    };
  }

  if (isPreview) {
    const planetscaleDb = await Database("planetscale-db", {
      name: "os-dev",
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
      name: "os-staging",
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
      name: "os-production",
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

const subdomain = `os-${app.stage}`.replace(/^os-prd$/, "os").replace(/^os-stg$/, "os-staging");

const domains = [`${subdomain}.iterate.com`];

async function deployWorker() {
  const REALTIME_PUSHER = DurableObjectNamespace<import("./backend/worker.ts").RealtimePusher>(
    "realtime-pusher",
    {
      className: "RealtimePusher",
      sqlite: true,
    },
  );

  const devGitRef = getCurrentGitRef();
  console.log(`Current git branch: ${devGitRef}`);

  const worker = await TanStackStart("os", {
    bindings: {
      ...(await setupDatabase()),
      ...(await setupEnvironmentVariables()),
      WORKER_LOADER: WorkerLoader(),
      ALLOWED_DOMAINS: domains.join(","),
      REALTIME_PUSHER,
      // In dev, pass the current git branch for Daytona sandboxes
      ...(devGitRef ? { ITERATE_DEV_GIT_REF: devGitRef } : {}),
    },
    name: isProduction ? "os" : isStaging ? "os-staging" : undefined,
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

let startCloudflared: (() => Promise<void>) | null = null;
if (isDevelopment) {
  ensureLocalDockerImage();
  startCloudflared = await setupDevTunnel();
}

// Start cloudflared in background after vite is ready (don't await - runs concurrently)
if (startCloudflared) {
  startCloudflared().catch((err) => console.error("Failed to start tunnel:", err.message));
}

export const worker = await deployWorker();

await app.finalize();

if (!app.local) process.exit(0);
