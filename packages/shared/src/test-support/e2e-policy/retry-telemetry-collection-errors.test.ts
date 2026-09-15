import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { TestTelemetryArtifact } from "../ci-telemetry.ts";

test.each([
  ["module import", 'throw new Error("module import failed");'],
  [
    "nested suite teardown",
    `describe("outer", () => {
      describe("inner", () => {
        afterAll(() => { throw new Error("nested suite teardown failed"); });
        test("body passes before teardown", () => {});
      });
    });`,
  ],
])("preserves a %s failure even when other tests pass", (failure, source) => {
  using fixture = {
    directory: mkdtempSync(join(tmpdir(), "vitest-collection-errors-")),
    [Symbol.dispose]() {
      rmSync(this.directory, { recursive: true, force: true });
    },
  };
  const reporter = fileURLToPath(new URL("./retry-telemetry-reporter.ts", import.meta.url));
  writeFileSync(join(fixture.directory, "passing.test.js"), 'test("unrelated pass", () => {});');
  writeFileSync(join(fixture.directory, "broken.test.js"), source);
  writeFileSync(
    join(fixture.directory, "vitest.config.mjs"),
    `export default ${JSON.stringify({
      test: { globals: true, include: ["*.test.js"], reporters: [reporter] },
    })};`,
  );
  const require = createRequire(import.meta.url);
  const vitestBin = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const artifactDirectory = join(fixture.directory, "telemetry");
  const result = spawnSync(process.execPath, [vitestBin, "run", "--config", "vitest.config.mjs"], {
    cwd: fixture.directory,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      // Child-run failures belong only to this fixture, never the outer CI run.
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("VITEST") &&
            !key.startsWith("TEST_TELEMETRY_") &&
            key !== "GITHUB_WORKSPACE" &&
            key !== "TEST",
        ),
      ),
      TEST_TELEMETRY_ARTIFACT_DIR: artifactDirectory,
      FLAKE_RECORD_DIR: join(fixture.directory, "flakes"),
    },
  });
  expect(result, result.stderr).toMatchObject({ status: 1 });
  const files = readdirSync(artifactDirectory);
  expect(files).toHaveLength(1);
  const artifact = TestTelemetryArtifact.parse(
    JSON.parse(readFileSync(join(artifactDirectory, files[0]!), "utf8")),
  );
  expect(artifact.tests).toContainEqual(
    expect.objectContaining({ fullName: "unrelated pass", state: "passed" }),
  );
  expect(artifact.run).toMatchObject({
    status: "failed",
    error: { message: `${failure} failed` },
  });
  // iterate-lint-disable-next-line terminology/no-metaphorical-lane-door-seam -- existing test telemetry wire field
  expect(artifact.lanes).toContainEqual(
    expect.objectContaining({ collectionErrors: [`${failure} failed`] }),
  );
});
