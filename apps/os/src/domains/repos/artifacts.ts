import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
export { repoArtifactName } from "~/domains/repos/repo-artifact-name.ts";

export type CloudflareArtifactTokenScope = "read" | "write";

export type CloudflareArtifactToken = {
  expiresAt?: string | number | Date | null;
  expires_at?: string | number | Date | null;
  plaintext?: string;
  token?: string;
};

export type CloudflareArtifactRepo = {
  defaultBranch?: string;
  default_branch?: string;
  name: string;
  remote: string;
  createToken?(
    scope: CloudflareArtifactTokenScope,
    ttlSeconds: number,
  ): Promise<CloudflareArtifactToken>;
  fork?(
    name: string,
    options?: {
      defaultBranchOnly?: boolean;
      default_branch_only?: boolean;
      description?: string;
      readOnly?: boolean;
      read_only?: boolean;
    },
  ): Promise<CloudflareArtifactRepo>;
  plaintext?: string;
  token?: string;
};

export type CloudflareArtifactsBinding = {
  create(
    name: string,
    options?: {
      setDefaultBranch?: string;
      defaultBranch?: string;
      default_branch?: string;
    },
  ): Promise<CloudflareArtifactRepo>;
  get(name: string): Promise<CloudflareArtifactRepo>;
};

type CloudflareArtifactsRestBindingInput = {
  accountId: string;
  apiToken: string;
  namespace: string;
};

export const REPO_DEFAULT_BRANCH = "main";
export const REPO_README_PATH = "README.md";
export const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

export function artifactRemoteUrl(input: { accountId: string; name: string; namespace: string }) {
  return `https://${input.accountId}.artifacts.cloudflare.net/git/${input.namespace}/${input.name}.git`;
}

export function createCloudflareArtifactsRestBinding(
  input: CloudflareArtifactsRestBindingInput,
): CloudflareArtifactsBinding {
  return {
    async create(name, options) {
      const repo = await artifactsApi<CloudflareArtifactRepo>(input, "POST", "/repos", {
        default_branch:
          options?.defaultBranch ?? options?.default_branch ?? options?.setDefaultBranch,
        name,
      });
      return withRestRepoMethods(input, repo);
    },
    async get(name) {
      const repo = await artifactsApi<CloudflareArtifactRepo>(
        input,
        "GET",
        `/repos/${encodeURIComponent(name)}`,
      );
      return withRestRepoMethods(input, repo);
    },
  };
}

export function normalizeArtifactToken(token: CloudflareArtifactToken) {
  const plaintext = token.plaintext ?? token.token;
  if (!plaintext) {
    throw new Error("Cloudflare Artifacts token response did not include plaintext.");
  }

  return {
    plaintext,
    expiresAt: normalizeTokenExpiresAt(
      token.expiresAt ?? token.expires_at ?? expiresAtFromTokenQuery(plaintext),
    ),
  };
}

export async function createArtifactToken(input: {
  artifact: CloudflareArtifactRepo;
  artifacts: CloudflareArtifactsBinding;
  name: string;
  scope: CloudflareArtifactTokenScope;
  ttlSeconds: number;
}) {
  if (typeof input.artifact.createToken === "function") {
    return normalizeArtifactToken(await input.artifact.createToken(input.scope, input.ttlSeconds));
  }

  if (input.artifact.plaintext || input.artifact.token) {
    return normalizeArtifactToken(input.artifact);
  }

  const persistedArtifact = await input.artifacts.get(input.name);
  if (typeof persistedArtifact.createToken === "function") {
    return normalizeArtifactToken(
      await persistedArtifact.createToken(input.scope, input.ttlSeconds),
    );
  }

  throw new Error("Cloudflare Artifacts repo handle did not expose token creation.");
}

