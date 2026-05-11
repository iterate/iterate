import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";

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

export const REPO_DEFAULT_BRANCH = "main";
export const REPO_README_PATH = "README.md";
export const REPO_WRITE_TOKEN_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export function repoArtifactName(input: { projectId: string; repoSlug: string }) {
  return `${input.projectId}--${input.repoSlug}`;
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
    password: input.token,
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
