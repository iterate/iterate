import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { describe, expect, test } from "vitest";
import {
  CommitRepoFilesInput,
  REPO_COMMIT_AUTHOR,
  RepoFileChange,
  applyRepoFileChanges,
  isMissingRemoteRefError,
} from "./repo-git.ts";

const REPO_DIR = "/repo";

async function seedLocalRepo(initialFiles: Record<string, string>) {
  const filesystem = new InMemoryFs(
    Object.fromEntries(
      Object.entries(initialFiles).map(([path, content]) => [`${REPO_DIR}/${path}`, content]),
    ),
  );
  const git = createGit(filesystem, REPO_DIR);
  await git.init({ defaultBranch: "main" });
  for (const path of Object.keys(initialFiles)) {
    await git.add({ filepath: path });
  }
  await git.commit({ author: REPO_COMMIT_AUTHOR, message: "Seed" });
  return { filesystem, git };
}

describe("applyRepoFileChanges", () => {
  test("writes new and updated files and stages them", async () => {
    const { filesystem, git } = await seedLocalRepo({ "README.md": "# hello\n" });

    const changedPaths = await applyRepoFileChanges({
      changes: [
        { content: "# updated\n", path: "README.md" },
        { content: "console.log('hi');\n", path: "src/nested/index.ts" },
      ],
      filesystem,
      git,
    });

    expect(changedPaths).toEqual(["README.md", "src/nested/index.ts"]);
    expect(await filesystem.readFile(`${REPO_DIR}/README.md`)).toBe("# updated\n");
    expect(await filesystem.readFile(`${REPO_DIR}/src/nested/index.ts`)).toBe(
      "console.log('hi');\n",
    );

    await git.commit({ author: REPO_COMMIT_AUTHOR, message: "Update" });
    expect(await git.status()).toEqual([]);
  });

  test("serializes deletes as { path, delete: true }", async () => {
    const { filesystem, git } = await seedLocalRepo({
      "README.md": "# hello\n",
      "old.txt": "bye\n",
    });

    const changedPaths = await applyRepoFileChanges({
      changes: [{ delete: true, path: "old.txt" }],
      filesystem,
      git,
    });

    expect(changedPaths).toEqual(["old.txt"]);
    expect(await filesystem.exists(`${REPO_DIR}/old.txt`)).toBe(false);

    await git.commit({ author: REPO_COMMIT_AUTHOR, message: "Delete old.txt" });
    expect(await git.status()).toEqual([]);
    const [head] = await git.log({ depth: 1 });
    expect(head?.message).toContain("Delete old.txt");
  });

  test("writing identical content and deleting absent files is a no-op", async () => {
    const { filesystem, git } = await seedLocalRepo({ "README.md": "# hello\n" });

    const changedPaths = await applyRepoFileChanges({
      changes: [
        { content: "# hello\n", path: "README.md" },
        { delete: true, path: "does-not-exist.txt" },
      ],
      filesystem,
      git,
    });

    expect(changedPaths).toEqual([]);
  });

  test("writes base64 content as bytes", async () => {
    const { filesystem, git } = await seedLocalRepo({ "README.md": "# hello\n" });
    const bytes = new Uint8Array([0, 1, 2, 255]);

    const changedPaths = await applyRepoFileChanges({
      changes: [{ content: btoa(String.fromCharCode(...bytes)), encoding: "base64", path: "bin" }],
      filesystem,
      git,
    });

    expect(changedPaths).toEqual(["bin"]);
    expect(await filesystem.readFileBytes(`${REPO_DIR}/bin`)).toEqual(bytes);
  });
});

describe("checkout of a brand-new branch", () => {
  // The createMissingBranchFrom fallback in checkoutRepoBranch relies on the
  // shell git wrapper's checkout({ branch }) creating the branch at HEAD
  // (git.branch + git.checkout) even though no local or origin/ ref exists.
  test("wrapper checkout({branch}) creates and switches to the branch", async () => {
    const { filesystem, git } = await seedLocalRepo({ "README.md": "# hello\n" });

    const result = await git.checkout({ branch: "feature-x" });
    expect(result).toEqual({ branch: "feature-x", created: true });
    expect((await git.branch({})).current).toBe("feature-x");

    const changedPaths = await applyRepoFileChanges({
      changes: [{ content: "x\n", path: "new.txt" }],
      filesystem,
      git,
    });
    expect(changedPaths).toEqual(["new.txt"]);

    const commit = await git.commit({ author: REPO_COMMIT_AUTHOR, message: "On feature-x" });
    const log = await git.log({ depth: 2, ref: "feature-x" });
    expect(log[0]?.oid).toBe(commit.oid);
    expect(log[1]?.message).toContain("Seed");
  });
});

describe("RepoFileChange", () => {
  test("strips leading slashes from paths", () => {
    expect(RepoFileChange.parse({ content: "x", path: "/src/index.ts" })).toEqual({
      content: "x",
      path: "src/index.ts",
    });
  });

  test.each(["../escape.txt", ".git/config", "a/../b", ".", "//", ""])("rejects %j", (path) => {
    expect(() => RepoFileChange.parse({ content: "x", path })).toThrow();
  });

  test("rejects an entry carrying both content and delete", () => {
    expect(() => RepoFileChange.parse({ content: "x", delete: true, path: "a.txt" })).toThrow();
  });
});

describe("isMissingRemoteRefError", () => {
  test("matches isomorphic-git NotFoundError for the requested branch", () => {
    const error = Object.assign(new Error("Could not find feature-x."), {
      code: "NotFoundError",
    });
    expect(isMissingRemoteRefError(error, "feature-x")).toBe(true);
  });

  test("ignores NotFoundError about something other than the branch", () => {
    const error = Object.assign(new Error("Could not find deadbeef."), {
      code: "NotFoundError",
    });
    expect(isMissingRemoteRefError(error, "feature-x")).toBe(false);
  });

  test("ignores unrelated errors that happen to mention the branch", () => {
    expect(isMissingRemoteRefError(new Error("Could not find feature-x."), "feature-x")).toBe(
      false,
    );
    expect(isMissingRemoteRefError(new Error("HTTP Error: 500 on feature-x"), "feature-x")).toBe(
      false,
    );
  });
});

describe("CommitRepoFilesInput", () => {
  test("accepts mixed writes and deletes", () => {
    const parsed = CommitRepoFilesInput.parse({
      changes: [
        { content: "hello", path: "a.txt" },
        { delete: true, path: "b.txt" },
      ],
      message: "Update files",
    });
    expect(parsed.changes).toHaveLength(2);
    expect(parsed.branch).toBeUndefined();
  });

  test("requires at least one change and a message", () => {
    expect(() => CommitRepoFilesInput.parse({ changes: [], message: "x" })).toThrow();
    expect(() =>
      CommitRepoFilesInput.parse({ changes: [{ content: "x", path: "a" }], message: " " }),
    ).toThrow();
  });
});
