import { minimatch } from "minimatch";
import { describe, expect, test } from "vitest";
import type { Workspace } from "@cloudflare/shell";
import type { WorkspaceMount } from "./workspace-processor-contract.ts";
import { reRoutedPaths, WorkspaceCore, type MountRepoAccess } from "./workspace-core.ts";

/** The slice of `@cloudflare/shell`'s Workspace the core touches, in memory. */
function fakeLocalLayer() {
  const files = new Map<string, Uint8Array>();
  const workspace = {
    readFile: async (path: string) => {
      const bytes = files.get(path);
      return bytes === undefined ? null : new TextDecoder().decode(bytes);
    },
    readFileBytes: async (path: string) => files.get(path) ?? null,
    writeFile: async (path: string, content: string) =>
      void files.set(path, new TextEncoder().encode(content)),
    writeFileBytes: async (path: string, data: Uint8Array) => void files.set(path, data),
    deleteFile: async (path: string) => files.delete(path),
    exists: async (path: string) =>
      files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
    rm: async (path: string) => {
      files.delete(path);
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) files.delete(key);
      }
    },
    readDir: async (dir = "/") => {
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const children = new Map<string, "directory" | "file">();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        if (head === "" || head === undefined) continue;
        children.set(head, tail.length > 0 ? "directory" : "file");
      }
      return [...children.entries()].map(([name, type]) => ({
        name,
        path: `${prefix}${name}`,
        type,
      }));
    },
  };
  return { files, workspace: workspace as unknown as Workspace };
}

function fakeKv() {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key: string, value: unknown) => void map.set(key, structuredClone(value)),
    delete: (key: string) => void map.delete(key),
  };
}

/** One fake repo: HEAD tree as a path→content map. FAITHFUL commits: changes
 * APPLY to the tree (content and deletions) exactly like production main, so
 * post-commit fall-through assertions test the real read-your-write shape. */
function fakeRepo(tree: Record<string, string>) {
  const commits: { amendIfHead?: string; changes: unknown[]; message: string }[] = [];
  const snapshotCalls: string[][] = [];
  const repo: MountRepoAccess = {
    readFile: async ({ encoding, path }) => {
      const content = tree[path];
      if (content === undefined) return null;
      return {
        commitOid: "head-oid",
        content: encoding === "base64" ? btoa(content) : content,
        path,
      };
    },
    listFiles: async () => ({ commitOid: "head-oid", paths: Object.keys(tree).sort() }),
    getFilesSnapshot: async (input) => {
      // The real repo object serializes this record across a workerd RPC with
      // a 32MiB cap — an unscoped call on a big repo IS the outage (43.7MB
      // crossed for 560KB of task files on iterate/iterate). Refusing it here
      // means no fall-through pathway can regress to full-tree pulls.
      if (input?.paths === undefined) {
        throw new Error("unscoped getFilesSnapshot: the full HEAD tree must never cross the RPC");
      }
      snapshotCalls.push([...input.paths]);
      const files: Record<string, string> = {};
      for (const path of input.paths) {
        const content = tree[path];
        if (content !== undefined) files[path] = content;
      }
      return { commitOid: "head-oid", files };
    },
    commitFiles: async (input) => {
      commits.push({
        ...(input.amendIfHead === undefined ? {} : { amendIfHead: input.amendIfHead }),
        changes: input.changes,
        message: input.message,
      });
      for (const change of input.changes) {
        if ("delete" in change && change.delete) delete tree[change.path];
        else if ("content" in change) tree[change.path] = change.content;
        else if ("contentBase64" in change) tree[change.path] = atob(change.contentBase64);
      }
      return {
        // The fake's head is always "head-oid"; matching it is what a real
        // repo would call an amend.
        amended: input.amendIfHead === "head-oid",
        branch: "main",
        changedPaths: input.changes.map((change) => change.path),
        commitOid: `commit-${commits.length}`,
        noChanges: input.changes.length === 0,
      };
    },
    log: async ({ limit }) => ({
      commits: [
        {
          author: { email: "bot@iterate.com", name: "iterate" },
          message: `head of ${Object.keys(tree).length}-file repo`,
          oid: "head-oid",
          timestamp: 1,
        },
      ].slice(0, limit ?? 1),
    }),
  };
  return { commits, repo, snapshotCalls };
}

// The workspace's own directory (its stream path): the ONLY subtree where
// unmounted private scratch may be written.
const SCRATCH_ROOT = "/workspaces/test";

const MOUNTS: Record<string, WorkspaceMount> = {
  "/config": { policy: "commit-to-main", repoPath: "/repos/config" },
  "/iterate": { policy: "read-only", repoPath: "/repos/iterate" },
};

