import { describe, expect, test } from "vitest";
import type { Workspace } from "@cloudflare/shell";
import type { WorkspaceMount } from "./workspace-processor-contract.ts";
import { WorkspaceCore, type MountRepoAccess } from "./workspace-core.ts";

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
  const commits: { changes: unknown[]; message: string }[] = [];
  const commandReceipts = new Map<
    string,
    { input: string; result: Awaited<ReturnType<MountRepoAccess["commitFiles"]>> }
  >();
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
    commitFiles: async (input) => {
      commits.push({ changes: input.changes, message: input.message });
      for (const change of input.changes) {
        if ("delete" in change && change.delete) delete tree[change.path];
        else if ("content" in change) tree[change.path] = change.content;
        else if ("contentBase64" in change) tree[change.path] = atob(change.contentBase64);
      }
      return {
        branch: "main",
        changedPaths: input.changes.map((change) => change.path),
        commitOid: `commit-${commits.length}`,
        noChanges: input.changes.length === 0,
      };
    },
    commitFilesCommand: async (command) => {
      const serialized = JSON.stringify(command.input);
      const existing = commandReceipts.get(command.operationId);
      if (existing !== undefined) {
        if (existing.input !== serialized) throw new Error("fake command input conflict");
        return existing.result;
      }
      const result = await repo.commitFiles(command.input);
      commandReceipts.set(command.operationId, { input: serialized, result });
      return result;
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
  return { commits, repo };
}

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
    workspace,
  });
  return { config, core, iterate, localFiles: files };
}

function interruptedCommitSubject() {
  const config = fakeRepo({ "worker.ts": "export default {}" });
  const { files, workspace } = fakeLocalLayer();
  const kv = fakeKv();
  let interruptCleanup = true;
  const interruptedWorkspace = {
    ...workspace,
    rm: async (path: string, options: { force?: boolean; recursive?: boolean }) => {
      if (interruptCleanup) {
        interruptCleanup = false;
        throw new Error("injected reset before workspace cleanup");
      }
      return await workspace.rm(path, options);
    },
  } as Workspace;
  const options = {
    kv,
    mounts: async () => ({
      "/config": { policy: "commit-to-main" as const, repoPath: "/repos/config" },
    }),
    repo: () => config.repo,
  };
  return {
    config,
    files,
    interrupted: new WorkspaceCore({ ...options, workspace: interruptedWorkspace }),
    recovered: new WorkspaceCore({ ...options, workspace }),
  };
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
    await core.writeFile("/scratch/notes.txt", "hi");
    await expect(core.listAllFiles()).resolves.toEqual([
      "/config/tasks/one.md",
      "/config/worker.ts",
      "/iterate/README.md",
      "/iterate/tasks/two.md",
      "/scratch/notes.txt",
    ]);
    await expect(core.glob("**/tasks/**/*.md")).resolves.toEqual([
      "/config/tasks/one.md",
      "/iterate/tasks/two.md",
    ]);
  });

  test("readFileBytes decodes the mount's base64 lane", async () => {
    const { core } = subject();
    const bytes = await core.readFileBytes("/iterate/README.md");
    expect(new TextDecoder().decode(bytes!)).toBe("# iterate");
  });
});

