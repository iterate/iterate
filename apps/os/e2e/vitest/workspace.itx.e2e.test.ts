import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("workspaces are event-sourced and mount-routed: overlays shadow, commits route per mount", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `workspace-${crypto.randomUUID()}` });

  // The default mount table points at the config repo, which seeds
  // asynchronously after project creation — wait for the seed so fall-through
  // reads have a source. readFile THROWS (not null) until the repo artifact
  // exists, so swallow errors while polling; cold slots can take a while.
  await waitForCondition(
    async () => {
      const read = await project.repo.readFile({ path: "package.json" }).catch(() => null);
      return read !== null;
    },
    { description: "config repo to be seeded", intervalMs: 1_000, timeoutMs: 60_000 },
  );

  const workspacePath = `/workspaces/agents/e2e-${crypto.randomUUID()}`;
  using workspace = project.workspaces.get(workspacePath);

  // -- first touch births the workspace with the default mount table --------

  // No explicit create: the first operation appends the workspace/created
  // birth certificate with the config repo mounted at "/", committable.
  const config = await workspace.getConfig();
  expect(config).toMatchObject({
    mounts: { "/": { policy: "commit-to-main", repoPath: "/repos/config" } },
  });

  // -- fall-through reads: no clone, the mounted repo's latest main ---------

  const seededPackageJson = await workspace.readFile("/package.json");
  expect(seededPackageJson).toBe((await project.repo.readFile({ path: "package.json" }))?.content);
  expect(await workspace.listAllFiles()).toContain("/worker.ts");
  // The repo's git plumbing is not a workspace file.
  expect(await workspace.exists("/.git")).toBe(false);

  // A commit to main is visible through the workspace immediately (the
  // repo's read-your-write boundary feeds the mount's HEAD reads).
  await project.repo.commitFiles({
    message: "e2e: main moves under the workspace",
    changes: [{ path: "docs/freshness.md", content: "fresh off main" }],
  });
  expect(await workspace.readFile("/docs/freshness.md")).toBe("fresh off main");

  // -- local writes shadow; deletes whiteout ---------------------------------

  await workspace.writeFile("/notes/e2e.md", "workspace hello");
  const edited = await workspace.edit({
    path: "/notes/e2e.md",
    oldString: "hello",
    newString: "hello world",
  });
  expect(edited).toEqual({ occurrenceCount: 1, path: "/notes/e2e.md" });
  expect(await workspace.readFile("/notes/e2e.md")).toBe("workspace hello world");
  // The seeded repo is untouched by workspace writes until a commit.
  expect(await project.repo.readFile({ path: "notes/e2e.md" })).toBeNull();

  // Editing a fallen-through file copies it up: private to this workspace.
  await workspace.edit({
    path: "/docs/freshness.md",
    oldString: "fresh off main",
    newString: "fresh off main + overlay addendum",
  });
  expect(await workspace.readFile("/docs/freshness.md")).toBe("fresh off main + overlay addendum");
  expect((await project.repo.readFile({ path: "docs/freshness.md" }))?.content).toBe(
    "fresh off main",
  );

  // Deleting a mount file leaves a whiteout: gone here, intact on main.
  expect(await workspace.deleteFile("/worker.ts")).toBe(true);
  expect(await workspace.readFile("/worker.ts")).toBeNull();
  expect(await workspace.exists("/worker.ts")).toBe(false);
  expect(await workspace.listAllFiles()).not.toContain("/worker.ts");
  expect(await project.repo.readFile({ path: "worker.ts" })).not.toBeNull();

  // revert un-pins one path: a shadowed file follows main again, a deleted
  // one comes back — the surgical sibling of reset().
  await workspace.revert("/docs/freshness.md");
  expect(await workspace.readFile("/docs/freshness.md")).toBe("fresh off main");
  await workspace.revert("/worker.ts");
  expect(await workspace.exists("/worker.ts")).toBe(true);
  // Re-delete and re-shadow so the commit below exercises whiteouts + copy-up.
  expect(await workspace.deleteFile("/worker.ts")).toBe(true);
  await workspace.edit({
    path: "/docs/freshness.md",
    oldString: "fresh off main",
    newString: "fresh off main + overlay addendum",
  });

  // .git stays reserved: writes are rejected (platform-managed name).
  await expect(workspace.writeFile("/.git/config", "[remote]")).rejects.toThrow(/not writable/);

  // -- commit: one mount's changes land on that repo's MAIN ------------------

  // Captured pre-commit so main's worker.ts can be restored afterwards
  // (the commit below deletes it, and later assertions want a sane repo).
  const workerTsContent = (await project.repo.readFile({ path: "worker.ts" }))?.content;
  expect(workerTsContent).not.toBeNull();

  const status = await workspace.git.status();
  expect(status).toMatchObject({ unmounted: [] });
  const rootMount = status.mounts.find((mount) => mount.path === "/");
  expect(rootMount?.policy).toBe("commit-to-main");
  expect(rootMount?.changes).toContainEqual({ change: "added", path: "/notes/e2e.md" });
  expect(rootMount?.changes).toContainEqual({ change: "modified", path: "/docs/freshness.md" });
  expect(rootMount?.changes).toContainEqual({ change: "deleted", path: "/worker.ts" });

  // scope is optional: exactly one mount is dirty.
  const committed = await workspace.git.commit({ message: "e2e workspace commit" });
  expect(committed.commitOid).toMatch(/^[0-9a-f]{40}$/);
  expect(committed).toMatchObject({ mount: "/", repoPath: "/repos/config" });
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
  const statusAfter = await workspace.git.status();
  expect(statusAfter.mounts.find((mount) => mount.path === "/")?.changes).toEqual([]);
  expect(await workspace.readFile("/notes/e2e.md")).toBe("workspace hello world");
  expect(await workspace.exists("/worker.ts")).toBe(false);

  // Restore worker.ts on main so the project stays buildable for the rest
  // of the test.
  await project.repo.commitFiles({
    message: "e2e: restore worker.ts after workspace-delete commit",
    changes: [{ path: "worker.ts", content: workerTsContent! }],
  });
  expect(await workspace.exists("/worker.ts")).toBe(true);

  // -- mounts: a second repo joins the tree; commits route per mount --------

  using sideRepo = project.repos.get("/repos/e2e-side");
  await sideRepo.create();
  await sideRepo.commitFiles({
    message: "seed a side-repo file",
    changes: [{ path: "side.md", content: "side repo truth" }],
  });

  // configure deep-merges per mount point: this patch ADDS /side read-only
  // without restating the "/" mount.
  const patched = await workspace.configure({
    config: { mounts: { "/side": { policy: "read-only", repoPath: "/repos/e2e-side" } } },
  });
  expect(patched).toMatchObject({
    mounts: {
      "/": { policy: "commit-to-main", repoPath: "/repos/config" },
      "/side": { policy: "read-only", repoPath: "/repos/e2e-side" },
    },
  });

  // The deeper mount owns its subtree: reads route to the side repo, and the
  // merged listing shows both repos' files (repos.create seeds the template,
  // so the side mount carries those files too — assert containment).
  expect(await workspace.readFile("/side/side.md")).toBe("side repo truth");
  expect(await workspace.glob("/side/**")).toContain("/side/side.md");
  expect(await workspace.glob("/side/**")).not.toContain("/worker.ts");

  // Writes under a read-only mount stay private and refuse to commit.
  await workspace.writeFile("/side/attempt.md", "not committable");
  await expect(workspace.git.commit({ message: "nope", scope: "/side" })).rejects.toThrow(
    /read-only/,
  );

  // With two dirty mounts a scope-less commit refuses to guess...
  await workspace.writeFile("/notes/second.md", "commit me");
  await expect(workspace.git.commit({ message: "ambiguous" })).rejects.toThrow(/span/);
  // ...and a scoped commit takes ONLY that mount's changes; the read-only
  // mount's private write survives untouched.
  const scoped = await workspace.git.commit({ message: "scoped commit", scope: "/" });
  expect(scoped).toMatchObject({ changedPaths: ["/notes/second.md"], mount: "/" });
  expect(await workspace.readFile("/side/attempt.md")).toBe("not committable");
  expect(await sideRepo.readFile({ path: "attempt.md" })).toBeNull();

  // Unmount via null; the private write under it becomes unmounted scratch.
  const unmounted = await workspace.configure({ config: { mounts: { "/side": null } } });
  expect(unmounted).toMatchObject({
    mounts: { "/": { policy: "commit-to-main", repoPath: "/repos/config" } },
  });
  expect(await workspace.readFile("/side/side.md")).toBeNull();
  expect(await workspace.readFile("/side/attempt.md")).toBe("not committable");
  // With "/" still mounted nothing is ever truly unmounted — the orphaned
  // local file now routes to the root mount as an ordinary addition.
  const statusAfterUnmount = await workspace.git.status();
  expect(statusAfterUnmount.unmounted).toEqual([]);
  expect(statusAfterUnmount.mounts.find((mount) => mount.path === "/")?.changes).toContainEqual({
    change: "added",
    path: "/side/attempt.md",
  });

  // A brand-new workspace already sees the earlier commit through the
  // fall-through (workspace commits are shared state on main, not branches)
  // — and an empty one has nothing to commit.
  const otherPath = `/workspaces/agents/e2e-${crypto.randomUUID()}`;
  using other = project.workspaces.get(otherPath);
  expect(await other.readFile("/notes/e2e.md")).toBe("workspace hello world");
  await expect(other.git.commit({ message: "premature" })).rejects.toThrow(/Nothing to commit/);

  // create() on an ALREADY-BORN workspace with a DIFFERENT table observes the
  // birth certificate (a blind re-append would hit the stream's different-body
  // idempotency rejection) and converges via one configured patch.
  using otherRecreated = await project.workspaces.create({
    path: otherPath,
    mounts: { "/cfg": { policy: "read-only", repoPath: "/repos/config" } },
  });
  expect(await otherRecreated.getConfig()).toMatchObject({
    mounts: { "/cfg": { policy: "read-only", repoPath: "/repos/config" } },
  });
  expect(await otherRecreated.readFile("/cfg/package.json")).not.toBeNull();

  // -- explicit create with a custom table is idempotent and converges ------

  const customPath = `/workspaces/custom-${crypto.randomUUID()}`;
  using custom = await project.workspaces.create({
    path: customPath,
    mounts: { "/cfg": { policy: "commit-to-main", repoPath: "/repos/config" } },
  });
  expect(await custom.getConfig()).toMatchObject({
    mounts: { "/cfg": { policy: "commit-to-main", repoPath: "/repos/config" } },
  });
  expect(await custom.readFile("/cfg/package.json")).not.toBeNull();
  // Paths outside every mount are private scratch — readable, listable,
  // never committable.
  expect(await custom.readFile("/package.json")).toBeNull();

  // -- itx.files <-> workspace: the two file domains compose through bytes.

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
