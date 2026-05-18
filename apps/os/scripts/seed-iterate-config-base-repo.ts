#!/usr/bin/env npx tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME } from "../src/domains/repos/iterate-config-repo.ts";
import {
  REPO_DEFAULT_BRANCH,
  REPO_WRITE_TOKEN_TTL_SECONDS,
  stripArtifactTokenQuery,
} from "../src/domains/repos/artifacts.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_HOLDER_DIR = path.join(APP_ROOT, "iterate-config-repo");
const SKIP_DIRS = new Set([".git", "dist", "node_modules"]);

type Options = {
  accountId: string;
  apiToken: string;
  holderDir: string;
  namespace: string;
  repoName: string;
};

type ArtifactRepoAccess = {
  remote: string;
  token?: string;
};

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const holderDir = path.resolve(options.holderDir);
  if (!fs.existsSync(holderDir) || !fs.statSync(holderDir).isDirectory()) {
    throw new Error(`Iterate config repo holder is not a directory: ${holderDir}`);
  }

  const artifact = await getOrCreateArtifactRepo(options);
  const token = artifact.token ?? (await createArtifactToken(options));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iterate-config-base-"));
  try {
    copyDirSync(holderDir, tmpDir);
    syncGitRepo({
      branch: REPO_DEFAULT_BRANCH,
      remote: artifact.remote,
      repoDir: tmpDir,
      token,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.info(`Seeded ${options.namespace}/${options.repoName} from ${holderDir}`);
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg ?? ""}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    values.set(arg.slice(2), value);
    index += 1;
  }

  return {
    accountId: values.get("account-id") ?? requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    apiToken:
      values.get("api-token") ??
      process.env.CLOUDFLARE_API_TOKEN_DEV_JONAS ??
      requireEnv("CLOUDFLARE_API_TOKEN"),
    holderDir: values.get("holder") ?? DEFAULT_HOLDER_DIR,
    namespace:
      values.get("namespace") ??
      process.env.OS_ARTIFACTS_NAMESPACE ??
      inferArtifactsNamespaceFromAlchemyStage() ??
      inferArtifactsNamespaceFromBaseUrl() ??
      requireEnv("OS_ARTIFACTS_NAMESPACE"),
    repoName: values.get("repo") ?? ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
  };
}

function inferArtifactsNamespaceFromAlchemyStage() {
  const stage = process.env.ALCHEMY_STAGE?.trim();
  if (!stage) return null;
  if (stage === "prd") return "os-prd-repos";
  if (stage === "preview") return "os-preview-1-repos";
  return `${slugify(`os-${stage}`)}-repos`;
}

function inferArtifactsNamespaceFromBaseUrl() {
  const baseUrl = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!baseUrl) return null;

  const hostname = new URL(baseUrl).hostname;
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(hostname);
  if (previewMatch) return `os-preview-${previewMatch[1]}-repos`;

  const devMatch = /^os\.iterate-dev-([^.]+)\.com$/.exec(hostname);
  if (devMatch) return `os-dev-${devMatch[1]}-repos`;

  if (hostname === "os.iterate.com" || hostname === "os.iterate.com") {
    return "os-prd-repos";
  }
  return null;
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function getOrCreateArtifactRepo(options: Options): Promise<ArtifactRepoAccess> {
  const created = await artifactsApi(options, "POST", "/repos", {
    name: options.repoName,
  });
  if (created.success) {
    return readArtifactRepoAccess(created.result ?? created);
  }

  const existing = await artifactsApi(
    options,
    "GET",
    `/repos/${encodeURIComponent(options.repoName)}`,
  );
  if (!existing.success) {
    throw new Error(`Failed to get or create Artifact repo: ${JSON.stringify(existing)}`);
  }

  return readArtifactRepoAccess(existing.result ?? existing);
}

async function createArtifactToken(options: Options): Promise<string> {
  const token = await artifactsApi(options, "POST", "/tokens", {
    repo: options.repoName,
    scope: "write",
    ttl: REPO_WRITE_TOKEN_TTL_SECONDS,
  });
  if (!token.success) {
    throw new Error(`Failed to create Artifact token: ${JSON.stringify(token)}`);
  }

  return readToken(token.result ?? token);
}

async function artifactsApi(
  options: Options,
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/artifacts/namespaces/${options.namespace}`;
  const response = await fetch(`${baseUrl}${apiPath}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      authorization: `Bearer ${options.apiToken}`,
      "content-type": "application/json",
    },
    method,
  });
  const json = (await response.json()) as unknown;
  const envelope = asRecord(json);

  return {
    errors: envelope.errors,
    result: envelope.result,
    success: envelope.success === true && response.ok,
  };
}

function readArtifactRepoAccess(value: unknown): ArtifactRepoAccess {
  const repo = asRecord(value);
  const remote = readString(repo, "remote");
  if (!remote) {
    throw new Error(
      `Cloudflare Artifacts repo response did not include remote: ${JSON.stringify(value)}`,
    );
  }

  return {
    remote,
    token: readString(repo, "token") ?? readString(repo, "plaintext"),
  };
}

function readToken(value: unknown): string {
  const token = readString(asRecord(value), "plaintext") ?? readString(asRecord(value), "token");
  if (!token) {
    throw new Error(
      `Cloudflare Artifacts token response did not include plaintext: ${JSON.stringify(value)}`,
    );
  }

  return token;
}

function syncGitRepo(input: { branch: string; remote: string; repoDir: string; token: string }) {
  const authRemote = remoteWithToken({ remote: input.remote, token: input.token });

  runGit(input.repoDir, ["init"]);
  runGit(input.repoDir, ["checkout", "-b", input.branch]);
  runGit(input.repoDir, ["remote", "add", "origin", authRemote]);
  runGit(input.repoDir, ["add", "-A"]);

  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: input.repoDir,
    encoding: "utf8",
  }).trim();
  if (!status) {
    return;
  }

  runGit(input.repoDir, [
    "-c",
    "user.name=Iterate",
    "-c",
    "user.email=support@iterate.com",
    "commit",
    "-m",
    "Seed iterate config",
  ]);
  runGit(input.repoDir, ["push", "origin", input.branch, "--force"]);
}

function runGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

function remoteWithToken(input: { remote: string; token: string }) {
  const url = new URL(input.remote);
  url.username = "x";
  url.password = stripArtifactTokenQuery(input.token);
  return url.toString();
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

await main();