function subject(mounts: Record<string, WorkspaceMount> = MOUNTS) {
  const config = fakeRepo({ "worker.ts": "export default {}", "tasks/one.md": "# one" });
  const iterate = fakeRepo({ "README.md": "# iterate", "tasks/two.md": "# two" });
  const { files, workspace } = fakeLocalLayer();
  const core = new WorkspaceCore({
    kv: fakeKv(),
    mounts: async () => mounts,
    repo: (repoPath) => {
      if (repoPath === "/repos/config") return config.repo;
      if (repoPath === "/repos/iterate") return iterate.repo;
      throw new Error(`unexpected repo "${repoPath}"`);
    },
    scratchRoot: SCRATCH_ROOT,
    workspace,
  });
  return { config, core, iterate, localFiles: files };
}

describe("mount-routed reads", () => {
  test("reads fall through to the longest-prefix mount's repo; local shadows win", async () => {
    const { core } = subject();
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("export default {}");
    await expect(core.readFile("/iterate/README.md")).resolves.toBe("# iterate");
    await expect(core.readFile("/iterate/missing.md")).resolves.toBeNull();
    await expect(core.readFile("/unmounted/scratch.txt")).resolves.toBeNull();

    await core.writeFile("/config/worker.ts", "shadowed");
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("shadowed");
  });

  test("deleteFile whiteouts the mount copy; revert un-pins it", async () => {
    const { core } = subject();
    await expect(core.deleteFile("/config/worker.ts")).resolves.toBe(true);
    await expect(core.readFile("/config/worker.ts")).resolves.toBeNull();
    await expect(core.exists("/config/worker.ts")).resolves.toBe(false);

    await core.revert("/config/worker.ts");
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("export default {}");
  });

  test("listAllFiles and glob merge the local layer with every mount", async () => {
    const { core } = subject();
    await core.writeFile(`${SCRATCH_ROOT}/notes.txt`, "hi");
    await expect(core.listAllFiles()).resolves.toEqual([
      "/config/tasks/one.md",
      "/config/worker.ts",
      "/iterate/README.md",
      "/iterate/tasks/two.md",
      `${SCRATCH_ROOT}/notes.txt`,
    ]);
    expect(
      (await core.listAllFiles()).filter((path) =>
        minimatch(path, "**/tasks/**/*.md", { dot: true }),
      ),
    ).toEqual(["/config/tasks/one.md", "/iterate/tasks/two.md"]);
  });

  test("readFileBytes decodes the mount's base64 lane", async () => {
    const { core } = subject();
    const bytes = await core.readFileBytes("/iterate/README.md");
    expect(new TextDecoder().decode(bytes!)).toBe("# iterate");
  });
});

describe("batched mount reads", () => {
  test("readMountFiles pays ONE scoped snapshot per mount, asking for exactly the routed paths", async () => {
    const { config, core, iterate } = subject();
    await expect(
      core.readMountFiles([
        "/config/worker.ts",
        "/config/tasks/one.md",
        "/iterate/tasks/two.md",
        "/iterate/missing.md",
        "/unmounted/scratch.txt",
      ]),
    ).resolves.toEqual({
      "/config/worker.ts": "export default {}",
      "/config/tasks/one.md": "# one",
      "/iterate/tasks/two.md": "# two",
      "/iterate/missing.md": null,
      "/unmounted/scratch.txt": null,
    });
    expect(config.snapshotCalls).toEqual([["worker.ts", "tasks/one.md"]]);
    expect(iterate.snapshotCalls).toEqual([["tasks/two.md", "missing.md"]]);
  });

  test("a big repo's unrequested files never ride the snapshot", async () => {
    // The prod shape: iterate/iterate's 73 task files are 560KB, its full
    // HEAD tree 43.7MB — past the RPC cap. The fixture throws on unscoped
    // calls, so this resolving proves the board-seed read is bounded by what
    // was asked, not by repo size.
    const big = fakeRepo({
      "tasks/board.md": "# board",
      "vendored/blob.txt": "x".repeat(4096),
    });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({ "/repos/big": { policy: "commit-to-main", repoPath: "/repos/big" } }),
      repo: () => big.repo,
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await expect(core.readMountFiles(["/repos/big/tasks/board.md"])).resolves.toEqual({
      "/repos/big/tasks/board.md": "# board",
    });
    expect(big.snapshotCalls).toEqual([["tasks/board.md"]]);
  });

  test("whiteouts and virtual directories mask batched reads exactly like readFile", async () => {
    const { config, core } = subject();
    await core.deleteFile("/config/worker.ts");
    await expect(
      core.readMountFiles(["/config/worker.ts", "/config", "/config/tasks/one.md"]),
    ).resolves.toEqual({
      "/config/worker.ts": null,
      "/config": null,
      "/config/tasks/one.md": "# one",
    });
    // The masked paths never reached the repo — only the surviving one did.
    expect(config.snapshotCalls).toEqual([["tasks/one.md"]]);
  });
});

