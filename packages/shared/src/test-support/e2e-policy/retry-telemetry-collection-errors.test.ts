import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { TestTelemetryArtifact } from "../ci-telemetry.ts";

const CHILD_VITEST_MS = 30_000;

// Each row is one whole child Vitest run, bounded by its spawnSync timeout, so the row gets that
// bound too (Vitest's 5 s default is not one): CI took up to 2.2 s, a loaded 4-core machine more
// than 5 s (2026-09-24).
test.for([
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
])(
  "preserves a %s failure even when other tests pass",
  { timeout: CHILD_VITEST_MS },
  ([failure, source]) => {
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
    const result = spawnSync(
      process.execPath,
      [vitestBin, "run", "--config", "vitest.config.mjs"],
      {
        cwd: fixture.directory,
        encoding: "utf8",
        timeout: CHILD_VITEST_MS,
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
      },
    );
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
    expect(artifact.runners).toContainEqual(
      expect.objectContaining({ collectionErrors: [`${failure} failed`] }),
    );
  },
);
