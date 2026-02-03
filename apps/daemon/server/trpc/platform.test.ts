import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import simpleGit from "simple-git";

/**
 * Create a test git repo with main + feature branches and a bare remote.
 * Returns a disposable that cleans up on dispose.
 */
async function createTestRepo() {
  const originalEnv = process.env.ITERATE_REPO;

  // Create temp directory with git repo
  const tempDir = mkdtempSync(join(tmpdir(), "iterate-sync-test-"));
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir);

  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");

  // Create initial commit on main
  writeFileSync(join(repoDir, "file.txt"), "initial");
  await git.add(".");
  await git.commit("initial commit");
  await git.branch(["-M", "main"]);

  // Create a second commit
  writeFileSync(join(repoDir, "file.txt"), "second");
  await git.add(".");
  await git.commit("second commit");

  // Create a feature branch with another commit
  await git.checkout(["-b", "feature"]);
  writeFileSync(join(repoDir, "file.txt"), "feature");
  await git.add(".");
  await git.commit("feature commit");
  await git.checkout("main");

  // Set up remote (use a bare clone as remote for testing)
  const bareDir = join(tempDir, "bare.git");
  const bareGit = simpleGit();
  await bareGit.clone(repoDir, bareDir, ["--bare"]);
  await git.addRemote("origin", bareDir);
  await git.push("origin", "main");
  await git.push("origin", "feature");

  // Set env
  process.env.ITERATE_REPO = repoDir;

  return {
    tempDir,
    repoDir,
    git,
    [Symbol.asyncDispose]: async () => {
      // Restore env
      if (originalEnv !== undefined) {
        process.env.ITERATE_REPO = originalEnv;
      } else {
        delete process.env.ITERATE_REPO;
      }
      // Clean up temp dir
      rmSync(tempDir, { recursive: true, force: true });
      // Reset module state (clears lastSyncedIterateSha cache)
      vi.resetModules();
    },
  };
}

describe("syncIterateRepo", () => {
  it("syncs to a specific sha on main", async () => {
    await using repo = await createTestRepo();
    const { syncIterateRepo } = await import("./platform.ts");

    // Get the initial commit sha
    const log = await repo.git.log();
    const initialSha = log.all[1].hash; // second oldest commit (initial)

    await syncIterateRepo(initialSha, "main");

    const currentSha = (await repo.git.revparse(["HEAD"])).trim();
    expect(currentSha).toBe(initialSha);
  });

  it("syncs to a sha on a different branch", async () => {
    await using repo = await createTestRepo();
    const { syncIterateRepo } = await import("./platform.ts");

    // Get the feature branch sha
    await repo.git.checkout("feature");
    const featureSha = (await repo.git.revparse(["HEAD"])).trim();
    await repo.git.checkout("main");

    await syncIterateRepo(featureSha, "feature");

    const currentSha = (await repo.git.revparse(["HEAD"])).trim();
    expect(currentSha).toBe(featureSha);
  });

  it("skips sync if already at expected sha", async () => {
    await using repo = await createTestRepo();
    const { syncIterateRepo } = await import("./platform.ts");

    const currentSha = (await repo.git.revparse(["HEAD"])).trim();

    // Should be a no-op
    await syncIterateRepo(currentSha, "main");

    const newSha = (await repo.git.revparse(["HEAD"])).trim();
    expect(newSha).toBe(currentSha);
  });

  it("stashes dirty changes before syncing", async () => {
    await using repo = await createTestRepo();
    const { syncIterateRepo } = await import("./platform.ts");

    // Make uncommitted changes
    writeFileSync(join(repo.repoDir, "file.txt"), "dirty");

    const log = await repo.git.log();
    const initialSha = log.all[1].hash;

    await syncIterateRepo(initialSha, "main");

    const currentSha = (await repo.git.revparse(["HEAD"])).trim();
    expect(currentSha).toBe(initialSha);

    // Stash should exist
    const stashList = await repo.git.stashList();
    expect(stashList.total).toBeGreaterThan(0);
  });
});
