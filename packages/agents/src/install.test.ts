import { expect, test, vi } from "vitest";
import {
  agentsApp,
  agentsFolder,
  installedVersion,
  rootManifestListing,
  upgradeApp,
} from "./install.ts";

const name = "@iterate-com/agents";
const version = "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@abc1234";

test.for([
  [
    "a root without the package lists it among its devDependencies, in order",
    manifest({ private: true, devDependencies: { typescript: "^7.0.2", iterate: "x" } }),
    manifest({
      private: true,
      devDependencies: { "@iterate-com/agents": version, iterate: "x", typescript: "^7.0.2" },
    }),
  ],
  [
    "a root listing another version as a devDependency is moved to this one",
    manifest({ devDependencies: { "@iterate-com/agents": "old" } }),
    manifest({ devDependencies: { "@iterate-com/agents": version } }),
  ],
  [
    "a root that lists this version already is left as it is",
    manifest({ devDependencies: { "@iterate-com/agents": version } }),
    undefined,
  ],
  [
    "a root that depends on the package at runtime keeps its own pin",
    manifest({ dependencies: { "@iterate-com/agents": "https://pkg.pr.new/…@main" } }),
    undefined,
  ],
  [
    "a repo without a root package.json gets one",
    null,
    manifest({ devDependencies: { [name]: version } }),
  ],
] as const)("%s", ([, before, after]) => {
  expect(rootManifestListing(before, name, version)).toBe(after);
});

test("the agents folder names its main module in package.json", () => {
  const folder = agentsFolder(version);
  expect(JSON.parse(folder["package.json"]!)).toEqual({
    main: "index.ts",
    dependencies: { [name]: version },
  });
  expect(folder["index.ts"]).toContain("AgentDurableObject");
});

const older = "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@1111111";
const newer = "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@2222222";

test("an upgrade commits the folder at the new build and the root's listing on the tip it read, then installs that commit", async () => {
  const repo = configRepo({
    ...prefixed("agents/", agentsFolder(older)),
    "agents/notes.md": "the project's own file",
    "package.json": manifest({ devDependencies: { [name]: older } }),
  });
  const install = vi.fn(async (_source: Record<string, string>) => {});

  expect(await upgradeApp(repo.project, agentsApp, newer, install)).toBe("commit-1");
  expect(repo).toMatchObject({
    commits: [
      {
        message: `Upgrade ${name} to ${newer}`,
        parent: "seed",
        changedPaths: ["agents/package.json", "package.json"],
      },
    ],
    files: { "package.json": manifest({ devDependencies: { [name]: newer } }) },
  });
  // the folder at the new commit, the project's own file included
  expect(install).toHaveBeenCalledExactlyOnceWith({
    ...agentsFolder(newer),
    "notes.md": "the project's own file",
  });
});

test("an old entry under the folder is rewritten with the pin: it names the build's classes", async () => {
  const repo = configRepo({
    "agents/package.json": agentsFolder(older)["package.json"]!,
    "agents/index.ts":
      'export { AgentCollectionDurableObject, OldClass } from "@iterate-com/agents";\n',
  });
  await upgradeApp(repo.project, agentsApp, newer, async () => {});
  expect(repo).toMatchObject({
    commits: [{ changedPaths: ["agents/package.json", "agents/index.ts", "package.json"] }],
    files: { "agents/index.ts": agentsFolder(newer)["index.ts"] },
  });
});

test("a folder already at the build commits nothing and is installed again, which finishes a failed install", async () => {
  const repo = configRepo({
    ...prefixed("agents/", agentsFolder(newer)),
    "package.json": manifest({ devDependencies: { [name]: newer } }),
  });
  const install = vi.fn(async (_source: Record<string, string>) => {});
  expect(await upgradeApp(repo.project, agentsApp, newer, install)).toBe("seed");
  expect(repo).toMatchObject({ commits: [] });
  expect(install).toHaveBeenCalledExactlyOnceWith(agentsFolder(newer));
});

