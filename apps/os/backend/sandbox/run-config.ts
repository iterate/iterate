import { getSandbox } from "@cloudflare/sandbox";
import type { CloudflareEnv } from "../../env.ts";
import { signUrl } from "../utils/url-signing.ts";
import { logger } from "../tag-logger.ts";

export interface RunConfigOptions {
  githubRepoUrl: string;
  githubToken: string;
  commitHash?: string;
  branch?: string;
  connectedRepoPath?: string;
  buildId: string;
  estateId: string;
}

export interface RunConfigResult {
  success: boolean;
  message: string;
  output: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
}

export interface RunConfigError {
  error: string;
  details?: string;
  commitHash?: string;
}

/**
 * Runs a configuration build in a sandboxed environment
 */

export async function runConfigInSandbox(
  env: CloudflareEnv,
  options: RunConfigOptions,
): Promise<RunConfigResult | RunConfigError> {
  try {
    return await runConfigInSandboxInternal(env, options);
  } catch (error) {
    logger.error("Error running config in sandbox:", error);
    return {
      error: "Internal server error during build",
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function runConfigInSandboxInternal(
  env: CloudflareEnv,
  options: RunConfigOptions,
): Promise<RunConfigResult | RunConfigError> {
  const { githubRepoUrl, githubToken, commitHash, branch, connectedRepoPath, estateId } = options;
  if (!estateId) {
    return {
      error: "Missing required estateId",
      details: "RunConfigOptions.estateId is required",
      commitHash,
    };
  }

  // Retrieve the sandbox
  const sandboxId = `agent-sandbox-${estateId}`;
  const sandbox = getSandbox(env.SANDBOX, sandboxId);

  // Ensure that the session directory exists
  const sessionId = estateId;
  // IMPORTANT: Randomize the session dir so build always works with the clean repo
  const sessionDir = `/tmp/session-${estateId}-${Math.random().toString().slice(2)}`;
  await sandbox.mkdir(sessionDir, { recursive: true });

  // Create an isolated session
  let sandboxSession: ReturnType<typeof sandbox.createSession>;
  try {
    sandboxSession = await sandbox.createSession({
      id: sessionId,
      cwd: sessionDir,
      isolation: true,
      env: {
        PATH: "/opt/node24/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    });
  } catch {
    // If the session creation fails, get existing session
    sandboxSession = await sandbox.getSession(sessionId!);
  }

  // Determine the checkout target and whether it's a commit hash
  const checkoutTarget = commitHash || branch || "main";
  const isCommitHash = Boolean(commitHash);

  // Compute signed ingest URL for the DO (container will POST logs periodically)
  // Use an externally-reachable base for the sandboxed container
  let baseUrl = env.VITE_PUBLIC_URL.replace("iterate.com", "iterateproxy.com");
  const isLocalhost = baseUrl.includes("localhost");
  if (isLocalhost) {
    // Use the dev domain for local, e.g. nick.dev.iterate.com
    baseUrl = `https://${env.ITERATE_USER}.dev.iterate.com`;
  }
  const buildId = options.buildId;
  // Create an HTTPS URL first for signing; signer binds only path+query
  const unsignedIngest = `${baseUrl}/api/builds/${estateId}/${buildId}/ingest`;
  const ingestUrl = await signUrl(unsignedIngest, env.EXPIRING_URLS_SIGNING_KEY, 60 * 60);
  const nodePath = "/opt/node24/bin/node";
  const startArgs = {
    sessionDir,
    githubRepoUrl,
    githubToken,
    checkoutTarget,
    isCommitHash,
    connectedRepoPath,
    ingestUrl,
    buildId,
    estateId,
  };
  const startJsonArgs = JSON.stringify(startArgs).replace(/'/g, "'\\''");
  const commandStart = `${nodePath} /tmp/sandbox-build-runner.js start '${startJsonArgs}'`;

  // Start long-running process; do not await completion
  try {
    await sandboxSession.startProcess(commandStart);
  } catch (error) {
    logger.error("Failed to start build process:", error);
    return {
      error: "Failed to start build process",
      details: error instanceof Error ? error.message : "Unknown error",
      commitHash,
    };
  }

  return {
    success: true,
    message: "Build started",
    output: {
      stdout: "Started background container process",
      stderr: "",
      exitCode: 0,
    },
  };
}
