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

/** One fake repo: HEAD tree as a path→content map, commits recorded. */
function fakeRepo(tree: Record<string, string>) {
  const commits: { changes: unknown[]; message: string }[] = [];
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
      return {
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

    // The mount subtree cleared (worker.ts falls through to the repo again,
    // the whiteout is gone) while the unmounted scratch survives.
    await expect(core.readFile("/config/worker.ts")).resolves.toBe("export default {}");
    await expect(core.readFile("/config/tasks/one.md")).resolves.toBe("# one");
    await expect(core.readFile("/scratch/notes.txt")).resolves.toBe("survives");
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
