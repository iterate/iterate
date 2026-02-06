/**
 * Docker provider-specific host sync integration tests.
 *
 * These tests require host mounts and therefore only apply to the Docker provider.
 */

import { execSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import {
  test,
  ITERATE_REPO_PATH_ON_HOST,
  ITERATE_REPO_PATH,
  RUN_SANDBOX_TESTS,
  TEST_CONFIG,
  getGitInfo,
  withSandbox,
  withWorktree,
} from "../../test/helpers.ts";

describe
  .runIf(RUN_SANDBOX_TESTS && TEST_CONFIG.provider === "docker")
  .concurrent("Docker Host Sync", () => {
    test.scoped({
      envOverrides: {
        DOCKER_SYNC_FROM_HOST_REPO: "true",
        DOCKER_GIT_REPO_ROOT: ITERATE_REPO_PATH_ON_HOST,
      },
      sandboxOptions: {
        id: "host-sync-test",
        name: "Host Sync Test",
        envVars: {},
        providerOptions: {
          docker: { entrypointArguments: ["sleep", "infinity"] },
        },
      },
    });

    test("git state matches host", async ({ sandbox, expect }) => {
      const gitInfo = getGitInfo(ITERATE_REPO_PATH_ON_HOST);
      expect(gitInfo).toBeDefined();

      await expect
        .poll(
          async () =>
            (
              await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "branch", "--show-current"])
            ).trim(),
          { timeout: 30_000, interval: 500 },
        )
        .toBe(gitInfo!.branch ?? "");

      await expect
        .poll(
          async () =>
            (await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "rev-parse", "HEAD"])).trim(),
          { timeout: 30_000, interval: 500 },
        )
        .toBe(gitInfo!.commit);
    }, 40000);
  });

describe.runIf(RUN_SANDBOX_TESTS && TEST_CONFIG.provider === "docker")(
  "Docker Worktree Sync",
  () => {
    test.concurrent(
      "container git state matches host worktree exactly",
      async ({ expect }) => {
        await withWorktree(ITERATE_REPO_PATH_ON_HOST, async (worktree) => {
          writeFileSync(join(worktree.path, "staged-new.txt"), "staged content");
          execSync("git add staged-new.txt", { cwd: worktree.path });
          appendFileSync(join(worktree.path, "README.md"), "\n# test modification");
          writeFileSync(join(worktree.path, "untracked.txt"), "untracked content");

          const hostGitState = execSync(
            "git branch --show-current; git rev-parse HEAD; git status --porcelain",
            { cwd: worktree.path, encoding: "utf-8" },
          ).trim();

          await withSandbox(
            { DOCKER_GIT_REPO_ROOT: worktree.path, DOCKER_SYNC_FROM_HOST_REPO: "true" },
            {
              id: "worktree-test",
              name: "Worktree Test",
              envVars: {},
              providerOptions: {
                docker: { entrypointArguments: ["sleep", "infinity"] },
              },
            },
            async (sandbox) => {
              await expect
                .poll(
                  async () =>
                    (
                      await sandbox.exec([
                        "bash",
                        "-c",
                        `cd ${ITERATE_REPO_PATH} && git branch --show-current; git rev-parse HEAD; git status --porcelain`,
                      ])
                    ).trim(),
                  { timeout: 30_000, interval: 500 },
                )
                .toBe(hostGitState);
            },
          );
        });
      },
      45000,
    );
  },
);