describe("git status, commit, and log", () => {
  test("status groups changes by owning mount, plus unmounted scratch", async () => {
    const { core } = subject();
    await core.writeFile("/config/worker.ts", "changed");
    await core.writeFile("/config/new.ts", "new");
    await core.deleteFile("/iterate/README.md");
    await core.writeFile("/scratch/notes.txt", "hi");

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
      unmounted: [{ change: "added", path: "/scratch/notes.txt" }],
    });
  });

  test("commit routes one mount's changes to its repo and clears only that subtree", async () => {
    const { config, core } = subject();
    await core.writeFile("/config/worker.ts", "changed");
    await core.deleteFile("/config/tasks/one.md");
    await core.writeFile("/scratch/notes.txt", "survives");

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
    await expect(core.readFile("/scratch/notes.txt")).resolves.toBe("survives");
    const statusAfter = await core.gitStatus();
    expect(statusAfter.mounts.find((mount) => mount.path === "/config")?.changes).toEqual([]);
  });

  test("replays a completed repo mutation and finishes workspace cleanup after a reset", async () => {
    const { config, files, interrupted, recovered } = interruptedCommitSubject();
    const command = {
      input: { message: "update worker" },
      operationId: "4035f424-72d9-4515-a05b-2fd6d662a021",
    };
    await interrupted.writeFile("/config/worker.ts", "changed");

    await expect(interrupted.gitCommitCommand(command)).rejects.toThrow(/injected reset/);
    expect(config.commits).toHaveLength(1);
    expect(files.has("/config/worker.ts")).toBe(true);

    await expect(recovered.gitCommitCommand(command)).resolves.toMatchObject({
      changedPaths: ["/config/worker.ts"],
      commitOid: "commit-1",
    });
    expect(config.commits).toHaveLength(1);
    expect(files.has("/config/worker.ts")).toBe(false);
  });

  test("replays a completed workspace result without consuming a later edit", async () => {
    const { config, core } = subject();
    const command = {
      input: { message: "update worker" },
      operationId: "92df645d-0a83-41e2-a249-11f2927068fc",
    };
    await core.writeFile("/config/worker.ts", "changed");
    const first = await core.gitCommitCommand(command);

    // Simulate a lost edge acknowledgement followed by unrelated later work
    // before the transport replays the original command.
    await core.writeFile("/config/worker.ts", "later edit");
    await expect(core.gitCommitCommand(command)).resolves.toEqual(first);
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("later edit");
    expect(config.commits).toHaveLength(1);
  });

  test("refuses recovery when the workspace changed after the repo commit", async () => {
    const { config, interrupted, recovered } = interruptedCommitSubject();
    const command = {
      input: { message: "update worker" },
      operationId: "1d205ee9-e117-468b-9d92-5111e357dabc",
    };
    await interrupted.writeFile("/config/worker.ts", "changed");
    await expect(interrupted.gitCommitCommand(command)).rejects.toThrow(/injected reset/);

    await recovered.writeFile("/config/worker.ts", "later edit");
    await expect(recovered.gitCommitCommand(command)).rejects.toThrow(/recovery conflict/);
    await expect(recovered.readFile("/config/worker.ts")).resolves.toBe("later edit");
    expect(config.commits).toHaveLength(1);
  });

  test("rejects workspace operation-id reuse with different input", async () => {
    const { config, core } = subject();
    const operationId = "b222b4c7-c0bf-4780-b08d-811cd9160e10";
    await core.writeFile("/config/worker.ts", "changed");
    await core.gitCommitCommand({ input: { message: "first" }, operationId });

    await expect(
      core.gitCommitCommand({ input: { message: "different" }, operationId }),
    ).rejects.toThrow(/replayed with different input/);
    expect(config.commits).toHaveLength(1);
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
    const single = subject({ "/": { policy: "commit-to-main", repoPath: "/repos/config" } });
    await expect(single.core.gitLog()).resolves.toMatchObject([{ oid: "head-oid" }]);

    const { core } = subject();
    await expect(core.gitLog()).rejects.toThrow(/log needs \{ scope \}/);
    await expect(core.gitLog({ scope: "/iterate" })).resolves.toMatchObject([
      { message: "head of 2-file repo" },
    ]);
  });
});