describe("git status, commit, and log", () => {
  test("status groups changes by owning mount, plus unmounted scratch", async () => {
    const { core } = subject();
    await core.writeFile("/config/worker.ts", "changed");
    await core.writeFile("/config/new.ts", "new");
    await core.deleteFile("/iterate/README.md");
    await core.writeFile(`${SCRATCH_ROOT}/notes.txt`, "hi");

    await expect(core.gitStatus()).resolves.toEqual({
      mounts: [
        {
          changes: [
            { change: "added", path: "/config/new.ts" },
            { change: "modified", path: "/config/worker.ts" },
          ],
          path: "/config",
          policy: "commit-to-main",
          repoPath: "/repos/config",
        },
        {
          changes: [{ change: "deleted", path: "/iterate/README.md" }],
          path: "/iterate",
          policy: "read-only",
          repoPath: "/repos/iterate",
        },
      ],
      unmounted: [{ change: "added", path: `${SCRATCH_ROOT}/notes.txt` }],
    });
  });

  test("commit routes one mount's changes to its repo and clears only that subtree", async () => {
    const { config, core } = subject();
    await core.writeFile("/config/worker.ts", "changed");
    await core.deleteFile("/config/tasks/one.md");
    await core.writeFile(`${SCRATCH_ROOT}/notes.txt`, "survives");

    const result = await core.gitCommit({ message: "update worker" });
    expect(result).toMatchObject({
      branch: "main",
      changedPaths: ["/config/tasks/one.md", "/config/worker.ts"],
      commitOid: "commit-1",
      mount: "/config",
      repoPath: "/repos/config",
    });
    expect(config.commits[0]).toEqual({
      changes: [
        { content: "changed", path: "worker.ts" },
        { delete: true, path: "tasks/one.md" },
      ],
      message: "update worker",
    });

    // The mount subtree cleared: reads fall through to the NEW main — the
    // committed content and the applied deletion — while scratch survives.
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("changed");
    await expect(core.readFile("/config/tasks/one.md")).resolves.toBeNull();
    await expect(core.readFile(`${SCRATCH_ROOT}/notes.txt`)).resolves.toBe("survives");
    const statusAfter = await core.gitStatus();
    expect(statusAfter.mounts.find((mount) => mount.path === "/config")?.changes).toEqual([]);
  });

  test("commit forwards amendIfHead to the repo and reports whether it amended", async () => {
    const { config, core } = subject();
    await core.writeFile("/config/log.md", "## 2026-09-02\n- first\n");
    const first = await core.gitCommit({ amendIfHead: "not-the-head", message: "log" });
    expect(first.amended).toBe(false);
    expect(config.commits[0]).toMatchObject({ amendIfHead: "not-the-head", message: "log" });

    await core.writeFile("/config/log.md", "## 2026-09-02\n- first\n- second\n");
    const second = await core.gitCommit({ amendIfHead: "head-oid", message: "log" });
    expect(second.amended).toBe(true);
    expect(config.commits[1]).toMatchObject({ amendIfHead: "head-oid" });
  });

  test("commit refuses to span mounts and names the scope choices", async () => {
    const { core } = subject();
    await core.writeFile("/config/a.ts", "a");
    await core.writeFile("/iterate/b.ts", "b");
    await expect(core.gitCommit({ message: "boom" })).rejects.toThrow(
      /span.*mounts.*"\/config", "\/iterate"/s,
    );
  });

  test("read-only mounts reject commits", async () => {
    const { core } = subject();
    await core.writeFile("/iterate/b.ts", "b");
    await expect(core.gitCommit({ message: "boom", scope: "/iterate" })).rejects.toThrow(
      /read-only/,
    );
  });

  test("scope must name an existing mount", async () => {
    const { core } = subject();
    await core.writeFile("/config/a.ts", "a");
    await expect(core.gitCommit({ message: "boom", scope: "/nope" })).rejects.toThrow(
      /No mount at "\/nope"/,
    );
  });

  test("log reads one mount's repo history; scope optional with one mount", async () => {
    const single = subject({
      "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
    });
    await expect(single.core.gitLog()).resolves.toMatchObject([{ oid: "head-oid" }]);

    const { core } = subject();
    await expect(core.gitLog()).rejects.toThrow(/log needs \{ scope \}/);
    await expect(core.gitLog({ scope: "/iterate" })).resolves.toMatchObject([
      { message: "head of 2-file repo" },
    ]);
  });
});

