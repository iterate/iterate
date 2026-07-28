import { InMemoryFs } from "@cloudflare/shell";
import { stableSha256 } from "../workers/utils.ts";

const textEncoder = new TextEncoder();

/**
 * Whole-checkout content identity. Build keys hash this plus the ref's masks,
 * so a commit touching only mask-excluded files still changes every build key
 * for the repo — a spurious cache miss (correct output, one extra build), the
 * accepted cost of one stable whole-repo identity instead of per-mask hashes.
 * Lives here so initial seeding and every later head update use exactly the
 * same content-hash algorithm.
 */
export async function repoContentHash(files: Record<string, string>): Promise<string> {
  return await stableSha256({ files, type: "repo-content" });
}

export async function readCheckoutFileBytes(
  filesystem: InMemoryFs,
  absolutePath: string,
): Promise<Uint8Array> {
  const stat = await filesystem.lstat(absolutePath);
  return stat.type === "symlink"
    ? textEncoder.encode(await filesystem.readlink(absolutePath))
    : filesystem.readFileBytes(absolutePath);
}

export async function readCheckoutTextFile(
  filesystem: InMemoryFs,
  absolutePath: string,
): Promise<string> {
  const stat = await filesystem.lstat(absolutePath);
  return stat.type === "symlink"
    ? filesystem.readlink(absolutePath)
    : filesystem.readFile(absolutePath);
}

/** All committed file paths of a checkout (skips .git). Uses lstat because a
 * dangling symlink is a valid Git tree entry and must not be dereferenced. */
export async function walkCheckoutPaths(
  filesystem: InMemoryFs,
  repoDir: string,
): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await filesystem.readdir(dir)) {
      if (dir === repoDir && entry === ".git") continue;
      const absolute = `${dir}/${entry}`;
      const stat = await filesystem.lstat(absolute);
      if (stat.type === "directory") await walk(absolute);
      else paths.push(absolute.slice(repoDir.length + 1));
    }
  };
  await walk(repoDir);
  return paths;
}

/** All committed files as path -> text. Git stores a symlink's target as its
 * blob content, so expose that target instead of following the checkout link. */
export async function readCheckoutFiles(
  filesystem: InMemoryFs,
  repoDir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await walkCheckoutPaths(filesystem, repoDir)) {
    files[path] = await readCheckoutTextFile(filesystem, `${repoDir}/${path}`);
  }
  return files;
}

/** All committed files as path -> raw bytes for history diffs. */
export async function readCheckoutBytes(
  filesystem: InMemoryFs,
  repoDir: string,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const path of await walkCheckoutPaths(filesystem, repoDir)) {
    files.set(path, await readCheckoutFileBytes(filesystem, `${repoDir}/${path}`));
  }
  return files;
}
