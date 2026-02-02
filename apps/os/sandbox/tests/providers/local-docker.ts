import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execInContainer } from "../helpers/test-helpers.ts";
import { getLocalDockerEnvVars, getLocalDockerGitInfo } from "../helpers/local-docker-utils.ts";
import type {
  CreateSandboxOptions,
  SandboxHandle,
  SandboxProvider,
  WaitHealthyResponse,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../../..");

function ensurePnpmStore(): void {
  try {
    execSync("docker volume create iterate-pnpm-store", { stdio: "ignore" });
  } catch {
    // Best effort: volume may already exist or Docker not available yet.
  }
}

function getComposeEnv(): Record<string, string> {
  const gitInfo = getLocalDockerGitInfo(REPO_ROOT);
  if (!gitInfo) throw new Error("Failed to get git info for local Docker tests");

  return {
    ...process.env,
    ...getLocalDockerEnvVars(REPO_ROOT),
    LOCAL_DOCKER_REPO_CHECKOUT: gitInfo.repoRoot,
    LOCAL_DOCKER_GIT_DIR: gitInfo.gitDir,
    LOCAL_DOCKER_COMMON_DIR: gitInfo.commonDir,
    LOCAL_DOCKER_IMAGE_NAME: process.env.LOCAL_DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox:local",
  };
}

function createProjectName(): string {
  return `sandbox-test-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function getDefaultComposeProjectName(): string {
  const repoName = REPO_ROOT.split("/").pop() ?? "sandbox";
  return repoName.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function resolveBaseImage(): string {
  if (process.env.LOCAL_DOCKER_IMAGE_NAME) {
    return process.env.LOCAL_DOCKER_IMAGE_NAME;
  }

  const localDefault = "ghcr.io/iterate/sandbox:local";
  try {
    execSync(`docker image inspect ${localDefault}`, { stdio: "ignore" });
    return localDefault;
  } catch {
    // fall back to compose-tagged image
  }

  const bakedDefault = "ghcr.io/iterate/sandbox:main";
  try {
    execSync(`docker image inspect ${bakedDefault}`, { stdio: "ignore" });
    return bakedDefault;
  } catch {
    // fall back to compose-tagged image
  }

  const baseProjectName = getDefaultComposeProjectName();
  return `${baseProjectName}-sandbox`;
}

function tagSandboxImage(projectName: string): void {
  const baseImage = resolveBaseImage();
  const targetImage = `${projectName}-sandbox`;
  try {
    execSync(`docker image inspect ${baseImage}`, { stdio: "ignore" });
    execSync(`docker tag ${baseImage} ${targetImage}`, { stdio: "inherit" });
  } catch (_err) {
    throw new Error(
      `Sandbox image not found: ${baseImage}. Run 'pnpm os snapshot:local-docker' or pull from GHCR.`,
    );
  }
}

function rewriteLocalhost(url: string): string {
  return url.replace(/localhost/g, "host.docker.internal");
}

class LocalDockerSandboxHandle implements SandboxHandle {
  public readonly id: string;

  public constructor(
    private projectName: string,
    containerId: string,
    private composeEnv: Record<string, string>,
  ) {
    this.id = containerId;
  }

  public async exec(cmd: string[]): Promise<string> {
    return execInContainer(this.id, cmd);
  }

  public getHostPort(containerPort: number): number {
    const output = execSync(
      `docker compose --project-name ${this.projectName} port sandbox ${containerPort}`,
      {
        cwd: REPO_ROOT,
        env: this.composeEnv,
        encoding: "utf-8",
      },
    ).trim();
    const match = output.match(/:(\d+)$/);
    if (!match) throw new Error(`Failed to parse port from: ${output}`);
    return Number.parseInt(match[1], 10);
  }

  public async waitForServiceHealthy(
    service: string,
    timeoutMs = 180_000,
  ): Promise<WaitHealthyResponse> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const remainingMs = timeoutMs - (Date.now() - start);
        const payload = JSON.stringify({
          json: {
            target: service,
          },
        });
        const result = await this.exec([
          "curl",
          "-sf",
          "http://localhost:9876/rpc/processes/get",
          "-H",
          "Content-Type: application/json",
          "-d",
          payload,
        ]);
        const parsed = JSON.parse(result) as { json?: { state?: string } };
        const response = (parsed.json ?? parsed) as { state?: string };
        const state = response.state;
        const elapsedMs = timeoutMs - remainingMs;
        if (state === "running") {
          return { healthy: true, state, elapsedMs };
        }
        if (state === "stopped" || state === "max-restarts-reached") {
          throw new Error(`Service ${service} in terminal state: ${state}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("terminal state")) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return {
      healthy: false,
      state: "timeout",
      elapsedMs: timeoutMs,
      error: "timeout",
    };
  }

  public async stop(): Promise<void> {
    execSync(`docker compose --project-name ${this.projectName} stop sandbox`, {
      cwd: REPO_ROOT,
      env: this.composeEnv,
      stdio: "inherit",
    });
  }

  public async restart(): Promise<void> {
    execSync(`docker compose --project-name ${this.projectName} restart sandbox`, {
      cwd: REPO_ROOT,
      env: this.composeEnv,
      stdio: "inherit",
    });
  }

  public async delete(): Promise<void> {
    try {
      execSync(`docker compose --project-name ${this.projectName} down -v --remove-orphans`, {
        cwd: REPO_ROOT,
        env: this.composeEnv,
        stdio: "inherit",
      });
    } catch {
      // Best effort cleanup
    }
  }
}

export function createLocalDockerProvider(): SandboxProvider {
  return {
    name: "local-docker",

    async createSandbox(opts?: CreateSandboxOptions): Promise<SandboxHandle> {
      ensurePnpmStore();
      const projectName = createProjectName();
      tagSandboxImage(projectName);

      const env: Record<string, string> = { ...(opts?.env ?? {}) };
      if (env.ITERATE_OS_BASE_URL) {
        env.ITERATE_OS_BASE_URL = rewriteLocalhost(env.ITERATE_OS_BASE_URL);
      }
      if (env.ITERATE_EGRESS_PROXY_URL) {
        env.ITERATE_EGRESS_PROXY_URL = rewriteLocalhost(env.ITERATE_EGRESS_PROXY_URL);
      }

      const sandboxEnv = Object.fromEntries(
        Object.entries(env).map(([key, value]) => [`SANDBOX_${key}`, value]),
      );

      const composeEnv = getComposeEnv();
      execSync(`docker compose --project-name ${projectName} up -d --no-build sandbox`, {
        cwd: REPO_ROOT,
        env: {
          ...composeEnv,
          ...sandboxEnv,
        },
        stdio: "inherit",
      });

      const containerId = execSync(`docker compose --project-name ${projectName} ps -q sandbox`, {
        cwd: REPO_ROOT,
        env: composeEnv,
        encoding: "utf-8",
      }).trim();

      if (!containerId) {
        throw new Error("Failed to resolve sandbox container ID");
      }

      return new LocalDockerSandboxHandle(projectName, containerId, composeEnv);
    },
  };
}
