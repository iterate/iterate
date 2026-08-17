import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test(
  "workspaces are one namespace: repos auto-mount at /repos/**, scratch lives at the workspace's own path, commits route per mount",
  { timeout: 240_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = await itx.projects.get(`workspace-${crypto.randomUUID()}`).create({});

    // The derived mount table points at the config repo, which seeds
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

    const workspacePath = `/workspaces/e2e/${crypto.randomUUID()}`;
    using workspace = project.workspaces.get(workspacePath);

    // -- explicit birth; the mount table is DERIVED, never stored -------------

    await expect(workspace.processor.snapshot()).resolves.toMatchObject({
      offset: 0,
      state: { birthCertificate: null },
    });
    await expect(workspace.readFile("/repos/config/package.json")).rejects.toThrow(
      /does not exist.*create it with itx\.workspaces\.get/s,
    );
    await expect(workspace.writeFile("notes.md", "premature")).rejects.toThrow(/does not exist/);
    await workspace.create({});
    await workspace.create({}); // identical birth retries dedupe
    // The EFFECTIVE table: every project repo at its own /repos/** stream
    // path. Never assert the exact table — projects can carry more repos.
    const config = await workspace.getConfig();
    expect(config.mounts["/repos/config"]).toEqual({
      policy: "commit-to-main",
      repoPath: "/repos/config",
    });
    expect(config.mounts["/"]).toBeUndefined(); // "/" is never a mount

    // -- fall-through reads: no clone, the mounted repo's latest main ---------

    const seededPackageJson = await workspace.readFile("/repos/config/package.json");
    expect(seededPackageJson).toBe(
      (await project.repo.readFile({ path: "package.json" }))?.content,
    );
    expect(await workspace.listAllFiles()).toContain("/repos/config/worker.ts");
    // The repo's git plumbing is not a workspace file.
    expect(await workspace.exists("/repos/config/.git")).toBe(false);

    // A commit to main is visible through the workspace immediately (the
    // repo's read-your-write boundary feeds the mount's HEAD reads).
    await project.repo.commitFiles({
      message: "e2e: main moves under the workspace",
      changes: [{ path: "docs/freshness.md", content: "fresh off main" }],
    });
    expect(await workspace.readFile("/repos/config/docs/freshness.md")).toBe("fresh off main");

    // -- private scratch: the workspace's own path; relative paths resolve there

    await workspace.writeFile("notes.md", "workspace hello");
    // Relative and absolute spellings are the same file.
    expect(await workspace.readFile("notes.md")).toBe("workspace hello");
    expect(await workspace.readFile(`${workspacePath}/notes.md`)).toBe("workspace hello");
    const editedScratch = await workspace.edit({
      path: "notes.md",
      oldString: "hello",
      newString: "hello world",
    });
    // Results speak the resolved absolute spelling.
    expect(editedScratch).toEqual({ occurrenceCount: 1, path: `${workspacePath}/notes.md` });
    expect(await workspace.readFile("notes.md")).toBe("workspace hello world");
    expect(await workspace.listAllFiles()).toContain(`${workspacePath}/notes.md`);
    // A relative glob resolves against the workspace's own directory.
    expect(await workspace.glob("*.md")).toContain(`${workspacePath}/notes.md`);
    expect(await workspace.glob("**")).not.toContain("/repos/config/worker.ts");

    // Writes outside every mount and the workspace's own directory fail
    // loudly — a typo'd absolute path must not become stray scratch.
    await expect(workspace.writeFile("/notes/e2e.md", "strays")).rejects.toThrow(/not writable/);
    await expect(workspace.writeFile("/repos/nope/readme.md", "no such repo")).rejects.toThrow(
      /not writable/,
    );
    // .git stays reserved everywhere: writes are rejected (platform-managed).
    await expect(workspace.writeFile("/repos/config/.git/config", "[remote]")).rejects.toThrow(
      /not writable/,
    );

    // -- local writes shadow the mounted repo; deletes whiteout ---------------

    await workspace.writeFile("/repos/config/notes/e2e.md", "workspace hello");
    const edited = await workspace.edit({
      path: "/repos/config/notes/e2e.md",
      oldString: "hello",
      newString: "hello world",
    });
    expect(edited).toEqual({ occurrenceCount: 1, path: "/repos/config/notes/e2e.md" });
    expect(await workspace.readFile("/repos/config/notes/e2e.md")).toBe("workspace hello world");
    // The mounted repo is untouched by workspace writes until a commit.
    expect(await project.repo.readFile({ path: "notes/e2e.md" })).toBeNull();

    // Editing a fallen-through file copies it up: private to this workspace.
    await workspace.edit({
      path: "/repos/config/docs/freshness.md",
      oldString: "fresh off main",
      newString: "fresh off main + overlay addendum",
    });
    expect(await workspace.readFile("/repos/config/docs/freshness.md")).toBe(
      "fresh off main + overlay addendum",
    );
    expect((await project.repo.readFile({ path: "docs/freshness.md" }))?.content).toBe(
      "fresh off main",
    );

    // Deleting a mount file leaves a whiteout: gone here, intact on main.
    expect(await workspace.deleteFile("/repos/config/worker.ts")).toBe(true);
    expect(await workspace.readFile("/repos/config/worker.ts")).toBeNull();
    expect(await workspace.exists("/repos/config/worker.ts")).toBe(false);
    expect(await workspace.listAllFiles()).not.toContain("/repos/config/worker.ts");
    expect(await project.repo.readFile({ path: "worker.ts" })).not.toBeNull();

    // -- batched reads agree with every single-file arm ------------------------
    // One readFiles call mixing a mount shadow, a copied-up edit, a whiteout,
    // a pure mount fall-through, private scratch (spelled RELATIVE — results
    // are keyed by the caller's spelling), and a miss. The mount arm reaches
    // the repo through a snapshot SCOPED to the asked paths (an unscoped one
    // ships the whole HEAD tree across a 32MiB-capped RPC, which is exactly
    // how big-repo boards died in production).
    expect(
      await workspace.readFiles([
        "/repos/config/notes/e2e.md",
        "/repos/config/docs/freshness.md",
        "/repos/config/worker.ts",
        "/repos/config/package.json",
        "notes.md",
        "/nope/missing.md",
      ]),
    ).toEqual({
      "/repos/config/notes/e2e.md": "workspace hello world",
      "/repos/config/docs/freshness.md": "fresh off main + overlay addendum",
      "/repos/config/worker.ts": null,
      "/repos/config/package.json": seededPackageJson,
      "notes.md": "workspace hello world",
      "/nope/missing.md": null,
    });

    // revert un-pins one path: a shadowed file follows main again, a deleted
    // one comes back — the surgical sibling of reset().
    await workspace.revert("/repos/config/docs/freshness.md");
    expect(await workspace.readFile("/repos/config/docs/freshness.md")).toBe("fresh off main");
    await workspace.revert("/repos/config/worker.ts");
    expect(await workspace.exists("/repos/config/worker.ts")).toBe(true);
    // Re-delete and re-shadow so the commit below exercises whiteouts + copy-up.
    expect(await workspace.deleteFile("/repos/config/worker.ts")).toBe(true);
    await workspace.edit({
      path: "/repos/config/docs/freshness.md",
      oldString: "fresh off main",
      newString: "fresh off main + overlay addendum",
    });

    // -- status groups by owning mount; scratch is unmounted, never committable

    // Captured pre-commit so main's worker.ts can be restored afterwards
    // (the commit below deletes it, and later assertions want a sane repo).
    const workerTsContent = (await project.repo.readFile({ path: "worker.ts" }))?.content;
    expect(workerTsContent).not.toBeNull();

    const status = await workspace.git.status();
    const configMount = status.mounts.find((mount) => mount.path === "/repos/config");
    expect(configMount?.policy).toBe("commit-to-main");
    expect(configMount?.repoPath).toBe("/repos/config");
    expect(configMount?.changes).toContainEqual({
      change: "added",
      path: "/repos/config/notes/e2e.md",
    });
    expect(configMount?.changes).toContainEqual({
      change: "modified",
      path: "/repos/config/docs/freshness.md",
    });
    expect(configMount?.changes).toContainEqual({
      change: "deleted",
      path: "/repos/config/worker.ts",
    });
    expect(status.unmounted).toContainEqual({
      change: "added",
      path: `${workspacePath}/notes.md`,
    });

    // -- commit: ONE mount's changes land on that repo's MAIN ------------------

    const committed = await workspace.git.commit({
      message: "e2e workspace commit",
      scope: "/repos/config",
    });
    expect(committed.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(committed).toMatchObject({ mount: "/repos/config", repoPath: "/repos/config" });
    expect(committed.changedPaths).toContain("/repos/config/notes/e2e.md");
    expect(committed.changedPaths).toContain("/repos/config/worker.ts");
    const [head] = await workspace.git.log({ limit: 1, scope: "/repos/config" });
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

    // After the commit the mount's overlay is pristine again (reads fall
    // through to the new main), while the never-committable scratch SURVIVES.
    const statusAfter = await workspace.git.status();
    expect(statusAfter.mounts.find((mount) => mount.path === "/repos/config")?.changes).toEqual([]);
    expect(statusAfter.unmounted).toContainEqual({
      change: "added",
      path: `${workspacePath}/notes.md`,
    });
    expect(await workspace.readFile("/repos/config/notes/e2e.md")).toBe("workspace hello world");
    expect(await workspace.exists("/repos/config/worker.ts")).toBe(false);
    expect(await workspace.readFile("notes.md")).toBe("workspace hello world");
    expect(await project.repo.readFile({ path: "notes.md" })).toBeNull();

    // Restore worker.ts on main so the project stays buildable for the rest
    // of the test.
    await project.repo.commitFiles({
      message: "e2e: restore worker.ts after workspace-delete commit",
      changes: [{ path: "worker.ts", content: workerTsContent! }],
    });
    expect(await workspace.exists("/repos/config/worker.ts")).toBe(true);

    // -- a freshly created repo auto-mounts at its own /repos/** path ---------

    using sideRepo = project.repos.get("/repos/e2e-side");
    await sideRepo.create({ type: "empty" });
    await sideRepo.commitFiles({
      message: "seed a side-repo file",
      changes: [{ path: "side.md", content: "side repo truth" }],
    });
    // No configure call: the derived table follows the project's repo list.
    // The repo's terminal creation fact copies to the project catalog
    // asynchronously, so poll the first read briefly.
    await waitForCondition(
      async () => {
        const read = await workspace.readFile("/repos/e2e-side/side.md").catch(() => null);
        return read !== null;
      },
      { description: "fresh repo to auto-mount", intervalMs: 500, timeoutMs: 30_000 },
    );
    expect(await workspace.readFile("/repos/e2e-side/side.md")).toBe("side repo truth");
    expect((await workspace.getConfig()).mounts["/repos/e2e-side"]).toEqual({
      policy: "commit-to-main",
      repoPath: "/repos/e2e-side",
    });

    // Regression (thermo round five): an EPHEMERAL event on the workspace
    // stream holds a raw offset the processor fold can never reach — configure
    // must pin its fold barrier to the DURABLE head (the CAS still targets the
    // raw head), or it wedges on this trailing suffix and times out.
    await project.streams.get(workspacePath).append({
      type: "events.iterate.com/e2e/ephemeral-noise",
      payload: { note: "trailing ephemeral suffix" },
      ephemeral: true,
    });

    // -- configure: overlays are DEVIATIONS from the derived table ------------

    // A COMPLETE overlay mounts a repo at an extra path; the patch deep-merges
    // per mount point, so the derived mounts are never restated.
    const patched = await workspace.configure({
      config: { mounts: { "/side": { policy: "commit-to-main", repoPath: "/repos/e2e-side" } } },
    });
    expect(patched).toMatchObject({
      mounts: {
        "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
        "/repos/e2e-side": { policy: "commit-to-main", repoPath: "/repos/e2e-side" },
        "/side": { policy: "commit-to-main", repoPath: "/repos/e2e-side" },
      },
    });

    // The extra mount owns its subtree; commits through it land on the backing
    // repo's main, and the derived mount sees them — one repo, two views.
    expect(await workspace.readFile("/side/side.md")).toBe("side repo truth");
    expect(await workspace.glob("/side/**")).toContain("/side/side.md");
    await workspace.writeFile("/side/from-side.md", "committed through /side");
    const sideCommit = await workspace.git.commit({
      message: "via the /side mount",
      scope: "/side",
    });
    expect(sideCommit).toMatchObject({
      changedPaths: ["/side/from-side.md"],
      mount: "/side",
      repoPath: "/repos/e2e-side",
    });
    expect((await sideRepo.readFile({ path: "from-side.md" }))?.content).toBe(
      "committed through /side",
    );
    expect(await workspace.readFile("/repos/e2e-side/from-side.md")).toBe(
      "committed through /side",
    );

    // A PARTIAL patch deviates one field of the overlay — the deep merge
    // keeps its repoPath.
    const readOnly = await workspace.configure({
      config: { mounts: { "/side": { policy: "read-only" } } },
    });
    expect(readOnly.mounts["/side"]).toEqual({ policy: "read-only", repoPath: "/repos/e2e-side" });

    // The policy gates the COMMIT door, not writes: overlay writes stay
    // private everywhere and read-only mounts refuse to publish them.
    await workspace.writeFile("/side/attempt.md", "not committable");
    await expect(workspace.git.commit({ message: "nope", scope: "/side" })).rejects.toThrow(
      /read-only/,
    );

    // With two dirty mounts a scope-less commit refuses to guess...
    await workspace.writeFile("/repos/config/notes/second.md", "commit me");
    await expect(workspace.git.commit({ message: "ambiguous" })).rejects.toThrow(/span/);
    // ...and a scoped commit takes ONLY that mount's changes; the read-only
    // mount's private write survives untouched.
    const scoped = await workspace.git.commit({
      message: "scoped commit",
      scope: "/repos/config",
    });
    expect(scoped).toMatchObject({
      changedPaths: ["/repos/config/notes/second.md"],
      mount: "/repos/config",
    });
    expect(await workspace.readFile("/side/attempt.md")).toBe("not committable");
    expect(await sideRepo.readFile({ path: "attempt.md" })).toBeNull();

    // Unmounting over UNCOMMITTED work is refused — a config change must never
    // orphan overlay state or move it into a different repo's next commit.
    await expect(workspace.configure({ config: { mounts: { "/side": null } } })).rejects.toThrow(
      /uncommitted work/,
    );
    await workspace.revert("/side/attempt.md");
    // null clears the overlay; the DERIVED mount on the same repo is untouched.
    const cleared = await workspace.configure({ config: { mounts: { "/side": null } } });
    expect(cleared.mounts["/side"]).toBeUndefined();
    expect(await workspace.readFile("/side/side.md")).toBeNull();
    expect(await workspace.readFile("/repos/e2e-side/side.md")).toBe("side repo truth");

    // A partial overlay can deviate a DERIVED mount too...
    const deviated = await workspace.configure({
      config: { mounts: { "/repos/e2e-side": { policy: "read-only" } } },
    });
    expect(deviated.mounts["/repos/e2e-side"]).toEqual({
      policy: "read-only",
      repoPath: "/repos/e2e-side",
    });
    await workspace.writeFile("/repos/e2e-side/blocked.md", "blocked until the overlay clears");
    await expect(
      workspace.git.commit({ message: "blocked", scope: "/repos/e2e-side" }),
    ).rejects.toThrow(/read-only/);
    // ...and null clears it back to the derived default (same mount, same
    // repo — the dirty file stays put), so the SAME commit now lands.
    const restored = await workspace.configure({
      config: { mounts: { "/repos/e2e-side": null } },
    });
    expect(restored.mounts["/repos/e2e-side"]).toEqual({
      policy: "commit-to-main",
      repoPath: "/repos/e2e-side",
    });
    const unblocked = await workspace.git.commit({
      message: "unblocked after clearing the deviation",
      scope: "/repos/e2e-side",
    });
    expect(unblocked).toMatchObject({
      changedPaths: ["/repos/e2e-side/blocked.md"],
      mount: "/repos/e2e-side",
    });

    // A brand-new workspace already sees the earlier commits through the
    // fall-through (workspace commits are shared state on main, not branches)
    // — and an empty one has nothing to commit.
    using other = project.workspaces.get(`/workspaces/e2e/${crypto.randomUUID()}`);
    await other.create({});
    expect(await other.readFile("/repos/config/notes/e2e.md")).toBe("workspace hello world");
    await expect(other.git.commit({ message: "premature" })).rejects.toThrow(/Nothing to commit/);

    // -- create({ mounts }) takes overlay deviations as birth facts -----------

    using custom = project.workspaces.get(`/workspaces/e2e/custom-${crypto.randomUUID()}`);
    await custom.create({
      mounts: { "/cfg": { policy: "read-only", repoPath: "/repos/config" } },
    });
    expect(await custom.getConfig()).toMatchObject({
      mounts: {
        "/cfg": { policy: "read-only", repoPath: "/repos/config" },
        "/repos/config": { policy: "commit-to-main", repoPath: "/repos/config" },
      },
    });
    expect(await custom.readFile("/cfg/package.json")).toBe(seededPackageJson);

    // An identical birth retry dedupes; different birth mounts are a loud
    // duplicate, never a silent reconfiguration (configure() after birth
    // instead).
    await custom.create({
      mounts: { "/cfg": { policy: "read-only", repoPath: "/repos/config" } },
    });
    await expect(
      custom.create({
        mounts: { "/cfg": { policy: "commit-to-main", repoPath: "/repos/config" } },
      }),
    ).rejects.toThrow();
    expect((await custom.getConfig()).mounts["/cfg"]).toEqual({
      policy: "read-only",
      repoPath: "/repos/config",
    });

    // -- itx.files <-> workspace: the two file domains compose through bytes.

    // Imported bytes land in private scratch (a relative path resolves to the
    // workspace's own directory).
    await project.files
      .get("/e2e/transfer.txt")
      .put({ contentType: "text/plain", data: new TextEncoder().encode("born in itx.files") });
    await workspace.writeFileBytes(
      "imported/transfer.txt",
      await project.files.get("/e2e/transfer.txt").bytes(),
    );
    expect(await workspace.readFile(`${workspacePath}/imported/transfer.txt`)).toBe(
      "born in itx.files",
    );

    // workspace -> files: publish a fallen-through repo file and mint a signed URL.
    const packageJsonBytes = await workspace.readFileBytes("/repos/config/package.json");
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

    // Binary bytes survive the round trip files -> scratch -> workspace intact
    // (text reads would mojibake these; the bytes lanes must not) — written
    // absolute, read back relative: the two spellings are one file.
    const binary = new Uint8Array([0, 255, 1, 254, 137, 80, 78, 71, 13, 10, 26, 10]);
    await project.files
      .get("/e2e/blob.bin")
      .put({ contentType: "application/octet-stream", data: binary });
    await workspace.writeFileBytes(
      `${workspacePath}/imported/blob.bin`,
      await project.files.get("/e2e/blob.bin").bytes(),
    );
    const roundTripped = await workspace.readFileBytes("imported/blob.bin");
    expect(Array.from(roundTripped ?? [])).toEqual(Array.from(binary));
  },
);
