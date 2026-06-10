import { InMemoryFs } from "@cloudflare/shell";
import { createGit, type Git, type GitAuthor, type GitLogEntry } from "@cloudflare/shell/git";
import { z } from "zod";
import { stripArtifactTokenQuery } from "~/domains/repos/artifacts.ts";

/**
 * Workspace-free git operations against an artifact repo remote. Every call
 * clones into a throwaway InMemoryFs, does its work, and (for commits) pushes
 * back — there is no persistent working copy.
 */

export const REPO_COMMIT_AUTHOR: GitAuthor = {
  name: "Iterate",
  email: "support@iterate.com",
};

const RepoPath = z
  .string()
  .trim()
  .min(1)
  .transform((path, ctx) => {
    const normalized = normalizeRepoPath(path);
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: `Invalid repo path: ${path}` });
      return z.NEVER;
    }
    return normalized;
  });

export const RepoFileChange = z.union([
  z.object({
    path: RepoPath,
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
  }),
  z.object({
    path: RepoPath,
    delete: z.literal(true),
  }),
]);
export type RepoFileChange = z.infer<typeof RepoFileChange>;

export const CommitRepoFilesInput = z.object({
  author: z.object({ email: z.string().trim().min(1), name: z.string().trim().min(1) }).optional(),
  branch: z.string().trim().min(1).optional(),
  changes: z.array(RepoFileChange).min(1),
  message: z.string().trim().min(1),
});
export type CommitRepoFilesInput = z.infer<typeof CommitRepoFilesInput>;

export const ReadRepoFilesInput = z.object({
  branch: z.string().trim().min(1).optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  paths: z.array(RepoPath).min(1),
});
export type ReadRepoFilesInput = z.infer<typeof ReadRepoFilesInput>;

export const ListRepoFilesInput = z.object({
  branch: z.string().trim().min(1).optional(),
});
export type ListRepoFilesInput = z.infer<typeof ListRepoFilesInput>;

export const ReadRepoLogInput = z.object({
  branch: z.string().trim().min(1).optional(),
  depth: z.number().int().min(1).max(1000).optional(),
});
export type ReadRepoLogInput = z.infer<typeof ReadRepoLogInput>;

export type CommitRepoFilesResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  createdBranch: boolean;
  noChanges: boolean;
};

type RepoRemote = {
  remote: string;
  token: string;
};

const REPO_DIR = "/repo";

export async function commitRepoFiles(
  input: RepoRemote & {
    author?: GitAuthor;
    branch: string;
    changes: RepoFileChange[];
    defaultBranch: string;
    message: string;
  },
): Promise<CommitRepoFilesResult> {
  // Full clone (no depth) — pushing from a shallow clone is fragile in
  // isomorphic-git when it walks history to compute the pack.
  const checkout = await checkoutRepoBranch({
    branch: input.branch,
    createMissingBranchFrom: input.branch === input.defaultBranch ? null : input.defaultBranch,
    remote: input.remote,
    token: input.token,
  });

  const changedPaths = await applyRepoFileChanges({
    changes: input.changes,
    filesystem: checkout.filesystem,
    git: checkout.git,
  });

  if (changedPaths.length === 0 && !checkout.createdBranch) {
    const [head] = await checkout.git.log({ depth: 1 });
    if (!head) {
      throw new Error("Repo has no commits.");
    }
    return {
      branch: input.branch,
      changedPaths: [],
      commitOid: head.oid,
      createdBranch: false,
      noChanges: true,
    };
  }

  let commitOid: string;
  if (changedPaths.length === 0) {
    // New branch with no file changes: push the branch pointer as-is.
    const [head] = await checkout.git.log({ depth: 1 });
    if (!head) {
      throw new Error("Repo has no commits.");
    }
    commitOid = head.oid;
  } else {
    const commit = await checkout.git.commit({
      author: input.author ?? REPO_COMMIT_AUTHOR,
      message: input.message,
    });
    commitOid = commit.oid;
  }

  const pushed = await checkout.git.push({
    ref: input.branch,
    ...checkout.credentials,
  });
  if (!pushed.ok) {
    throw new Error(`Failed to push ${input.branch}: ${JSON.stringify(pushed.refs)}`);
  }

  return {
    branch: input.branch,
    changedPaths,
    commitOid,
    createdBranch: checkout.createdBranch,
    noChanges: changedPaths.length === 0,
  };
}

