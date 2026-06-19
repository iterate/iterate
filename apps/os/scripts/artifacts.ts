import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME } from "../src/domains/repos/project-repo.ts";
import {
  REPO_DEFAULT_BRANCH,
  REPO_WRITE_TOKEN_TTL_SECONDS,
  stripArtifactTokenQuery,
} from "../src/domains/repos/artifacts.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_HOLDER_DIR = path.join(APP_ROOT, "iterate-config-repo");
const SKIP_DIRS = new Set([".git", "dist", "node_modules"]);

type SeedConfigBaseOptions = {
  /** Cloudflare account ID. Defaults to CLOUDFLARE_ACCOUNT_ID. */
  accountId?: string;
  /** Cloudflare API token. Defaults to CLOUDFLARE_API_TOKEN_DEV_JONAS or CLOUDFLARE_API_TOKEN. */
  apiToken?: string;
  /** Source directory. Defaults to apps/os/iterate-config-repo. */
  holder?: string;
  /** Cloudflare Artifacts namespace. Defaults to the active Doppler/Alchemy stage. */
  namespace?: string;
  /** Base Artifact repo name. Defaults to iterate-config-base. */
  repo?: string;
  /** Create and delete a temporary fork to prove project setup can fork the base repo. */
  verifyFork?: boolean;
};

type SetupEventSubscriptionsOptions = {
  /** Cloudflare account ID. Defaults to CLOUDFLARE_ACCOUNT_ID. */
  accountId?: string;
  /** Cloudflare API token. Defaults to CLOUDFLARE_API_TOKEN_DEV_JONAS or CLOUDFLARE_API_TOKEN. */
  apiToken?: string;
  /** OS worker name, e.g. os-prd. Defaults to the active Doppler/Alchemy stage. */
  workerName?: string;
};

type SeedResolvedOptions = {
  accountId: string;
  apiToken: string;
  holderDir: string;
  namespace: string;
  repoName: string;
  verifyFork: boolean;
};

type ArtifactRepoAccess = {
  remote: string;
  token?: string;
};

type SetupResolvedOptions = {
  accountId: string;
  apiToken: string;
  workerName: string;
};

type Subscription = {
  destination?: { queue_id?: string; type?: string };
  enabled?: boolean;
  events?: string[];
  id: string;
  name?: string;
  source?: { namespace?: string; repo_name?: string; type?: string };
};

/** Seed the Iterate config base Artifact repo and verify that new project artifact forks work. */
export async function seedConfigBase(options: SeedConfigBaseOptions = {}) {
  const resolvedOptions = resolveSeedConfigBaseOptions(options);
  const holderDir = path.resolve(resolvedOptions.holderDir);
  if (!fs.existsSync(holderDir) || !fs.statSync(holderDir).isDirectory()) {
    throw new Error(`Iterate config repo holder is not a directory: ${holderDir}`);
  }

  console.info(`Using Cloudflare Artifacts namespace ${resolvedOptions.namespace}`);
  const artifact = await getOrCreateArtifactRepo(resolvedOptions);
  const token = artifact.token || (await createArtifactToken(resolvedOptions));
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

  await verifyArtifactGitAccess({
    remote: artifact.remote,
    repoName: resolvedOptions.repoName,
    token,
  });

  if (resolvedOptions.verifyFork) {
    await verifyArtifactFork(resolvedOptions);
  }

  console.info(`Seeded ${resolvedOptions.namespace}/${resolvedOptions.repoName} from ${holderDir}`);
  return {
    namespace: resolvedOptions.namespace,
    repo: resolvedOptions.repoName,
    verifiedFork: resolvedOptions.verifyFork,
  };
}

