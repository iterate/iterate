import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localTest as test, describe, expect } from "../fixtures.ts";
import { getLocalDockerGitInfo } from "../helpers/local-docker-utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../../..");
const CONTAINER_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";

describe("Container Setup", () => {
  test("agent CLIs installed and working", async ({ sandbox }) => {
    const opencode = await sandbox.exec(["opencode", "--version"]);
    expect(opencode).toMatch(/\d+\.\d+\.\d+/);

    const claude = await sandbox.exec(["claude", "--version"]);
    expect(claude).toMatch(/\d+\.\d+\.\d+/);

    const pi = await sandbox.exec(["pi", "--version"]);
    expect(pi).toMatch(/\d+\.\d+\.\d+/);
  });

  test("git operations work and state matches host", async ({ sandbox, provider }) => {
    const gitLog = await sandbox.exec(["git", "-C", CONTAINER_REPO_PATH, "log", "--oneline", "-1"]);
    expect(gitLog).toBeTruthy();

    if (provider.name === "local-docker") {
      const gitInfo = getLocalDockerGitInfo(REPO_ROOT);
      expect(gitInfo).toBeDefined();

      const containerCommit = (
        await sandbox.exec(["git", "-C", CONTAINER_REPO_PATH, "rev-parse", "HEAD"])
      ).trim();
      expect(containerCommit).toBe(gitInfo!.commit);
    }
  });

  test("sandbox can be restarted", async ({ sandbox }) => {
    const pidBefore = await sandbox.exec(["cat", "/var/run/pidnap.pid"]);

    await sandbox.restart();
    await sandbox.waitForServiceHealthy("iterate-daemon");

    const pidAfter = await sandbox.exec(["cat", "/var/run/pidnap.pid"]);
    expect(pidAfter).not.toBe(pidBefore);
  });
});