test("main moving after the read refuses the commit, and nothing is installed", async () => {
  const repo = configRepo(prefixed("agents/", agentsFolder(older)));
  repo.moveMainAfterRead();
  const install = vi.fn(async () => {});
  await expect(upgradeApp(repo.project, agentsApp, newer, install)).rejects.toThrow(
    "the commit was refused: main is at elsewhere, not at the parent it names (seed)",
  );
  expect(install).not.toHaveBeenCalled();
});

test("an install that fails after the commit says the new build is pinned and how to finish", async () => {
  const repo = configRepo(prefixed("agents/", agentsFolder(older)));
  const failure = new Error("esm.sh answered 502");
  const upgrade = upgradeApp(repo.project, agentsApp, newer, async () => {
    throw failure;
  });
  await expect(upgrade).rejects.toThrow(
    "agents/ pins the new build (config commit commit-), but installing it failed, so the project may still run the old one: esm.sh answered 502. Upgrade again to install it.",
  );
  await expect(upgrade).rejects.toMatchObject({ cause: failure });
  expect(repo.files["agents/package.json"]).toContain(newer);
});

test.for([
  ["an installed folder answers the version it pins", agentsFolder(newer), newer],
  ["a bundled source pins none", { "index.js": "export {}" }, undefined],
  ["a package.json that is not JSON pins none", { "package.json": "{" }, undefined],
  [
    "another package's pin is not this one",
    { "package.json": manifest({ dependencies: { hono: "^4" } }) },
    undefined,
  ],
] as const)("the installed version: %s", async ([, source, version]) => {
  const values: Record<string, string> = {
    "agents/runtime": JSON.stringify({ cacheKey: "abc", source }),
  };
  const kv = { get: async (key: string) => values[key] ?? null };
  expect(await installedVersion({ kv }, agentsApp)).toBe(version);
});

test("an app not installed has no installed version", async () => {
  expect(await installedVersion({ kv: { get: async () => null } }, agentsApp)).toBeUndefined();
});

/** An in-memory config repo whose commits land as the platform's do: `parent` must be the tip, and
 *  a commit that changes nothing answers the tip. */
function configRepo(initial: Record<string, string>) {
  const files = { ...initial };
  const commits: { message: string; parent?: string | null; changedPaths: string[] }[] = [];
  let tip = "seed";
  let movedAfterRead = false;
  const repo = {
    listFiles: async () => {
      const read = { commitOid: tip, paths: Object.keys(files) };
      if (movedAfterRead) tip = "elsewhere";
      return read;
    },
    readFile: async (path: string) => files[path] ?? null,
    commitFiles: async (input: {
      message: string;
      changes: { path: string; content?: string }[];
      parent?: string | null;
    }) => {
      if (input.parent !== tip)
        throw new Error(
          `repo /repos/config: the commit was refused: main is at ${tip}, not at the parent it names (${input.parent})`,
        );
      const changedPaths = input.changes
        .filter((change) => files[change.path] !== change.content)
        .map((change) => change.path);
      if (!changedPaths.length) return { commitOid: tip, changedPaths };
      for (const change of input.changes) files[change.path] = change.content!;
      commits.push({ message: input.message, parent: input.parent, changedPaths });
      tip = `commit-${commits.length}`;
      return { commitOid: tip, changedPaths };
    },
    modules: async ({ dir }: { dir?: string; commitOid?: string }) =>
      Object.fromEntries(
        Object.entries(files)
          .filter(([path]) => path.startsWith(`${dir}/`))
          .map(([path, content]) => [path.slice(dir!.length + 1), content]),
      ),
  };
  return {
    files,
    commits,
    moveMainAfterRead: () => void (movedAfterRead = true),
    project: { repos: { get: () => repo } },
  };
}

/** A folder's files at their paths under `dir`. */
function prefixed(dir: string, folder: Record<string, string>) {
  return Object.fromEntries(Object.entries(folder).map(([file, content]) => [dir + file, content]));
}

/** A package.json as a repo holds it. */
function manifest(json: object) {
  return `${JSON.stringify(json, null, 2)}\n`;
}
