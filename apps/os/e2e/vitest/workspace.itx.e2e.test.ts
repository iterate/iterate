import { describe, expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

describe("itx workspaces", () => {
  test("a workspace clones the project repo, edits privately, and pushes its own branch", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({ slug: `workspace-${crypto.randomUUID()}` });

    // The workspace clones from the project repo, which seeds asynchronously
    // after project creation — wait for the seed so the clone has a source.
    // readFile THROWS (not null) until the repo artifact exists, so swallow
    // errors while polling; cold slots can take a while to seed.
    await waitForCondition(
      async () => {
        const read = await project.repo.readFile({ path: "package.json" }).catch(() => null);
        return read !== null;
      },
      { description: "project repo to be seeded", intervalMs: 1_000, timeoutMs: 60_000 },
    );

    const workspacePath = `/workspaces/agents/e2e-${crypto.randomUUID()}`;
    using workspace = project.workspaces.get(workspacePath);

    // Reads block until the clone completes; content proves it is the
    // project repo checkout, .git proves it is a real git working tree.
    const seededPackageJson = await workspace.readFile("/package.json");
    expect(seededPackageJson).not.toBeNull();
    expect(await workspace.exists("/.git")).toBe(true);
    const rootEntries = await workspace.readDir("/");
    expect(rootEntries.map((entry) => entry.name)).toContain("worker.ts");

    // Write + exact-string edit are workspace-local (working tree only).
    await workspace.writeFile("/notes/e2e.md", "workspace hello");
    const edited = await workspace.edit({
      path: "/notes/e2e.md",
      oldString: "hello",
      newString: "hello world",
    });
    expect(edited).toEqual({ occurrenceCount: 1, path: "/notes/e2e.md" });
    expect(await workspace.readFile("/notes/e2e.md")).toBe("workspace hello world");
    // The seeded repo is untouched by workspace writes until a push.
    expect(await project.repo.readFile({ path: "notes/e2e.md" })).toBeNull();

    // .git is readable but platform-managed: writes are rejected (this is
    // also what keeps push credentials pinned to the clone-time remote).
    await expect(workspace.writeFile("/.git/config", "[remote]")).rejects.toThrow(/not writable/);
    await expect(workspace.rm("/", { recursive: true })).rejects.toThrow(/not writable/);

    // Ordinary git flow publishes to the workspace's own branch.
    const status = await workspace.git.status();
    expect(status.map((entry) => entry.filepath)).toContain("notes/e2e.md");
    await workspace.git.add({ filepath: "." });
    const commit = await workspace.git.commit({ message: "e2e workspace commit" });
    expect(commit.oid).toMatch(/^[0-9a-f]{40}$/);
    const pushed = await workspace.git.push();
    expect(pushed).toEqual({ branch: workspacePath.slice(1), ok: true });
    const [head] = await workspace.git.log({ depth: 1 });
    expect(head?.oid).toBe(commit.oid);

    // The push went to the workspace branch, not main.
    expect(await project.repo.readFile({ path: "notes/e2e.md" })).toBeNull();

    // A second workspace is a fully independent checkout.
    using other = project.workspaces.get(`/workspaces/agents/e2e-${crypto.randomUUID()}`);
    expect(await other.readFile("/notes/e2e.md")).toBeNull();
  });
});
