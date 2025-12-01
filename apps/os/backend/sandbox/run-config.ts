import { getSandbox } from "@cloudflare/sandbox";
import type { CloudflareEnv } from "../../env.ts";
import { signUrl } from "../utils/url-signing.ts";
import { logger } from "../tag-logger.ts";

export interface RunConfigOptions {
  githubRepoUrl: string;
  githubToken: string;
  commitHash?: string;
  branch?: string;
  connectedRepoPath: string | undefined;
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
