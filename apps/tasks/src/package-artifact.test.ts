import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test("the published package contains only the config bridge", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "iterate-tasks-package-"));
  await using _cleanup = {
    async [Symbol.asyncDispose]() {
      await rm(directory, { force: true, recursive: true });
    },
  };

  execFileSync(
    "pnpm",
    ["pack", "--config.ignore-scripts=true", "--pack-destination", directory],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );
  const archives = (await readdir(directory)).filter((file) => file.endsWith(".tgz"));
  expect(archives).toHaveLength(1);
  const archive = path.join(directory, archives[0]!);
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();

  expect(files).toEqual([
    "package/LICENSE",
    "package/README.md",
    "package/dist-package/config-bridge.d.ts",
    "package/dist-package/config-bridge.js",
    "package/package.json",
  ]);

  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
  );
  expect(packageJson).toMatchObject({
    exports: {
      ".": {
        default: "./dist-package/config-bridge.js",
        import: "./dist-package/config-bridge.js",
        types: "./dist-package/config-bridge.d.ts",
      },
    },
  });
  expect(packageJson).not.toHaveProperty("dependencies");
  expect(packageJson).not.toHaveProperty("peerDependencies");

  const javascript = execFileSync(
    "tar",
    ["-xOzf", archive, "package/dist-package/config-bridge.js"],
    { encoding: "utf8" },
  );
  expect(javascript).not.toContain("require(");
  // The one runtime import is provided by the config worker's environment
  // (RpcTarget for the itx.worker.tasks capability), same as the docs bridge.
  expect(javascript.match(/^import .*$/gm)).toEqual([
    'import { RpcTarget } from "cloudflare:workers";',
  ]);
});