describe("nested mounts", () => {
  test('a "/" mount is shadowed by deeper mounts, for reads, listing, and status alike', async () => {
    const nested: Record<string, WorkspaceMount> = {
      "/": { policy: "commit-to-main", repoPath: "/repos/config" },
      "/tasks": { policy: "read-only", repoPath: "/repos/iterate" },
    };
    const { core } = subject(nested);
    // "/tasks/**" belongs to the deeper mount (the iterate repo appears at
    // "/tasks/…"), so the config repo's tasks/one.md is unreachable and
    // worker.ts routes to "/".
    await expect(core.readFile("/worker.ts")).resolves.toBe("export default {}");
    await expect(core.readFile("/tasks/one.md")).resolves.toBeNull();
    await expect(core.readFile("/tasks/README.md")).resolves.toBe("# iterate");

    // The shadowed config file appears in NO listing: not at its own path
    // (the deeper mount owns it) and not as a deletion.
    await expect(core.listAllFiles()).resolves.toEqual([
      "/tasks/README.md",
      "/tasks/tasks/two.md",
      "/worker.ts",
    ]);

    // Deleting the shadowed path is a no-op delete (nothing visible there).
    await expect(core.deleteFile("/tasks/one.md")).resolves.toBe(false);

    const status = await core.gitStatus();
    const root = status.mounts.find((mount) => mount.path === "/")!;
    expect(root.changes).toEqual([]);
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
      workspace,
    });
    failProbe = true;
    await expect(core.deleteFile("/config/worker.ts")).rejects.toThrow(/injected repo outage/);
    failProbe = false;
    // The failed delete changed nothing durable: the file still reads.
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("export default {}");
  });

  test('committing "/" preserves a deeper mount\'s pending deletion', async () => {
    const nested: Record<string, WorkspaceMount> = {
      "/": { policy: "commit-to-main", repoPath: "/repos/config" },
      "/side": { policy: "commit-to-main", repoPath: "/repos/iterate" },
    };
    const config = fakeRepo({ "worker.ts": "export default {}" });
    const iterate = fakeRepo({ "note.md": "side truth" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => nested,
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : iterate.repo),
      workspace,
    });
    await core.deleteFile("/side/note.md");
    await core.writeFile("/root-change.md", "x");
    const committed = await core.gitCommit({ message: "root only", scope: "/" });
    expect(committed).toMatchObject({ changedPaths: ["/root-change.md"], mount: "/" });
    // The deeper mount's deletion is still pending, not silently consumed.
    await expect(core.readFile("/side/note.md")).resolves.toBeNull();
    const status = await core.gitStatus();
    expect(status.mounts.find((mount) => mount.path === "/side")?.changes).toEqual([
      { change: "deleted", path: "/side/note.md" },
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
      workspace,
    });
    await core.writeFile("/config/a.md", "a");
    await core.gitCommit({ message: "scoped", scope: "/config" });
    expect(iterateListings).toBe(0);
  });

  test("commit heals a stale whiteout (crash residue) instead of wedging on it", async () => {
    const { core } = subject();
    // Simulate the crash residue: delete a mount file, then the "repo write
    // landed but cleanup died" state — the repo no longer has the file while
    // the whiteout remains.
    const config = fakeRepo({ "only.md": "x" });
    const { workspace } = fakeLocalLayer();
    const kv = fakeKv();
    const crashCore = new WorkspaceCore({
      kv,
      mounts: async () => ({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } }),
      repo: () => config.repo,
      workspace,
    });
    await crashCore.deleteFile("/config/only.md");
    // "crash": the repo applies the deletion out-of-band; the whiteout stays.
    delete (config as { tree?: unknown }).tree;
    config.repo.listFiles = async () => ({ commitOid: "head-oid", paths: [] });
    config.repo.readFile = async () => null;
    // A retry commit finds nothing real to commit — and says so cleanly
    // (the stale whiteout is healed rather than nominating changes forever).
    await expect(crashCore.gitCommit({ message: "retry" })).rejects.toThrow(/Nothing to commit/);
    const status = await crashCore.gitStatus();
    expect(status.mounts[0]!.changes).toEqual([]);
    void core;
  });

  test("`.gitignore` rules do not cross mount boundaries", async () => {
    const config = fakeRepo({ "worker.ts": "export default {}" });
    const iterate = fakeRepo({ "README.md": "# iterate" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/side": { policy: "commit-to-main", repoPath: "/repos/iterate" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : iterate.repo),
      workspace,
    });
    // A ROOT-mount .gitignore suppressing *.log must not hide the side
    // mount's local log file from ITS commit.
    await core.writeFile("/.gitignore", "*.log\n");
    await core.writeFile("/root.log", "suppressed");
    await core.writeFile("/side/kept.log", "kept");
    const status = await core.gitStatus();
    const root = status.mounts.find((mount) => mount.path === "/")!;
    const side = status.mounts.find((mount) => mount.path === "/side")!;
    expect(root.changes.map((change) => change.path)).not.toContain("/root.log");
    expect(side.changes.map((change) => change.path)).toContain("/side/kept.log");
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
    // The "/" mount point stays covered by the root guard.
    await expect(core.writeFile("/", "nope")).rejects.toThrow(/not writable/);
  });

  test("STATUS heals a stale whiteout — no commit attempt required", async () => {
    const config = fakeRepo({ "only.md": "x" });
    const { workspace } = fakeLocalLayer();
    const kv = fakeKv();
    const core = new WorkspaceCore({
      kv,
      mounts: async () => ({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } }),
      repo: () => config.repo,
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
      "/": { policy: "commit-to-main", repoPath: "/repos/config" },
    };
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => table,
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : vendorRepo.repo),
      workspace,
    });
    // Delete the FILE /vendor from the root repo...
    await expect(core.deleteFile("/vendor")).resolves.toBe(true);
    // ...then mount a repo at /vendor. Its files must be fully visible —
    // the file tombstone is exact-match, never recursive.
    table["/vendor"] = { policy: "read-only", repoPath: "/repos/vendor" };
    await expect(core.readFile("/vendor/readme.md")).resolves.toBe("vendor repo truth");
    const status = await core.gitStatus();
    const vendorMount = status.mounts.find((mount) => mount.path === "/vendor")!;
    expect(vendorMount.changes).toEqual([]);
    // And a scoped commit of /vendor has nothing to delete.
    await expect(core.gitCommit({ message: "nope", scope: "/vendor" })).rejects.toThrow(
      /read-only|Nothing to commit/,
    );
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
      "/": { policy: "commit-to-main", repoPath: "/repos/config" },
    };
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => table,
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : vendorRepo.repo),
      workspace,
    });
    await core.deleteFile("/vendor");
    table["/vendor"] = { policy: "read-only", repoPath: "/repos/vendor" };
    await expect(core.exists("/vendor")).resolves.toBe(true);
    await expect(core.exists("/vendor/readme.md")).resolves.toBe(true);
  });

  test("writes are rejected at a mount's virtual ANCESTOR directories", async () => {
    const config = fakeRepo({ "worker.ts": "x" });
    const nested = fakeRepo({ "note.md": "y" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/a/b": { policy: "read-only", repoPath: "/repos/nested" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : nested.repo),
      workspace,
    });
    await expect(core.writeFile("/a", "not a file")).rejects.toThrow(/mount point/);
    await expect(core.writeFile("/a/b", "not a file")).rejects.toThrow(/mount point/);
    await expect(core.writeFile("/a/c.md", "fine")).resolves.toBeUndefined();
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
    // A new mount colliding with a local FILE is rejected.
    await core.writeFile("/notes.md", "scratchless");
    await expect(
      core.assertMountTransitionSafe(current, {
        ...current,
        "/notes.md": { policy: "read-only", repoPath: "/repos/docs" },
      }),
    ).rejects.toThrow(/collides with the local FILE|uncommitted work/);
  });
});

