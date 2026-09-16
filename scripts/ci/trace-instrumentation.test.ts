import { execFile } from "node:child_process";
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

test("reporter lifecycle records retain both retry attempts without exception payloads", async () => {
  // Exercise the public reporter interface in its own process: no global console
  // mocks, and no nested test runner competing with the monorepo's worker pool.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import Reporter from ${JSON.stringify(new URL("./trace-reporter.ts", import.meta.url).href)};
        const reporter = new Reporter();
        const test = { id: "greets", repeatEachIndex: 0, title: "a quiet retry",
          location: { file: process.cwd() + "/specs/greeting.spec.ts", line: 1 },
          parent: { project: () => ({ name: "web" }) }, expectedStatus: "passed" };
        for (const retry of [0, 1]) {
          const result = { retry, startTime: new Date(), duration: 20, workerIndex: retry,
            status: retry ? "passed" : "failed", errors: [{ message: "secret exception payload" }] };
          reporter.onTestBegin(test, result);
          reporter.onTestEnd(test, result);
        }
      `,
    ],
    {
      cwd: resolve(".."),
      env: { ...process.env, CI_TRACE_ENABLED: "1" },
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