/** Create or repair the Cloudflare event subscriptions feeding the artifact-events queue. */
export async function setupEventSubscriptions(options: SetupEventSubscriptionsOptions = {}) {
  const resolvedOptions = resolveSetupEventSubscriptionsOptions(options);
  const queueName = `${resolvedOptions.workerName}-artifact-events`;
  const queueId = await findQueueId(resolvedOptions, queueName);
  if (!queueId) {
    throw new Error(
      `Queue ${queueName} not found. Deploy the OS worker for this stage first (alchemy creates the queue).`,
    );
  }

  const desired: Array<{ events: string[]; name: string; source: Record<string, string> }> = [
    {
      name: `${resolvedOptions.workerName}-artifact-account-events`,
      source: { type: "artifacts" },
      events: ["repo.created", "repo.deleted", "repo.forked", "repo.imported"],
    },
    {
      name: `${resolvedOptions.workerName}-artifact-repo-events`,
      source: {
        type: "artifacts.repo",
        namespace: `${resolvedOptions.workerName}-repos`,
        repo_name: "*",
      },
      events: ["pushed", "cloned", "fetched"],
    },
  ];

  const existing = await listSubscriptions(resolvedOptions);
  const results: Array<{ name: string; action: "created" | "recreated" | "unchanged" }> = [];

  for (const subscription of desired) {
    const current = existing.find((candidate) => candidate.name === subscription.name);
    if (current && subscriptionMatches(current, subscription, queueId)) {
      results.push({ name: subscription.name, action: "unchanged" });
      continue;
    }

    if (current) {
      await subscriptionsApi(resolvedOptions, "DELETE", `/${current.id}`);
    }
    await subscriptionsApi(resolvedOptions, "POST", "", {
      name: subscription.name,
      enabled: true,
      source: subscription.source,
      destination: { type: "queues.queue", queue_id: queueId },
      events: subscription.events,
    });
    results.push({ name: subscription.name, action: current ? "recreated" : "created" });
  }

  for (const result of results) {
    console.info(`${result.name}: ${result.action}`);
  }
  return { queue: queueName, subscriptions: results };
}

function resolveSeedConfigBaseOptions(input: SeedConfigBaseOptions): SeedResolvedOptions {
  return {
    accountId: input.accountId?.trim() || requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    apiToken:
      input.apiToken?.trim() ||
      process.env.CLOUDFLARE_API_TOKEN_DEV_JONAS?.trim() ||
      requireEnv("CLOUDFLARE_API_TOKEN"),
    holderDir: input.holder?.trim() || DEFAULT_HOLDER_DIR,
    namespace:
      input.namespace?.trim() ||
      process.env.OS_ARTIFACTS_NAMESPACE?.trim() ||
      inferArtifactsNamespaceFromAlchemyStage() ||
      inferArtifactsNamespaceFromBaseUrl() ||
      requireEnv("OS_ARTIFACTS_NAMESPACE"),
    repoName: input.repo?.trim() || ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
    verifyFork: input.verifyFork ?? true,
  };
}