export async function pushInitialReadme(input: {
  defaultBranch: string;
  projectId: string;
  projectSlug?: string;
  remote: string;
  repoSlug: string;
  token: string;
}) {
  const filesystem = new InMemoryFs({
    [`/${REPO_README_PATH}`]: initialReadme(input),
  });
  const git = createGit(filesystem, "/");

  await git.init({ defaultBranch: input.defaultBranch });
  await git.add({ filepath: REPO_README_PATH });
  await git.commit({
    message: "Initial commit",
    author: {
      name: "Iterate",
      email: "support@iterate.com",
    },
  });
  await git.remote({
    add: {
      name: "origin",
      url: input.remote,
    },
  });
  await git.push({
    remote: "origin",
    ref: input.defaultBranch,
    username: "x",
    password: stripArtifactTokenQuery(input.token),
  });
}

function initialReadme(input: { projectId: string; projectSlug?: string; repoSlug: string }) {
  return `# ${input.repoSlug}

Project: ${input.projectSlug ?? input.projectId}
Project ID: ${input.projectId}
`;
}

function normalizeTokenExpiresAt(value: string | number | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return new Date(value).toISOString();
}

function expiresAtFromTokenQuery(token: string): number | null {
  const match = /[?&]expires=(\d+)/.exec(token);
  return match ? Number(match[1]) : null;
}

export function stripArtifactTokenQuery(token: string) {
  return token.split("?expires=")[0] ?? token;
}

function withRestRepoMethods(
  input: CloudflareArtifactsRestBindingInput,
  repo: CloudflareArtifactRepo,
): CloudflareArtifactRepo {
  return {
    ...repo,
    async createToken(scope, ttlSeconds) {
      return await artifactsApi<CloudflareArtifactToken>(input, "POST", "/tokens", {
        repo: repo.name,
        scope,
        ttl: ttlSeconds,
      });
    },
    async fork(name, options) {
      let forked: CloudflareArtifactRepo;
      try {
        forked = await artifactsApi<CloudflareArtifactRepo>(
          input,
          "POST",
          `/repos/${encodeURIComponent(repo.name)}/fork`,
          {
            default_branch_only: options?.defaultBranchOnly ?? options?.default_branch_only,
            description: options?.description,
            name,
            read_only: options?.readOnly ?? options?.read_only,
          },
        );
      } catch (error) {
        if (error instanceof CloudflareArtifactsRestError && error.status === 409) {
          forked = await waitForRestRepo(input, name);
        } else {
          throw error;
        }
      }
      return withRestRepoMethods(input, forked);
    },
  };
}

async function artifactsApi<T>(
  input: CloudflareArtifactsRestBindingInput,
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/artifacts/namespaces/${input.namespace}${apiPath}`,
    {
      body: body == null ? undefined : JSON.stringify(dropUndefinedValues(body)),
      headers: {
        authorization: `Bearer ${input.apiToken}`,
        "content-type": "application/json",
      },
      method,
    },
  );
  const json = (await response.json()) as CloudflareApiEnvelope<T>;
  if (!response.ok || json.success !== true || json.result == null) {
    throw new CloudflareArtifactsRestError(response.status, apiPath, cloudflareErrorMessage(json));
  }
  return json.result;
}

class CloudflareArtifactsRestError extends Error {
  constructor(
    readonly status: number,
    apiPath: string,
    message: string,
  ) {
    super(`Cloudflare Artifacts request failed (${status} ${apiPath}): ${message}`);
  }
}

async function waitForRestRepo(input: CloudflareArtifactsRestBindingInput, name: string) {
  const apiPath = `/repos/${encodeURIComponent(name)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await artifactsApi<CloudflareArtifactRepo>(input, "GET", apiPath);
    } catch (error) {
      if (!(error instanceof CloudflareArtifactsRestError) || error.status !== 409) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  return await artifactsApi<CloudflareArtifactRepo>(input, "GET", apiPath);
}

type CloudflareApiEnvelope<T> = {
  errors?: Array<{ message?: string }>;
  messages?: Array<{ message?: string }>;
  result?: T | null;
  success?: boolean;
};

function cloudflareErrorMessage(payload: CloudflareApiEnvelope<unknown>) {
  const messages = [...(payload.errors ?? []), ...(payload.messages ?? [])]
    .map((entry) => entry.message)
    .filter((message) => typeof message === "string" && message.length > 0);
  return messages.length > 0 ? messages.join("; ") : JSON.stringify(payload);
}

function dropUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
