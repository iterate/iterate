// Complete, PAGED traversal over `@cloudflare/shell`'s Workspace filesystem.
// shell's readDir has a silent default page limit; every consumer here pages
// until a short page, so no directory size silently truncates a listing, a
// status, a wipe, or a cache rebuild. Neutral home on purpose: both the repo
// domain (head-tree cache) and the workspace domain (overlay local layer)
// walk shell filesystems, and neither should import the other's feature core
// for generic traversal.

import type { Workspace } from "@cloudflare/shell";

const READ_DIR_PAGE = 1_000;

/** Every file path under `dir` (absolute, no directories), fully paged. */
export async function walkWorkspaceFiles(workspace: Workspace, dir = "/"): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readDirComplete(workspace, dir)) {
    if (entry.type === "directory")
      paths.push(...(await walkWorkspaceFiles(workspace, entry.path)));
    else if (entry.type === "file") paths.push(entry.path);
  }
  return paths;
}

/** Remove every entry of `dir`: destructive wipes consume page zero until empty. */
export async function wipeWorkspace(workspace: Workspace, dir = "/"): Promise<void> {
  for (;;) {
    const page = await workspace.readDir(dir, { limit: READ_DIR_PAGE });
    if (page.length === 0) return;
    for (const entry of page) {
      await workspace.rm(entry.path, { force: true, recursive: true });
    }
  }
}

async function readDirComplete(
  workspace: Workspace,
  dir?: string,
): Promise<{ name: string; path: string; type: string }[]> {
  const entries: { name: string; path: string; type: string }[] = [];
  for (let offset = 0; ; offset += READ_DIR_PAGE) {
    const page = await workspace.readDir(dir, { limit: READ_DIR_PAGE, offset });
    entries.push(...page);
    if (page.length < READ_DIR_PAGE) return entries;
  }
}