function resolveSetupEventSubscriptionsOptions(
  input: SetupEventSubscriptionsOptions,
): SetupResolvedOptions {
  return {
    accountId: input.accountId?.trim() || requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    apiToken:
      input.apiToken?.trim() ||
      process.env.CLOUDFLARE_API_TOKEN_DEV_JONAS?.trim() ||
      requireEnv("CLOUDFLARE_API_TOKEN"),
    workerName: input.workerName?.trim() || inferWorkerName() || requireEnv("OS_WORKER_NAME"),
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

  if (hostname === "os.iterate.com") return "os-prd-repos";
  return null;
}

function inferWorkerName() {
  // Mirrors initAlchemy's `workerName = slugify(`${slug}-${stage}`)`, e.g.
  // prd -> os-prd, preview_3 -> os-preview-3, dev_jonas -> os-dev-jonas.
  const stage = process.env.ALCHEMY_STAGE?.trim();
  if (stage) return slugify(`os-${stage}`);

  const baseUrl = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!baseUrl) return null;
  const hostname = new URL(baseUrl).hostname;
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(hostname);
  if (previewMatch) return `os-preview-${previewMatch[1]}`;
  if (hostname === "os.iterate.com") return "os-prd";
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

async function getOrCreateArtifactRepo(options: SeedResolvedOptions): Promise<ArtifactRepoAccess> {
  const created = await artifactsApi(options, "POST", "/repos", {
    name: options.repoName,
  });
  if (created.success) {
    return readArtifactRepoAccess(created.result || created);
  }

  const existing = await artifactsApi(
    options,
    "GET",
    `/repos/${encodeURIComponent(options.repoName)}`,
  );
  if (!existing.success) {
    throw new Error(`Failed to get or create Artifact repo: ${JSON.stringify(existing)}`);
  }

  return readArtifactRepoAccess(existing.result || existing);
}

async function createArtifactToken(options: SeedResolvedOptions): Promise<string> {
  const token = await artifactsApi(options, "POST", "/tokens", {
    repo: options.repoName,
    scope: "write",
    ttl: REPO_WRITE_TOKEN_TTL_SECONDS,
  });
  if (!token.success) {
    throw new Error(`Failed to create Artifact token: ${JSON.stringify(token)}`);
  }

  return readToken(token.result || token);
}

async function verifyArtifactFork(options: SeedResolvedOptions) {
  const forkName = `${options.repoName}-verify-${Date.now()}-${process.pid}`;
  let forkCreated = false;
  try {
    const forked = await forkArtifactRepo(options, forkName);
    forkCreated = true;
    const token = await createArtifactToken({ ...options, repoName: forkName });
    await verifyArtifactGitAccess({
      remote: forked.remote,
      repoName: forkName,
      token,
    });
    console.info(`Verified fork ${options.namespace}/${forkName}`);
  } finally {
    if (forkCreated) {
      await deleteArtifactRepo(options, forkName);
    }
  }
}

async function forkArtifactRepo(
  options: SeedResolvedOptions,
  forkName: string,
): Promise<ArtifactRepoAccess> {
  const forked = await artifactsApi(
    options,
    "POST",
    `/repos/${encodeURIComponent(options.repoName)}/fork`,
    {
      default_branch_only: true,
      description: `Temporary fork verification for ${options.repoName}`,
      name: forkName,
      read_only: false,
    },
  );
  if (!forked.success) {
    throw new Error(`Failed to fork Artifact repo: ${JSON.stringify(forked)}`);
  }

  return readArtifactRepoAccess(forked.result || forked);
}

async function deleteArtifactRepo(options: SeedResolvedOptions, repoName: string) {
  const deleted = await artifactsApi(options, "DELETE", `/repos/${encodeURIComponent(repoName)}`);
  if (!deleted.success) {
    throw new Error(`Failed to delete verification Artifact repo: ${JSON.stringify(deleted)}`);
  }
}

async function verifyArtifactGitAccess(input: { remote: string; repoName: string; token: string }) {
  try {
    const refs = execFileSync("git", ["ls-remote", input.remote, "HEAD"], {
      encoding: "utf8",
      env: gitAuthEnv(input.token),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!refs) {
      throw new Error("git ls-remote returned no refs");
    }
    console.info(`Verified Git access for ${input.repoName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not verify Git access for ${input.repoName}: ${message}`);
  }
}

async function artifactsApi(
  options: SeedResolvedOptions,
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
    token: readString(repo, "token") || readString(repo, "plaintext"),
  };
}

function readToken(value: unknown): string {
  const token = readString(asRecord(value), "plaintext") || readString(asRecord(value), "token");
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

function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
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

function subscriptionMatches(
  current: Subscription,
  desired: { events: string[]; source: Record<string, string> },
  queueId: string,
) {
  if (current.enabled !== true) return false;
  if (current.destination?.queue_id !== queueId) return false;
  if ([...(current.events || [])].sort().join(",") !== [...desired.events].sort().join(",")) {
    return false;
  }
  return Object.entries(desired.source).every(
    ([key, value]) => current.source?.[key as keyof Subscription["source"]] === value,
  );
}

async function findQueueId(options: SetupResolvedOptions, queueName: string) {
  for (let page = 1; page <= 10; page += 1) {
    const response = await cloudflareApi<Array<{ queue_id: string; queue_name: string }>>(
      options,
      "GET",
      `/queues?page=${page}&per_page=100`,
    );
    const queues = response.result || [];
    const match = queues.find((queue) => queue.queue_name === queueName);
    if (match) return match.queue_id;
    if (queues.length < 100) return null;
  }
  return null;
}

async function listSubscriptions(options: SetupResolvedOptions) {
  const subscriptions: Subscription[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await subscriptionsApi<Subscription[]>(
      options,
      "GET",
      `?page=${page}&per_page=100`,
    );
    const batch = response.result || [];
    subscriptions.push(...batch);
    if (batch.length < 100) break;
  }
  return subscriptions;
}

async function subscriptionsApi<T = unknown>(
  options: SetupResolvedOptions,
  method: "DELETE" | "GET" | "POST",
  apiPath: string,
  body?: unknown,
) {
  return cloudflareApi<T>(options, method, `/event_subscriptions/subscriptions${apiPath}`, body);
}

async function cloudflareApi<T = unknown>(
  options: SetupResolvedOptions,
  method: "DELETE" | "GET" | "POST",
  apiPath: string,
  body?: unknown,
) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const parsed = (await response.json()) as {
    errors?: Array<{ code: number; message: string }>;
    result?: T;
    success?: boolean;
  };
  if (!response.ok || parsed.success === false) {
    throw new Error(
      `${method} ${apiPath} failed (${response.status}): ${JSON.stringify(parsed.errors || parsed)}`,
    );
  }
  return parsed;
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
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}