export async function readRepoFiles(
  input: RepoRemote & {
    branch: string;
    encoding?: "utf8" | "base64";
    paths: string[];
  },
): Promise<Array<{ content: string | null; path: string }>> {
  const checkout = await checkoutRepoBranch({
    branch: input.branch,
    createMissingBranchFrom: null,
    depth: 1,
    remote: input.remote,
    token: input.token,
  });

  const files: Array<{ content: string | null; path: string }> = [];
  for (const path of input.paths) {
    const absolutePath = `${REPO_DIR}/${path}`;
    if (!(await checkout.filesystem.exists(absolutePath))) {
      files.push({ content: null, path });
      continue;
    }
    files.push({
      content:
        input.encoding === "base64"
          ? bytesToBase64(await checkout.filesystem.readFileBytes(absolutePath))
          : await checkout.filesystem.readFile(absolutePath),
      path,
    });
  }
  return files;
}

export async function listRepoFiles(input: RepoRemote & { branch: string }): Promise<string[]> {
  const checkout = await checkoutRepoBranch({
    branch: input.branch,
    createMissingBranchFrom: null,
    depth: 1,
    remote: input.remote,
    token: input.token,
  });

  const paths: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await checkout.filesystem.readdirWithFileTypes(dir)) {
      if (dir === REPO_DIR && entry.name === ".git") continue;
      const entryPath = `${dir}/${entry.name}`;
      if (entry.type === "directory") {
        await walk(entryPath);
      } else {
        paths.push(entryPath.slice(REPO_DIR.length + 1));
      }
    }
  };
  await walk(REPO_DIR);
  return paths.sort();
}

export async function readRepoLog(
  input: RepoRemote & { branch: string; depth?: number },
): Promise<GitLogEntry[]> {
  const depth = input.depth ?? 20;
  const checkout = await checkoutRepoBranch({
    branch: input.branch,
    createMissingBranchFrom: null,
    depth,
    remote: input.remote,
    token: input.token,
  });
  return await checkout.git.log({ depth });
}

/**
 * Apply file writes/deletes to a checked-out working tree and stage them.
 * Returns the paths git actually considers changed — writing identical
 * content or deleting an absent file drops out here.
 */
export async function applyRepoFileChanges(input: {
  changes: RepoFileChange[];
  filesystem: InMemoryFs;
  git: Git;
  dir?: string;
}): Promise<string[]> {
  const dir = input.dir ?? REPO_DIR;
  for (const change of input.changes) {
    const absolutePath = `${dir}/${change.path}`;
    if ("delete" in change) {
      if (await input.filesystem.exists(absolutePath)) {
        await input.filesystem.rm(absolutePath);
      }
      // Removes the index entry; no-op when the path is untracked.
      await input.git.rm({ dir, filepath: change.path });
      continue;
    }

    const parent = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
    if (parent !== "" && !(await input.filesystem.exists(parent))) {
      await input.filesystem.mkdir(parent, { recursive: true });
    }
    if (change.encoding === "base64") {
      await input.filesystem.writeFileBytes(absolutePath, base64ToBytes(change.content));
    } else {
      await input.filesystem.writeFile(absolutePath, change.content);
    }
    await input.git.add({ dir, filepath: change.path });
  }

  const status = await input.git.status({ dir });
  return status.map((entry) => entry.filepath).sort();
}

export function isGitAuthError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /\b(401|403)\b|unauthorized|authentication/i.test(error.message);
}

async function checkoutRepoBranch(input: {
  branch: string;
  /** When set, a missing remote branch is created locally off this branch. */
  createMissingBranchFrom: string | null;
  depth?: number;
  remote: string;
  token: string;
}) {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  const credentials = {
    username: "x",
    password: stripArtifactTokenQuery(input.token),
  };

  let createdBranch = false;
  try {
    await git.clone({
      branch: input.branch,
      depth: input.depth,
      singleBranch: true,
      url: input.remote,
      ...credentials,
    });
  } catch (error) {
    if (input.createMissingBranchFrom === null || !isMissingRemoteRefError(error)) {
      throw error;
    }
    await git.clone({
      branch: input.createMissingBranchFrom,
      depth: input.depth,
      singleBranch: true,
      url: input.remote,
      ...credentials,
    });
    await git.checkout({ branch: input.branch });
    createdBranch = true;
  }

  return { createdBranch, credentials, filesystem, git };
}

function isMissingRemoteRefError(error: unknown) {
  return error instanceof Error && /could not find/i.test(error.message);
}

/**
 * Repo-relative path: strips a leading slash, rejects traversal and anything
 * inside .git. Returns null when the path is not allowed.
 */
function normalizeRepoPath(path: string): string | null {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "") return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  if (segments[0] === ".git") return null;
  return normalized;
}

function base64ToBytes(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
