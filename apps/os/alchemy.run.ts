import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy, { type Scope } from "alchemy";
import {
  DurableObjectNamespace,
  TanStackStart,
  Tunnel,
  WorkerLoader,
  Worker,
  Self,
} from "alchemy/cloudflare";
import { Database, Branch, Role } from "alchemy/planetscale";
import * as R from "remeda";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { Exec } from "alchemy/os";
import { z } from "zod/v4";
import dedent from "dedent";
import {
  ensurePnpmStoreVolume as ensureIteratePnpmStoreVolume,
  getDockerEnvVars,
} from "../../sandbox/providers/docker/utils.ts";
import type { ProjectIngressProxy } from "./proxy/worker.ts";
import {
  GLOBAL_SECRETS_CONFIG,
  type GlobalSecretEnvVarName,
} from "./scripts/seed-global-secrets.ts";

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

function parseComposePublishedPort(
  rawOutput: string,
  service: string,
  containerPort: number,
): string {
  const line = rawOutput
    .trim()
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  const match = line?.match(/:(\d+)$/);
  if (!match) {
    throw new Error(
      `Could not parse published port for ${service}:${containerPort}. Output was: ${rawOutput}`,
    );
  }
  return match[1];
}

async function getComposePublishedPort(
  service: string,
  containerPort: number,
  maxWaitMs = 30_000,
): Promise<string> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < maxWaitMs) {
    try {
      const output = execSync(`tsx ./scripts/docker-compose.ts port ${service} ${containerPort}`, {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      return parseComposePublishedPort(output, service, containerPort);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Could not resolve published port for ${service}:${containerPort}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

async function resolveLocalDockerRuntimePorts() {
  const postgresPort = await getComposePublishedPort("postgres", 5432);
  const neonProxyPort = await getComposePublishedPort("neon-proxy", 4444);
  process.env.LOCAL_DOCKER_POSTGRES_PORT = postgresPort;
  process.env.LOCAL_DOCKER_NEON_PROXY_PORT = neonProxyPort;
  return { postgresPort, neonProxyPort };
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
    .object({ environment: z.string(), name: z.string() })
    .parse(JSON.parse(execSync("doppler configs get --json", { encoding: "utf-8" })));

  if (dopplerConfig.name === "dev_personal") {
    const username = (await import("node:os")).userInfo().username;
    throw new Error(
      `dev_personal doppler config is not allowed. Use 'doppler setup' to select or create a config named 'dev_${username}' instead.`,
    );
  }

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
const Optional = NonEmpty.optional();
const BoolyString = z.enum(["true", "false"]).optional();
/** needed by the deploy script, but not at runtime */
const Env = z.object({
  // you'll need CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and ALCHEMY_STATE_TOKEN for the deployment to work, but not at runtime

  BETTER_AUTH_SECRET: Required,
  DAYTONA_API_KEY: Required,
  DAYTONA_SNAPSHOT_NAME: Optional, // iterate-sandbox-{commitSha} - required at runtime for Daytona
  DAYTONA_ORG_ID: Optional,
  VITE_DAYTONA_SNAPSHOT_NAME: Optional,
  DAYTONA_SANDBOX_AUTO_STOP_INTERVAL: NonEmpty.default("0"), // minutes, 0 = disabled
  DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL: NonEmpty.default("-1"), // minutes, -1 = disabled, 0 = delete on stop
  SANDBOX_MACHINE_PROVIDERS: Optional,
  FLY_API_TOKEN: Optional,
  FLY_API_KEY: Optional,
  FLY_ORG: Optional,
  FLY_REGION: Optional,
  FLY_IMAGE: Optional,
  FLY_APP_PREFIX: Optional,
  FLY_NETWORK: Optional,
  FLY_BASE_DOMAIN: Optional,
  FLY_APPS: Optional,
  GOOGLE_CLIENT_ID: Required,
  GOOGLE_CLIENT_SECRET: Required,
  OPENAI_API_KEY: Required,
  ANTHROPIC_API_KEY: Required,
  REPLICATE_API_TOKEN: Required,
  SLACK_CLIENT_ID: Required,
  SLACK_CLIENT_SECRET: Required,
  SLACK_SIGNING_SECRET: Required,
  GITHUB_APP_CLIENT_ID: Required,
  GITHUB_APP_CLIENT_SECRET: Required,
  GITHUB_APP_SLUG: Required,
  GITHUB_APP_ID: Required,
  GITHUB_APP_PRIVATE_KEY: Required,
  GITHUB_WEBHOOK_SECRET: Required,
  STRIPE_SECRET_KEY: Required,
  STRIPE_WEBHOOK_SECRET: Required,
  STRIPE_METERED_PRICE_ID: Required,
  RESEND_BOT_DOMAIN: Required,
  RESEND_BOT_API_KEY: Required,
  RESEND_BOT_WEBHOOK_SECRET: Optional,
  POSTHOG_PUBLIC_KEY: Optional,
  // SERVICE_AUTH_TOKEN: Required,
  VITE_PUBLIC_URL: Required,
  VITE_APP_STAGE: Required,
  APP_STAGE: Required,
  ENCRYPTION_SECRET: Required,
  // ITERATE_USER: Optional,
  VITE_POSTHOG_PUBLIC_KEY: Optional,
  VITE_POSTHOG_PROXY_URL: Optional,
  SIGNUP_ALLOWLIST: NonEmpty.default("*@nustom.com"),
  VITE_ENABLE_EMAIL_OTP_SIGNIN: BoolyString,
  // DANGEROUS: When enabled, returns raw decrypted secrets instead of magic strings.
  // This bypasses the egress proxy and exposes secrets directly in env vars.
  // Only enable this for local development or trusted environments.
  DANGEROUS_RAW_SECRETS_ENABLED: BoolyString,
} satisfies Record<string, z.ZodType<unknown, string | undefined>> & {
  [K in GlobalSecretEnvVarName]: typeof Required;
});

// Type for env vars wrapped as alchemy secrets
type EnvSecrets = {
  [K in keyof z.output<typeof Env>]-?: z.output<typeof Env>[K] extends string | undefined
    ? ReturnType<typeof alchemy.secret<string>>
    : never;
};

async function setupEnvironmentVariables(): Promise<EnvSecrets> {
  if (process.env.APP_STAGE && process.env.APP_STAGE !== app.stage)
    throw new Error(`APP_STAGE=${process.env.APP_STAGE} but app.stage=${app.stage}!`);

  if (process.env.VITE_APP_STAGE && process.env.VITE_APP_STAGE !== app.stage)
    throw new Error(`VITE_APP_STAGE=${process.env.VITE_APP_STAGE} but app.stage=${app.stage}!`);

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

  const seedGlobalSecrets = async (origin: string) => {
    // Seed global secrets (OpenAI, Anthropic keys) into the database
    // These are the lowest priority secrets, overridable at org/project/user level

    const res = await Exec("db-seed-secrets", {
      env: {
        PSCALE_DATABASE_URL: origin,
        DATABASE_URL: origin,
        ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET,
        ...Object.fromEntries(GLOBAL_SECRETS_CONFIG.map((c) => [c.envVar, process.env[c.envVar]])),
      },
      command: "tsx ./scripts/seed-global-secrets.ts --run",
    });

    if (res.exitCode !== 0) {
      console.warn(`Warning: Failed to seed global secrets: ${res.stderr}`);
      // Don't fail deployment if seeding fails - secrets can be added manually
    }
  };

  if (isDevelopment) {
    const localDockerPostgresPort = process.env.LOCAL_DOCKER_POSTGRES_PORT ?? "5432";
    const origin = `postgres://postgres:postgres@localhost:${localDockerPostgresPort}/os`;
    await migrate(origin);
    await seedGlobalSecrets(origin);
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
    await migrate(role.connectionUrlPooled.unencrypted);
    await seedGlobalSecrets(role.connectionUrlPooled.unencrypted);

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

    await migrate(role.connectionUrlPooled.unencrypted);
    await seedGlobalSecrets(role.connectionUrlPooled.unencrypted);

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

    await migrate(role.connectionUrlPooled.unencrypted);
    await seedGlobalSecrets(role.connectionUrlPooled.unencrypted);

    return {
      DATABASE_URL: role.connectionUrlPooled.unencrypted,
    };
  }

  throw new Error(`Unsupported environment: ${app.stage}`);
}

const subdomain = `os-${app.stage}`.replace(/^os-prd$/, "os").replace(/^os-stg$/, "os-staging");

const domains = [`${subdomain}.iterate.com`];

async function deployWorker(dbConfig: { DATABASE_URL: string }, envSecrets: EnvSecrets) {
  const dockerEnvVars = isDevelopment ? getDockerEnvVars(repoRoot) : {};

  // Docker provider env vars
  const dockerBindings = {
    DOCKER_IMAGE_NAME: "",
    DOCKER_COMPOSE_PROJECT_NAME: "",
    DOCKER_GIT_REPO_ROOT: "",
    DOCKER_GIT_GITDIR: "",
    DOCKER_GIT_COMMON_DIR: "",
    LOCAL_DOCKER_IMAGE_NAME: "",
    LOCAL_DOCKER_COMPOSE_PROJECT_NAME: "",
    LOCAL_DOCKER_GIT_REPO_ROOT: "",
    LOCAL_DOCKER_GIT_GITDIR: "",
    LOCAL_DOCKER_GIT_COMMON_DIR: "",
    LOCAL_DOCKER_REPO_CHECKOUT: "",
  };
  if (isDevelopment) {
    const composeProjectName =
      process.env.DOCKER_COMPOSE_PROJECT_NAME ?? dockerEnvVars.DOCKER_COMPOSE_PROJECT_NAME ?? "";
    const repoCheckout =
      process.env.DOCKER_GIT_REPO_ROOT ?? dockerEnvVars.DOCKER_GIT_REPO_ROOT ?? "";
    const gitDir = process.env.DOCKER_GIT_GITDIR ?? dockerEnvVars.DOCKER_GIT_GITDIR ?? "";
    const commonDir =
      process.env.DOCKER_GIT_COMMON_DIR ?? dockerEnvVars.DOCKER_GIT_COMMON_DIR ?? "";
    const imageName =
      process.env.DOCKER_IMAGE_NAME ??
      process.env.LOCAL_DOCKER_IMAGE_NAME ??
      "iterate-sandbox:local";

    Object.assign(dockerBindings, {
      DOCKER_IMAGE_NAME: imageName,
      DOCKER_COMPOSE_PROJECT_NAME: composeProjectName,
      DOCKER_GIT_REPO_ROOT: repoCheckout,
      DOCKER_GIT_GITDIR: gitDir,
      DOCKER_GIT_COMMON_DIR: commonDir,
      LOCAL_DOCKER_IMAGE_NAME: imageName,
      LOCAL_DOCKER_COMPOSE_PROJECT_NAME:
        process.env.LOCAL_DOCKER_COMPOSE_PROJECT_NAME ?? composeProjectName,
      LOCAL_DOCKER_GIT_REPO_ROOT: process.env.LOCAL_DOCKER_GIT_REPO_ROOT ?? repoCheckout,
      LOCAL_DOCKER_GIT_GITDIR: process.env.LOCAL_DOCKER_GIT_GITDIR ?? gitDir,
      LOCAL_DOCKER_GIT_COMMON_DIR: process.env.LOCAL_DOCKER_GIT_COMMON_DIR ?? commonDir,
      LOCAL_DOCKER_REPO_CHECKOUT: process.env.LOCAL_DOCKER_REPO_CHECKOUT ?? repoCheckout,
    });
  }

  const REALTIME_PUSHER = DurableObjectNamespace<import("./backend/worker.ts").RealtimePusher>(
    "realtime-pusher",
    {
      className: "RealtimePusher",
      sqlite: true,
    },
  );
  const APPROVAL_COORDINATOR = DurableObjectNamespace<
    import("./backend/worker.ts").ApprovalCoordinator
  >("approval-coordinator", {
    className: "ApprovalCoordinator",
    sqlite: true,
  });

  const PROXY_ROOT_DOMAIN = isDevelopment ? "local.iterate.town" : "iterate.town";

  const PROJECT_INGRESS_PROXY = DurableObjectNamespace<ProjectIngressProxy>(
    "project-ingress-proxy",
    {
      className: "ProjectIngressProxy",
      sqlite: true,
    },
  );

  const proxyWorker = await Worker("proxy", {
    name: isProduction ? "os-proxy" : isStaging ? "os-proxy-staging" : undefined,
    entrypoint: "./proxy/worker.ts",
    bindings: {
      PROJECT_INGRESS_PROXY,
      PROXY_ROOT_DOMAIN,
    },
    adopt: true,
  });

  const worker = await TanStackStart("os", {
    bindings: {
      ...dbConfig,
      ...envSecrets,
      SELF: Self,
      WORKER_LOADER: WorkerLoader(),
      ALLOWED_DOMAINS: domains.join(","),
      REALTIME_PUSHER,
      APPROVAL_COORDINATOR,
      PROXY_ROOT_DOMAIN,
      PROXY_WORKER: proxyWorker,
      // Workerd can't exec in dev, so git/compose info must be injected via env vars here.
      // Use empty defaults outside dev so worker.Env contains these bindings for typing.
      ...dockerBindings,
    },
    name: isProduction ? "os" : isStaging ? "os-staging" : undefined,
    assets: {
      _headers: dedent`
        /assets/*
          ! Cache-Control
            Cache-Control: public, immutable, max-age=31536000
      `,
    },
    routes: [
      ...domains.map((domain) => ({
        pattern: `${domain}/*`,
        adopt: true,
      })),
      {
        pattern: `${PROXY_ROOT_DOMAIN}/*`,
        adopt: true,
      },
      {
        pattern: `*.${PROXY_ROOT_DOMAIN}/*`,
        adopt: true,
      },
    ],
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

  return { worker, proxyWorker };
}

if (process.env.GITHUB_OUTPUT) {
  const workerUrl = `https://${domains[0]}`;
  console.log(`Writing worker URL to GitHub output: ${workerUrl}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `worker_url=${workerUrl}\n`);
}

await verifyDopplerEnvironment();

if (isDevelopment) {
  // Set VITE_PUBLIC_URL before vite starts
  setupDevTunnelEnv();

  // Start Docker containers (postgres, neon-proxy) before migrations
  // docker-compose.ts handles DOCKER_COMPOSE_PROJECT_NAME and DOCKER_GIT_* env vars
  // --wait flag ensures postgres healthcheck passes before returning
  console.log("Starting Docker containers...");
  execSync("pnpm docker:up", {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const ports = await resolveLocalDockerRuntimePorts();
  console.log(
    `Resolved local Docker ports: postgres=${ports.postgresPort}, neon-proxy=${ports.neonProxyPort}`,
  );

  ensureIteratePnpmStoreVolume(repoRoot);
}

// Setup database and env first
const dbConfig = await setupDatabase();
const envSecrets = await setupEnvironmentVariables();

// Deploy main worker (includes egress proxy on /api/egress-proxy)
export const { worker, proxyWorker } = await deployWorker(dbConfig, envSecrets);

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