describe("nested mounts", () => {
  test("an outer mount is shadowed by deeper mounts, for reads, listing, and status alike", async () => {
    const nested: Record<string, WorkspaceMount> = {
      "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
      "/repos/config/tasks": { policy: "read-only", repoPath: "/repos/iterate" },
    };
    const { core } = subject(nested);
    // "/repos/config/tasks/**" belongs to the deeper mount (the iterate repo
    // appears there), so the config repo's tasks/one.md is unreachable and
    // worker.ts routes to the outer mount.
    await expect(core.readFile("/repos/config/worker.ts")).resolves.toBe("export default {}");
    await expect(core.readFile("/repos/config/tasks/one.md")).resolves.toBeNull();
    await expect(core.readFile("/repos/config/tasks/README.md")).resolves.toBe("# iterate");

    // The shadowed config file appears in NO listing: not at its own path
    // (the deeper mount owns it) and not as a deletion.
    await expect(core.listAllFiles()).resolves.toEqual([
      "/repos/config/tasks/README.md",
      "/repos/config/tasks/tasks/two.md",
      "/repos/config/worker.ts",
    ]);

    // Deleting the shadowed path is a no-op delete (nothing visible there).
    await expect(core.deleteFile("/repos/config/tasks/one.md")).resolves.toBe(false);

    const status = await core.gitStatus();
    const outer = status.mounts.find((mount) => mount.path === "/repos/config")!;
    expect(outer.changes).toEqual([]);
  });
});

describe("strict writes and private scratch", () => {
  test("writes to unmounted absolute paths are rejected loudly — never silent stray scratch", async () => {
    const { core } = subject();
    // A repo that is not mounted, and another workspace's directory: both are
    // almost always typos, and both must fail instead of stranding work.
    await expect(core.writeFile("/repos/other/file.ts", "x")).rejects.toThrow(/not writable/);
    await expect(core.writeFile("/workspaces/other/notes.md", "x")).rejects.toThrow(/not writable/);
    await expect(core.writeFileBytes("/notes.md", new Uint8Array([1]))).rejects.toThrow(
      /not writable/,
    );
    // The rejection teaches where writes belong: the workspace's own
    // directory and the mounted repo subtrees.
    await expect(core.writeFile("/notes.md", "x")).rejects.toThrow(
      /Private files live under your workspace directory \("\/workspaces\/test\//,
    );
  });

  test("scratch writes under the workspace's own directory succeed and surface as unmounted changes", async () => {
    const { core } = subject();
    await core.writeFile(`${SCRATCH_ROOT}/notes/draft.md`, "hi");
    await expect(core.readFile(`${SCRATCH_ROOT}/notes/draft.md`)).resolves.toBe("hi");
    const status = await core.gitStatus();
    expect(status.unmounted).toEqual([{ change: "added", path: `${SCRATCH_ROOT}/notes/draft.md` }]);
  });

  test("the scratch root itself is a directory — only paths strictly beneath it are writable", async () => {
    const { core } = subject();
    await expect(core.writeFile(SCRATCH_ROOT, "x")).rejects.toThrow(/not writable/);
  });

  test("a clean mount's status pays NO repo listing", async () => {
    const config = fakeRepo({ "worker.ts": "x" });
    const iterate = fakeRepo({ "README.md": "# iterate" });
    let configListings = 0;
    let iterateListings = 0;
    const countingConfig: MountRepoAccess = {
      ...config.repo,
      listFiles: () => {
        configListings += 1;
        return config.repo.listFiles();
      },
    };
    const countingIterate: MountRepoAccess = {
      ...iterate.repo,
      listFiles: () => {
        iterateListings += 1;
        return iterate.repo.listFiles();
      },
    };
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => MOUNTS,
      repo: (repoPath) => (repoPath === "/repos/config" ? countingConfig : countingIterate),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    // A fully clean workspace: with every project repo mounted by derivation,
    // status must not fan one listFiles per repo just to learn that untouched
    // mounts are untouched.
    await core.gitStatus();
    expect(configListings + iterateListings).toBe(0);
    // One dirty mount: only ITS repo pays a listing.
    await core.writeFile("/config/a.md", "dirty");
    await core.gitStatus();
    expect(configListings).toBe(1);
    expect(iterateListings).toBe(0);
  });
});

describe("thermo regressions", () => {
  test("a repeated delete does not resurrect the mount file", async () => {
    const { core } = subject();
    await expect(core.deleteFile("/config/worker.ts")).resolves.toBe(true);
    // Second delete: nothing visible remains; the whiteout must survive.
    await expect(core.deleteFile("/config/worker.ts")).resolves.toBe(false);
    await expect(core.readFile("/config/worker.ts")).resolves.toBeNull();
    await expect(core.exists("/config/worker.ts")).resolves.toBe(false);
  });

  test("a failed mount probe during delete leaves no whiteout behind", async () => {
    const config = fakeRepo({ "worker.ts": "export default {}" });
    const { workspace } = fakeLocalLayer();
    let failProbe = false;
    const failing: MountRepoAccess = {
      ...config.repo,
      readFile: (input) => {
        if (failProbe) throw new Error("injected repo outage");
        return config.repo.readFile(input);
      },
    };
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } }),
      repo: () => failing,
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    failProbe = true;
    await expect(core.deleteFile("/config/worker.ts")).rejects.toThrow(/injected repo outage/);
    failProbe = false;
    // The failed delete changed nothing durable: the file still reads.
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("export default {}");
  });

  test("committing an OUTER mount preserves a nested mount's pending deletion", async () => {
    const nested: Record<string, WorkspaceMount> = {
      "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
      "/repos/config/side": { policy: "commit-to-main", repoPath: "/repos/iterate" },
    };
    const config = fakeRepo({ "worker.ts": "export default {}" });
    const iterate = fakeRepo({ "note.md": "side truth" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => nested,
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : iterate.repo),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await core.deleteFile("/repos/config/side/note.md");
    await core.writeFile("/repos/config/root-change.md", "x");
    const committed = await core.gitCommit({ message: "outer only", scope: "/repos/config" });
    expect(committed).toMatchObject({
      changedPaths: ["/repos/config/root-change.md"],
      mount: "/repos/config",
    });
    // The deeper mount's deletion is still pending, not silently consumed.
    await expect(core.readFile("/repos/config/side/note.md")).resolves.toBeNull();
    const status = await core.gitStatus();
    expect(status.mounts.find((mount) => mount.path === "/repos/config/side")?.changes).toEqual([
      { change: "deleted", path: "/repos/config/side/note.md" },
    ]);
  });

  test("a scoped commit lists ONLY the scoped mount's repo", async () => {
    const config = fakeRepo({ "worker.ts": "export default {}" });
    const iterate = fakeRepo({ "README.md": "# iterate" });
    let iterateListings = 0;
    const countingIterate: MountRepoAccess = {
      ...iterate.repo,
      listFiles: () => {
        iterateListings += 1;
        return iterate.repo.listFiles();
      },
    };
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/config": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/iterate": { policy: "read-only", repoPath: "/repos/iterate" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : countingIterate),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await core.writeFile("/config/a.md", "a");
    await core.gitCommit({ message: "scoped", scope: "/config" });
    expect(iterateListings).toBe(0);
  });

  test("commit heals a stale whiteout (crash residue) instead of wedging on it", async () => {
    // Simulate the crash residue: delete a mount file, then the "repo write
    // landed but cleanup died" state — the repo no longer has the file while
    // the whiteout remains.
    const config = fakeRepo({ "only.md": "x" });
    const { workspace } = fakeLocalLayer();
    const crashCore = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } }),
      repo: () => config.repo,
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await crashCore.deleteFile("/config/only.md");
    // "crash": the repo applies the deletion out-of-band; the whiteout stays.
    config.repo.listFiles = async () => ({ commitOid: "head-oid", paths: [] });
    config.repo.readFile = async () => null;
    // A retry commit finds nothing real to commit — and says so cleanly
    // (the stale whiteout is healed rather than nominating changes forever).
    await expect(crashCore.gitCommit({ message: "retry" })).rejects.toThrow(/Nothing to commit/);
    const status = await crashCore.gitStatus();
    expect(status.mounts[0]!.changes).toEqual([]);
  });

  test("`.gitignore` rules do not cross mount boundaries", async () => {
    const config = fakeRepo({ "worker.ts": "export default {}" });
    const iterate = fakeRepo({ "README.md": "# iterate" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/repos/config/side": { policy: "commit-to-main", repoPath: "/repos/iterate" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : iterate.repo),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    // An OUTER-mount .gitignore suppressing *.log must not hide the nested
    // mount's local log file from ITS commit.
    await core.writeFile("/repos/config/.gitignore", "*.log\n");
    await core.writeFile("/repos/config/root.log", "suppressed");
    await core.writeFile("/repos/config/side/kept.log", "kept");
    const status = await core.gitStatus();
    const outer = status.mounts.find((mount) => mount.path === "/repos/config")!;
    const side = status.mounts.find((mount) => mount.path === "/repos/config/side")!;
    expect(outer.changes.map((change) => change.path)).not.toContain("/repos/config/root.log");
    expect(side.changes.map((change) => change.path)).toContain("/repos/config/side/kept.log");
  });

  test("exists() answers for mounted directories and mount points", async () => {
    const { core } = subject();
    await expect(core.exists("/config")).resolves.toBe(true);
    await expect(core.exists("/config/tasks")).resolves.toBe(true);
    await expect(core.exists("/config/nope")).resolves.toBe(false);
  });
});

