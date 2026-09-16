import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("the shell hook preserves failures and does not double-count nested bash", async () => {
  const result = await promisify(execFile)("bash", ["-c", "bash -c 'echo nested'; exit 7"], {
    env: {
      ...process.env,
      BASH_ENV: resolve("ci/trace-shell.sh"),
      GITHUB_ACTION: "install_dependencies",
    },
  }).catch((error) => error);
  expect(result.code).toBe(7);
  const events = markers(result.stdout);
  expect(events).toMatchObject([
    { kind: "shell-start", step: "install_dependencies" },
    { kind: "shell-end", exitCode: 7 },
  ]);
  expect(events[1].time).toBeGreaterThanOrEqual(events[0].time);
});

test("a real Playwright retry emits both attempts without exception payloads", async () => {
  const directory = await mkdtemp(resolve("../.ci-trace-test-ignoreme-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
  await writeFile(
    `${directory}/playwright.config.ts`,
    `export default { retries: 1, workers: 1, outputDir: ${JSON.stringify(`${directory}/output`)}, reporter: [[${JSON.stringify(resolve("ci/trace-reporter.ts"))}]] };`,
  );
  await writeFile(
    `${directory}/retry.spec.ts`,
    `import { test, expect } from '@playwright/test'; test('a quiet retry', () => { expect(test.info().retry, 'secret exception payload').toBe(1); });`,
  );
  const { stdout } = await promisify(execFile)(
    "pnpm",
    ["exec", "playwright", "test", "--config", `${directory}/playwright.config.ts`],
    {
      cwd: resolve(".."),
      env: { ...process.env, CI_TRACE_ENABLED: "1", CI_TRACE_SHELL: "" },
    },
  );
  const events = markers(stdout);
  expect(events).toMatchObject([
    { kind: "test-start", retry: 0, title: "a quiet retry" },
    { kind: "test-end", status: "failed" },
    { kind: "test-start", retry: 1, title: "a quiet retry" },
    { kind: "test-end", status: "passed" },
  ]);
  expect(events[0].id).not.toBe(events[2].id);
  expect(JSON.stringify(events)).not.toContain("secret exception payload");
});

function markers(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("@@ci-trace "))
    .map((line) => JSON.parse(line.slice(11)));
}
