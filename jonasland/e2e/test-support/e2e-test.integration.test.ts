import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const e2eProjectRoot = new URL("..", import.meta.url);
const runExplicitlyOnly = process.env.E2E_RUN_META === "true" ? it : it.skip;

describe("e2e test wrapper subprocess integration", () => {
  runExplicitlyOnly("records failed-test artifacts in a nested vitest run", async () => {
    const fixtureDir = await mkdtemp(
      join(e2eProjectRoot.pathname, "test-support/.tmp-e2e-test-subprocess-"),
    );
    const fixturePath = join(fixtureDir, "artifact-harness-subprocess.test.ts");
    const fixtureRelativePath = relative(e2eProjectRoot.pathname, fixturePath);

    await writeFile(
      fixturePath,
      [
        'import { describe } from "vitest";',
        'import { test } from "../e2e-test.ts";',
        "",
        'describe("artifact harness subprocess", () => {',
        '  test("records a failing test result", async ({ expect, e2e }) => {',
        "    console.log(`ARTIFACT_OUTPUT_DIR=${e2e.outputDir}`);",
        "    console.log(`ARTIFACT_OUTPUT_LOG=${e2e.outputLogPath}`);",
        "    console.log(`ARTIFACT_RESULT_PATH=${e2e.resultPath}`);",
        '    expect(e2e.outputDir).toContain("e2e-vitest-");',
        '    expect("intentional failure").toBe("different");',
        "  });",
        "});",
        "",
      ].join("\n"),
    );

    try {
      const nestedRun = await runNestedVitest({
        fixtureRelativePath,
      });

      expect(nestedRun.exitCode).toBe(1);

      const outputDir = readMarker({
        output: nestedRun.output,
        key: "ARTIFACT_OUTPUT_DIR",
      });
      const outputLogPath = readMarker({
        output: nestedRun.output,
        key: "ARTIFACT_OUTPUT_LOG",
      });
      const resultPath = readMarker({
        output: nestedRun.output,
        key: "ARTIFACT_RESULT_PATH",
      });

      expect(outputDir).toContain("e2e-vitest-");
      expect(outputLogPath).toContain("vitest-output.log");
      expect(resultPath).toContain("result.json");

      const [outputLog, resultBody] = await Promise.all([
        readFile(outputLogPath, "utf8"),
        readFile(resultPath, "utf8"),
      ]);
      const result = JSON.parse(resultBody) as {
        state: string;
        errorMessages: string[];
      };

      expect(result.state).toBe("failed");
      expect(result.errorMessages[0]).toContain("intentional failure");
      expect(outputLog).toContain("ARTIFACT_OUTPUT_DIR=");
      expect(outputLog).toContain("===== VITEST RESULT =====");
      expect(outputLog).toContain("state: failed");
      expect(outputLog).toContain("intentional failure");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

async function runNestedVitest(params: { fixtureRelativePath: string }) {
  try {
    const result = await execFile(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.config.ts", params.fixtureRelativePath],
      {
        cwd: e2eProjectRoot.pathname,
      },
    );
    return {
      exitCode: 0,
      output: `${result.stdout}\n${result.stderr}`,
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;

    const code = Reflect.get(error, "code");
    const stdout = Reflect.get(error, "stdout");
    const stderr = Reflect.get(error, "stderr");

    return {
      exitCode: typeof code === "number" ? code : 1,
      output: `${typeof stdout === "string" ? stdout : ""}\n${
        typeof stderr === "string" ? stderr : ""
      }`,
    };
  }
}

function readMarker(params: { output: string; key: string }) {
  const match = params.output.match(new RegExp(`^${params.key}=(.+)$`, "m"));
  expect(match?.[1], `missing ${params.key} in nested vitest output`).toBeTruthy();
  return match![1];
}