describe("thermo round-two regressions", () => {
  test("a failed delete preserves the LOCAL SHADOW bytes untouched", async () => {
    const config = fakeRepo({ "worker.ts": "repo version" });
    const { workspace } = fakeLocalLayer();
    let failProbe = false;
    const failing: MountRepoAccess = {
      ...config.repo,
      readFile: (input) => {
        if (failProbe) throw new Error("injected repo outage");
        return config.repo.readFile(input);
      },
    };
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } }),
      repo: () => failing,
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await core.writeFile("/config/worker.ts", "precious local edits");
    failProbe = true;
    await expect(core.deleteFile("/config/worker.ts")).rejects.toThrow(/injected repo outage/);
    failProbe = false;
    // The caller's uncommitted work survives the failed operation intact.
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("precious local edits");
    const status = await core.gitStatus();
    expect(status.mounts[0]!.changes).toEqual([{ change: "modified", path: "/config/worker.ts" }]);
  });

  test("writes cannot land ON a mount point (it is a virtual directory)", async () => {
    const { core } = subject();
    await expect(core.writeFile("/config", "not a file")).rejects.toThrow(/mount point/);
    await expect(core.writeFileBytes("/iterate", new Uint8Array([1]))).rejects.toThrow(
      /mount point/,
    );
    // The workspace root stays covered by the platform guard.
    await expect(core.writeFile("/", "nope")).rejects.toThrow(/not writable/);
  });

  test("STATUS heals a stale whiteout — no commit attempt required", async () => {
    const config = fakeRepo({ "only.md": "x" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } }),
      repo: () => config.repo,
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await core.deleteFile("/config/only.md");
    // "crash residue": the repo applied the deletion out-of-band; the
    // whiteout remains without masking anything.
    config.repo.listFiles = async () => ({ commitOid: "head-oid", paths: [] });
    config.repo.readFile = async () => null;
    const healed = await core.gitStatus();
    expect(healed.mounts[0]!.changes).toEqual([]);
    // The whiteout is gone durably: a repo re-add of the path is visible.
    config.repo.listFiles = async () => ({ commitOid: "head-2", paths: ["only.md"] });
    config.repo.readFile = async ({ path }) =>
      path === "only.md" ? { commitOid: "head-2", content: "re-added", path } : null;
    await expect(core.readFile("/config/only.md")).resolves.toBe("re-added");
  });
});

