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
  phase: "up",
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
 * Auto mode uses stage (e.g., dev-jonas-os.dev.iterate.com)
 */
function getDevTunnelConfig() {
  const devTunnel = process.env.DEV_TUNNEL;
  if (!devTunnel || devTunnel === "0" || devTunnel === "false") return null;

  const subdomain = devTunnel === "1" || devTunnel === "true" ? `${app.stage}-os` : devTunnel;

  return { hostname: `${subdomain}.dev.iterate.com`, subdomain };
}

/**
 * Wait for vite dev server to be ready by polling localhost
 */
async function waitForVite(port: number, maxWaitMs = 60_000): Promise<void> {
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
  throw new Error(`Vite did not start on port ${port} within ${maxWaitMs}ms`);
}

/**
 * Create a Cloudflare Tunnel resource for dev mode.
 * MUST be called before app.finalize() so the resource is tracked.
 */
async function createDevTunnel(vitePort: number) {
  const config = getDevTunnelConfig();
  if (!config) return null;

  console.log(`Creating dev tunnel: ${config.hostname} -> localhost:${vitePort}`);

  const tunnel = await Tunnel(`dev-tunnel-${config.subdomain}`, {
    name: config.subdomain,
    adopt: true, // Don't fail if tunnel already exists from previous session
    ingress: [
      { hostname: config.hostname, service: `http://localhost:${vitePort}` },
      { service: "http_status:404" },
    ],
  });

  return { tunnel, config, vitePort };
}

/**
 * Start cloudflared after vite is ready. Called AFTER app.finalize().
 */
function startCloudflared(tunnel: Awaited<ReturnType<typeof createDevTunnel>>) {
  if (!tunnel) return;

  const { tunnel: tunnelResource, config } = tunnel;

  console.log(`Starting cloudflared tunnel: https://${config.hostname}`);

  const cloudflared = spawn(
    "cloudflared",
    [
      "tunnel",
      "--loglevel",
      "warn",
      "--no-autoupdate",
      "run",
      "--token",
      tunnelResource.token.unencrypted,
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
}

/**
 * Set VITE_PUBLIC_URL before vite starts (if tunnel enabled)
 */
function setupDevTunnelEnv() {
  const config = getDevTunnelConfig();
  if (!config) return;
  process.env.VITE_PUBLIC_URL = `https://${config.hostname}`;
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
const Env = z
  .object({
    // you'll need CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and ALCHEMY_STATE_TOKEN for the deployment to work, but not at runtime

    BETTER_AUTH_SECRET: Required,
    DAYTONA_API_KEY: Required,
    DAYTONA_SNAPSHOT_PREFIX: Optional,
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
  } satisfies Record<string, z.ZodType<unknown, string | undefined>>)
  .transform((env) => {
    if (env.DAYTONA_SNAPSHOT_PREFIX) {
      return env;
    }
    return {
      ...env,
      DAYTONA_SNAPSHOT_PREFIX: `${app.stage}--`,
    };
  });

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

if (isDevelopment) {
  ensureLocalDockerImage();
  // Set VITE_PUBLIC_URL before vite starts
  setupDevTunnelEnv();
}

// Deploy worker (starts vite in dev mode)
export const worker = await deployWorker();

// Create tunnel resource BEFORE finalize so it's properly tracked
// (fixes bug where tunnel was created after finalize, causing orphan deletion)
let devTunnel: Awaited<ReturnType<typeof createDevTunnel>> = null;
if (isDevelopment && getDevTunnelConfig() && worker.url) {
  const vitePort = Number(new URL(worker.url).port || "5173");
  devTunnel = await createDevTunnel(vitePort);
}

await app.finalize();

// Start cloudflared AFTER finalize (long-running process)
if (devTunnel && worker.url) {
  const vitePort = Number(new URL(worker.url).port || "5173");
  console.log(`Vite running at ${worker.url}`);
  await waitForVite(vitePort);
  startCloudflared(devTunnel);
}

if (!app.local) process.exit(0);
