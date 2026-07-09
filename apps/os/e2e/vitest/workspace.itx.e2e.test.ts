import { describe, expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

describe("itx workspaces", () => {
  test("the root workspace mirrors main; overlays fall through, shadow, delete, and publish", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({ slug: `workspace-${crypto.randomUUID()}` });

    // The root workspace materializes from the config repo, which seeds
    // asynchronously after project creation — wait for the seed so the
    // materialization has a source. readFile THROWS (not null) until the repo
    // artifact exists, so swallow errors while polling; cold slots can take a
    // while to seed.
    await waitForCondition(
      async () => {
        const read = await project.repo.readFile({ path: "package.json" }).catch(() => null);
        return read !== null;
      },
      { description: "config repo to be seeded", intervalMs: 1_000, timeoutMs: 60_000 },
    );

    // -- the root workspace: read-only, always latest main --------------------

    using root = project.workspaces.get("/");
    const rootPackageJson = await root.readFile("/package.json");
    expect(rootPackageJson).not.toBeNull();
    await expect(root.writeFile("/notes/nope.md", "x")).rejects.toThrow(/read-only/);

    const workspacePath = `/workspaces/agents/e2e-${crypto.randomUUID()}`;
    using workspace = project.workspaces.get(workspacePath);

    // -- fall-through reads: no clone, instantly the repo's latest main -------

    // A brand-new overlay reads main through the root without any clone;
    // content proves the fall-through, not a local copy.
    const seededPackageJson = await workspace.readFile("/package.json");
    expect(seededPackageJson).toBe(rootPackageJson);
    const rootEntries = await workspace.readDir("/");
    expect(rootEntries.map((entry) => entry.name)).toContain("worker.ts");
    // The parent's .git is platform plumbing — masked from overlays.
    expect(await workspace.exists("/.git")).toBe(false);
    expect(rootEntries.map((entry) => entry.name)).not.toContain(".git");

    // A commit to main is visible through the overlay immediately (the repo's
    // read-your-write boundary feeds the root's head check).
    await project.repo.commitFiles({
      message: "e2e: main moves under the overlay",
      changes: [{ path: "docs/freshness.md", content: "fresh off main" }],
    });
    expect(await workspace.readFile("/docs/freshness.md")).toBe("fresh off main");

    // -- local writes shadow; deletes whiteout -------------------------------

    // Write + exact-string edit are workspace-local (private overlay).
    await workspace.writeFile("/notes/e2e.md", "workspace hello");
    const edited = await workspace.edit({
      path: "/notes/e2e.md",
      oldString: "hello",
      newString: "hello world",
    });
    expect(edited).toEqual({ occurrenceCount: 1, path: "/notes/e2e.md" });
    expect(await workspace.readFile("/notes/e2e.md")).toBe("workspace hello world");
    // The seeded repo is untouched by workspace writes until a publish.
    expect(await project.repo.readFile({ path: "notes/e2e.md" })).toBeNull();

    // Editing a fallen-through file copies it up: private to this overlay.
    await workspace.appendFile("/docs/freshness.md", " + overlay addendum");
    expect(await workspace.readFile("/docs/freshness.md")).toBe(
      "fresh off main + overlay addendum",
    );
    expect(await root.readFile("/docs/freshness.md")).toBe("fresh off main");

    // Deleting a parent file leaves a whiteout: gone here, intact on main.
    expect(await workspace.deleteFile("/worker.ts")).toBe(true);
    expect(await workspace.readFile("/worker.ts")).toBeNull();
    expect(await workspace.exists("/worker.ts")).toBe(false);
    expect((await workspace.readDir("/")).map((entry) => entry.name)).not.toContain("worker.ts");
    expect(await root.exists("/worker.ts")).toBe(true);

    // revert un-pins one path: a shadowed file follows main again, a deleted
    // one comes back — the surgical sibling of reset().
    await workspace.revert("/docs/freshness.md");
    expect(await workspace.readFile("/docs/freshness.md")).toBe("fresh off main");
    await workspace.revert("/worker.ts");
    expect(await workspace.exists("/worker.ts")).toBe(true);
    // Re-delete so the publish below still exercises whiteouts.
    expect(await workspace.deleteFile("/worker.ts")).toBe(true);
    // Re-shadow so the publish below still exercises copy-up content.
    await workspace.appendFile("/docs/freshness.md", " + overlay addendum");

    // .git stays reserved: writes are rejected (platform-managed name).
    await expect(workspace.writeFile("/.git/config", "[remote]")).rejects.toThrow(/not writable/);
    await expect(workspace.rm("/", { recursive: true })).rejects.toThrow(/not writable/);

    // -- commit: the workspace's changes land on the config repo's MAIN ------

    // Captured pre-commit so main's worker.ts can be restored afterwards
    // (the commit below deletes it, and later assertions want a sane repo).
    const workerTsContent = await root.readFile("/worker.ts");
    expect(workerTsContent).not.toBeNull();

    const status = await workspace.git.status();
    expect(status).toContainEqual({ change: "added", path: "/notes/e2e.md" });
    expect(status).toContainEqual({ change: "modified", path: "/docs/freshness.md" });
    expect(status).toContainEqual({ change: "deleted", path: "/worker.ts" });

    const committed = await workspace.git.commit({ message: "e2e workspace commit" });
    expect(committed.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.changedPaths).toContain("/notes/e2e.md");
    expect(committed.changedPaths).toContain("/worker.ts");
    const [head] = await workspace.git.log({ limit: 1 });
    expect(head?.oid).toBe(committed.commitOid);
    expect(head?.message).toContain("e2e workspace commit");

    // The commit went to MAIN: adds, shadows, and deletions are all live on
    // the repo — this is what makes "agent updates the website" one call.
    expect((await project.repo.readFile({ path: "notes/e2e.md" }))?.content).toBe(
      "workspace hello world",
    );
    expect((await project.repo.readFile({ path: "docs/freshness.md" }))?.content).toBe(
      "fresh off main + overlay addendum",
    );
    expect(await project.repo.readFile({ path: "worker.ts" })).toBeNull();

    // After the commit the overlay is pristine again: no private shadows, and
    // reads fall through to the new main (which contains the changes).
    expect(await workspace.git.status()).toEqual([]);
    expect(await workspace.readFile("/notes/e2e.md")).toBe("workspace hello world");
    expect(await workspace.exists("/worker.ts")).toBe(false);

    // Restore worker.ts on main so the project stays buildable for the rest
    // of the test.
    await project.repo.commitFiles({
      message: "e2e: restore worker.ts after workspace-delete commit",
      changes: [{ path: "worker.ts", content: workerTsContent! }],
    });
    expect(await workspace.exists("/worker.ts")).toBe(true);

    // Secondary repos are NOT the config repo: their reads must serve their
    // own files, never the root workspace cache (which mirrors only "/").
    using sideRepo = project.repos.get("/repos/e2e-side");
    await sideRepo.create();
    await sideRepo.commitFiles({
      message: "seed a side-repo file",
      changes: [{ path: "side.md", content: "side repo truth" }],
    });
    expect((await sideRepo.readFile({ path: "side.md" }))?.content).toBe("side repo truth");
    expect((await sideRepo.listFiles()).paths).toContain("side.md");
    expect(await project.repo.readFile({ path: "side.md" })).toBeNull();

    // An empty overlay has nothing to commit — and, because the earlier
    // commit landed on MAIN, a brand-new overlay already sees its files
    // through the fall-through (workspace commits are shared state, not
    // per-workspace branches).
    using other = project.workspaces.get(`/workspaces/agents/e2e-${crypto.randomUUID()}`);
    expect(await other.readFile("/notes/e2e.md")).toBe("workspace hello world");
    await expect(other.git.commit({ message: "premature" })).rejects.toThrow(/Nothing to commit/);

    // -- itx.files <-> workspace: the two file domains compose through bytes.

    // files -> workspace: pull a stored file into the overlay. (files.put
    // string data must be base64, so plain text goes in as encoded bytes.)
    await project.files
      .get("/e2e/transfer.txt")
      .put({ contentType: "text/plain", data: new TextEncoder().encode("born in itx.files") });
    await workspace.writeFileBytes(
      "/imported/transfer.txt",
      await project.files.get("/e2e/transfer.txt").bytes(),
    );
    expect(await workspace.readFile("/imported/transfer.txt")).toBe("born in itx.files");

    // workspace -> files: publish a fallen-through file and mint a signed URL.
    const packageJsonBytes = await workspace.readFileBytes("/package.json");
    expect(packageJsonBytes).not.toBeNull();
    const publishedFile = await project.files.get("/e2e/package-from-workspace.json").put({
      contentType: "application/json",
      data: packageJsonBytes!,
    });
    expect(publishedFile).toMatchObject({
      contentType: "application/json",
      path: "/e2e/package-from-workspace.json",
    });
    expect(publishedFile.size).toBeGreaterThan(0);
    expect(await project.files.get("/e2e/package-from-workspace.json").url()).toContain(
      "iterate-files--",
    );

    // Binary bytes survive the round trip files -> workspace -> files intact
    // (workspace text reads would mojibake these; the bytes lanes must not).
    const binary = new Uint8Array([0, 255, 1, 254, 137, 80, 78, 71, 13, 10, 26, 10]);
    await project.files
      .get("/e2e/blob.bin")
      .put({ contentType: "application/octet-stream", data: binary });
    await workspace.writeFileBytes(
      "/imported/blob.bin",
      await project.files.get("/e2e/blob.bin").bytes(),
    );
    const roundTripped = await workspace.readFileBytes("/imported/blob.bin");
    expect(Array.from(roundTripped ?? [])).toEqual(Array.from(binary));
  });
});