describe("thermo round-three regressions", () => {
  test("a file tombstone can NEVER mask a repo mounted beneath that path", async () => {
    const config = fakeRepo({ vendor: "a file named vendor", "worker.ts": "x" });
    const vendorRepo = fakeRepo({ "readme.md": "vendor repo truth" });
    const { workspace } = fakeLocalLayer();
    const table: Record<string, WorkspaceMount> = {
      "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
    };
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => table,
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : vendorRepo.repo),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    // Delete the FILE /repos/config/vendor from the outer repo...
    await expect(core.deleteFile("/repos/config/vendor")).resolves.toBe(true);
    // ...then mount a repo at that path. Its files must be fully visible —
    // the file tombstone is exact-match, never recursive.
    table["/repos/config/vendor"] = { policy: "read-only", repoPath: "/repos/vendor" };
    await expect(core.readFile("/repos/config/vendor/readme.md")).resolves.toBe(
      "vendor repo truth",
    );
    const status = await core.gitStatus();
    const vendorMount = status.mounts.find((mount) => mount.path === "/repos/config/vendor")!;
    expect(vendorMount.changes).toEqual([]);
    // And a scoped commit of the nested mount has nothing to delete.
    await expect(
      core.gitCommit({ message: "nope", scope: "/repos/config/vendor" }),
    ).rejects.toThrow(/read-only|Nothing to commit/);
  });

  test("a failed LOCAL delete leaves no whiteout behind", async () => {
    const config = fakeRepo({ "worker.ts": "repo version" });
    const { workspace } = fakeLocalLayer();
    const failing = {
      ...workspace,
      deleteFile: async () => {
        throw new Error("injected local storage failure");
      },
    } as unknown as typeof workspace;
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } }),
      repo: () => config.repo,
      scratchRoot: SCRATCH_ROOT,
      workspace: failing,
    });
    await expect(core.deleteFile("/config/worker.ts")).rejects.toThrow(/injected local/);
    // The mount file is still visible — no orphaned whiteout hides it.
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("repo version");
  });
});