describe("post-merge follow-ups (Bugbot round)", () => {
  test("a second created event is SKIPPED by the fold, and .gitignored spill files never fabricate span errors", async () => {
    const { core } = subject();
    // Agent-shaped overlay: a spill dir with a "*" .gitignore under one
    // mount, a real change under the other. Scope-less commit must infer the
    // single genuinely dirty mount instead of rejecting with a span error.
    await core.writeFile("/config/script-results/.gitignore", "*\n");
    await core.writeFile("/config/script-results/huge.json", "{}");
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
        "/": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/a/b": { policy: "read-only", repoPath: "/repos/nested" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : nested.repo),
      workspace,
    });
    // "/a" exists as a repo FILE in the root mount but is also a virtual
    // ancestor of the /a/b mount — editing it would materialize the collision.
    await expect(core.edit({ path: "/a", oldString: "a file", newString: "boom" })).rejects.toThrow(
      /mount point/,
    );
  });
});

describe("virtual directory coherence", () => {
  // The round-five repro: the outer repo has a FILE at "/a" while a nested
  // mount sits at "/a/b". The merged view must treat "/a" as a DIRECTORY
  // everywhere — never simultaneously a file and the parent of a mount.
  function nestedCollisionCore(
    configTree: Record<string, string> = { a: "a file named a", "worker.ts": "x" },
  ) {
    const config = fakeRepo(configTree);
    const nested = fakeRepo({ "note.md": "y" });
    const { workspace } = fakeLocalLayer();
    const core = new WorkspaceCore({
      kv: fakeKv(),
      mounts: async () => ({
        "/": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/a/b": { policy: "read-only", repoPath: "/repos/nested" },
      }),
      repo: (repoPath) => (repoPath === "/repos/config" ? config.repo : nested.repo),
      workspace,
    });
    return { config, core, nested };
  }

  test("reads mask an outer repo file at a virtual ancestor", async () => {
    const { core } = nestedCollisionCore();
    expect(await core.readFile("/a")).toBeNull();
    expect(await core.readFileBytes("/a")).toBeNull();
    // The nested mount's contents still read through untouched.
    expect(await core.readFile("/a/b/note.md")).toBe("y");
  });

  test("exists() reports virtual ancestors as directories — even with no outer file there", async () => {
    const { core } = nestedCollisionCore();
    expect(await core.exists("/a")).toBe(true);
    // Same table, but the outer repo has NOTHING at the ancestor path: the
    // mounted subtree alone implies the directory chain.
    const bare = nestedCollisionCore({ "worker.ts": "x" });
    expect(await bare.core.exists("/a")).toBe(true);
  });

  test("listing masks the outer file at a virtual ancestor", async () => {
    const { core } = nestedCollisionCore();
    expect(await core.listAllFiles()).toEqual(["/a/b/note.md", "/worker.ts"]);
    expect(await core.glob("/**")).toEqual(["/a/b/note.md", "/worker.ts"]);
  });

  test("deleteFile() refuses virtual ancestors and installs no whiteout", async () => {
    const { core } = nestedCollisionCore();
    await expect(core.deleteFile("/a")).rejects.toThrow(/mount point/);
    expect(await core.exists("/a")).toBe(true);
    expect(await core.readFile("/a/b/note.md")).toBe("y");
    const status = await core.gitStatus();
    const root = status.mounts.find((mount) => mount.path === "/")!;
    expect(root.changes).toEqual([]);
  });

  test("deleteFile() at an exact mount point throws instead of no-op'ing", async () => {
    const { core } = nestedCollisionCore();
    await expect(core.deleteFile("/a/b")).rejects.toThrow(/mount point/);
  });
});