describe("thermo round-four regressions", () => {
  test("a mount point EXISTS even when an old file tombstone sits at its path", async () => {
    const config = fakeRepo({ vendor: "was a file", "worker.ts": "x" });
    const vendorRepo = fakeRepo({ "readme.md": "vendor" });
    const { workspace } = fakeLocalLayer();
    const table: Record<string, WorkspaceMount> = {
      "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
    };
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => table,
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : vendorRepo.repo),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await core.deleteFile("/repos/config/vendor");
    table["/repos/config/vendor"] = { policy: "read-only", repoPath: "/repos/vendor" };
    await expect(core.exists("/repos/config/vendor")).resolves.toBe(true);
    await expect(core.exists("/repos/config/vendor/readme.md")).resolves.toBe(true);
  });

  test("writes are rejected at a mount's virtual ANCESTORS — and at unmounted siblings of them", async () => {
    const nested = fakeRepo({ "note.md": "y" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/repos/nested": { policy: "read-only", repoPath: "/repos/nested" },
      }),
      repo: () => nested.repo,
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    await expect(core.writeFile("/repos", "not a file")).rejects.toThrow(/mount point/);
    await expect(core.writeFile("/repos/nested", "not a file")).rejects.toThrow(/mount point/);
    // Under STRICT writes the ancestor's sibling is not implicitly writable
    // scratch: it is unmounted and outside the workspace's own directory.
    await expect(core.writeFile("/repos/c.md", "stray")).rejects.toThrow(/not writable/);
  });

  test("mount transitions over dirty overlay state are rejected; clean ones pass", async () => {
    const { core } = subject();
    const current: Record<string, WorkspaceMount> = {
      "/config": { policy: "commit-to-main", repoPath: "/repos/config" },
      "/iterate": { policy: "read-only", repoPath: "/repos/iterate" },
    };
    await core.writeFile("/iterate/notes.md", "dirty");
    // Swapping the dirty mount's repo, or unmounting it, would adopt the
    // dirty file into another owner — rejected.
    await expect(
      core.assertMountTransitionSafe(current, {
        ...current,
        "/iterate": { policy: "read-only", repoPath: "/repos/other" },
      }),
    ).rejects.toThrow(/uncommitted work/);
    const withoutIterate = { "/config": current["/config"]! };
    await expect(core.assertMountTransitionSafe(current, withoutIterate)).rejects.toThrow(
      /uncommitted work/,
    );
    // Changing only the POLICY moves nothing; adding an unrelated mount is fine.
    await expect(
      core.assertMountTransitionSafe(current, {
        ...current,
        "/iterate": { policy: "commit-to-main", repoPath: "/repos/iterate" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      core.assertMountTransitionSafe(current, {
        ...current,
        "/docs": { policy: "read-only", repoPath: "/repos/docs" },
      }),
    ).resolves.toBeUndefined();
    // A new mount colliding with a local FILE is rejected: the scratch file
    // sits on an ancestor segment of the proposed mount point.
    await core.writeFile(`${SCRATCH_ROOT}/notes.md`, "scratch");
    await expect(
      core.assertMountTransitionSafe(current, {
        ...current,
        [`${SCRATCH_ROOT}/notes.md/vendor`]: { policy: "read-only", repoPath: "/repos/docs" },
      }),
    ).rejects.toThrow(/collides with the local FILE/);
    // A mount AT the dirty file's own path re-routes it instead.
    await expect(
      core.assertMountTransitionSafe(current, {
        ...current,
        [`${SCRATCH_ROOT}/notes.md`]: { policy: "read-only", repoPath: "/repos/docs" },
      }),
    ).rejects.toThrow(/uncommitted work/);
  });
});

describe("post-merge follow-ups (Bugbot round)", () => {
  test("a `.gitignore` inside a mounted repo subtree still filters commits", async () => {
    const { config, core } = subject();
    await core.writeFile("/config/.gitignore", "*.log\n");
    await core.writeFile("/config/debug.log", "noise");
    await core.writeFile("/config/keep.ts", "kept");
    const result = await core.gitCommit({ message: "filtered", scope: "/config" });
    expect(result.changedPaths).toEqual(["/config/.gitignore", "/config/keep.ts"]);
    expect(config.commits[0]).toEqual({
      changes: [
        { content: "*.log\n", path: ".gitignore" },
        { content: "kept", path: "keep.ts" },
      ],
      message: "filtered",
    });
    // The ignored file was not consumed by the commit — it stays local.
    await expect(core.readFile("/config/debug.log")).resolves.toBe("noise");
  });

  test(".gitignored files never nominate a mount for scope-less commit inference", async () => {
    const { core } = subject();
    // A generated dir with a "*" .gitignore under one mount, a real change
    // under the other. Scope-less commit must infer the single genuinely
    // dirty mount instead of rejecting with a span error.
    await core.writeFile("/config/generated/.gitignore", "*\n");
    await core.writeFile("/config/generated/huge.json", "{}");
    await core.writeFile("/iterate/notes.md", "dirty");
    await expect(core.gitCommit({ message: "should not span" })).rejects.toThrow(/read-only/);
    // (the /iterate mount is read-only in the fixture — the inference chose
    // it alone; a span error would have fired first otherwise)
  });

  test("edit() refuses mount points and their virtual ancestors", async () => {
    const config = fakeRepo({ a: "a file named a", "worker.ts": "x" });
    const nested = fakeRepo({ "note.md": "y" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/repos/config/a/b": { policy: "read-only", repoPath: "/repos/nested" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : nested.repo),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    // "/repos/config/a" exists as a repo FILE in the outer mount but is also
    // a virtual ancestor of the nested mount — editing it would materialize
    // the collision.
    await expect(
      core.edit({ path: "/repos/config/a", oldString: "a file", newString: "boom" }),
    ).rejects.toThrow(/mount point/);
  });
});

describe("virtual directory coherence", () => {
  // The round-five repro: the outer repo has a FILE at "/repos/config/a"
  // while a nested mount sits at "/repos/config/a/b". The merged view must
  // treat "/repos/config/a" as a DIRECTORY everywhere — never simultaneously
  // a file and the parent of a mount.
  function nestedCollisionCore(
    configTree: Record<string, string> = { a: "a file named a", "worker.ts": "x" },
  ) {
    const config = fakeRepo(configTree);
    const nested = fakeRepo({ "note.md": "y" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/repos/config/a/b": { policy: "read-only", repoPath: "/repos/nested" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : nested.repo),
      scratchRoot: SCRATCH_ROOT,
      workspace,
    });
    return { config, core, nested };
  }

  test("reads mask an outer repo file at a virtual ancestor", async () => {
    const { core } = nestedCollisionCore();
    expect(await core.readFile("/repos/config/a")).toBeNull();
    expect(await core.readFileBytes("/repos/config/a")).toBeNull();
    // The nested mount's contents still read through untouched.
    expect(await core.readFile("/repos/config/a/b/note.md")).toBe("y");
  });

  test("exists() reports virtual ancestors as directories — even with no outer file there", async () => {
    const { core } = nestedCollisionCore();
    expect(await core.exists("/repos/config/a")).toBe(true);
    // Same table, but the outer repo has NOTHING at the ancestor path: the
    // mounted subtree alone implies the directory chain.
    const bare = nestedCollisionCore({ "worker.ts": "x" });
    expect(await bare.core.exists("/repos/config/a")).toBe(true);
  });

  test("listing masks the outer file at a virtual ancestor", async () => {
    const { core } = nestedCollisionCore();
    expect(await core.listAllFiles()).toEqual([
      "/repos/config/a/b/note.md",
      "/repos/config/worker.ts",
    ]);
    expect(
      (await core.listAllFiles()).filter((path) => minimatch(path, "/**", { dot: true })),
    ).toEqual(["/repos/config/a/b/note.md", "/repos/config/worker.ts"]);
  });

  test("deleteFile() refuses virtual ancestors and installs no whiteout", async () => {
    const { core } = nestedCollisionCore();
    await expect(core.deleteFile("/repos/config/a")).rejects.toThrow(/mount point/);
    expect(await core.exists("/repos/config/a")).toBe(true);
    expect(await core.readFile("/repos/config/a/b/note.md")).toBe("y");
    const status = await core.gitStatus();
    const outer = status.mounts.find((mount) => mount.path === "/repos/config")!;
    expect(outer.changes).toEqual([]);
  });

  test("deleteFile() at an exact mount point throws instead of no-op'ing", async () => {
    const { core } = nestedCollisionCore();
    await expect(core.deleteFile("/repos/config/a/b")).rejects.toThrow(/mount point/);
  });
});

describe("delete whiteout surface", () => {
  test("isMaskedFromMount is the batched-reader truth: set by delete, cleared by rewrite", async () => {
    const { core } = subject();
    expect(core.isMaskedFromMount("/config/worker.ts")).toBe(false);
    await core.deleteFile("/config/worker.ts");
    expect(core.isMaskedFromMount("/config/worker.ts")).toBe(true);
    expect(core.isMaskedFromMount("config/worker.ts")).toBe(true); // canonicalized
    await core.writeFile("/config/worker.ts", "fresh");
    expect(core.isMaskedFromMount("/config/worker.ts")).toBe(false);
  });
});

describe("reRoutedPaths", () => {
  const base: Record<string, WorkspaceMount> = {
    "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
  };
  test("adding a nested mount re-routes exactly the stolen paths", () => {
    const after = {
      ...base,
      "/repos/config/sub": { policy: "commit-to-main" as const, repoPath: "/repos/other" },
    };
    expect(
      reRoutedPaths(base, after, ["/repos/config/sub/tasks/a.md", "/repos/config/tasks/b.md"]),
    ).toEqual(["/repos/config/sub/tasks/a.md"]);
  });
  test("re-pointing a mount re-routes its paths; removal re-routes to the parent", () => {
    const after: Record<string, WorkspaceMount> = {
      "/repos/config": { policy: "commit-to-main", repoPath: "/repos/swapped" },
    };
    expect(reRoutedPaths(base, after, ["/repos/config/tasks/b.md"])).toEqual([
      "/repos/config/tasks/b.md",
    ]);
    const nested = {
      ...base,
      "/repos/config/sub": { policy: "commit-to-main" as const, repoPath: "/repos/other" },
    };
    expect(reRoutedPaths(nested, base, ["/repos/config/sub/tasks/a.md"])).toEqual([
      "/repos/config/sub/tasks/a.md",
    ]);
  });
  test("an unchanged nested mount survives sibling changes", () => {
    const before = {
      ...base,
      "/repos/config/keep": { policy: "read-only" as const, repoPath: "/repos/keep" },
    };
    const after = {
      "/repos/config": { policy: "commit-to-main" as const, repoPath: "/repos/swapped" },
      "/repos/config/keep": { policy: "read-only" as const, repoPath: "/repos/keep" },
    };
    expect(reRoutedPaths(before, after, ["/repos/config/keep/x.md", "/repos/config/y.md"])).toEqual(
      ["/repos/config/y.md"],
    );
  });
});
