import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { cloudflarePreviewApps } from "./preview.ts";

test("both OS suites start after readiness and can run concurrently", async () => {
  await using run = await previewCommands({ smokeExit: 0, rolloutExit: 0, readinessOnly: false });
  const result = await run.result;
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(await run.events()).toEqual(
    expect.arrayContaining(["install", "smoke-ready", "rollout-ready", "playwright", "vitest"]),
  );
  expect(result.output).toContain("environment readiness finish:");
});

test.each([
  { smokeExit: 1, rolloutExit: 0 },
  { smokeExit: 0, rolloutExit: 1 },
])("neither suite starts when readiness fails: %j", async (failure) => {
  await using run = await previewCommands({ ...failure, readinessOnly: false });
  expect(await run.result).toMatchObject({ code: 1 });
  expect(await run.events()).not.toContain("playwright");
  expect(await run.events()).not.toContain("vitest");
});

test.each([0, 1])(
  "distributed preparation joins readiness and runs no tests (smoke exit %s)",
  async (smokeExit) => {
    await using run = await previewCommands({ smokeExit, rolloutExit: 0, readinessOnly: true });
    expect(await run.result).toMatchObject({ code: smokeExit });
    expect(await run.events()).toEqual(
      expect.arrayContaining(["smoke-ready", "rollout-ready", "tui"]),
    );
    expect(await run.events()).not.toContain("playwright");
    expect(await run.events()).not.toContain("vitest");
  },
);

// Run the actual preview shell against controllable command-line services.
// The test commands reject an early start and wait for each other, so a
// sequential implementation cannot pass either.
async function previewCommands(failure: {
  smokeExit: number;
  rolloutExit: number;
  readinessOnly: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), "os-suite-readiness-"));
  await mkdir(join(directory, "apps/os"), { recursive: true });
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "events"), "");
  await writeFile(
    join(directory, "bin/command.mjs"),
    `import { appendFileSync, existsSync, writeFileSync, watch } from "node:fs";
import { join, basename } from "node:path";
const directory = process.env.TEST_DIRECTORY;
const mark = (name) => {
  appendFileSync(join(directory, "events"), name + "\\n");
  writeFileSync(join(directory, name), "");
};
const wait = async (name) => {
  if (existsSync(join(directory, name))) return;
  await new Promise((resolve) => {
    const watcher = watch(directory, () => {
      if (existsSync(join(directory, name))) { watcher.close(); resolve(); }
    });
    if (existsSync(join(directory, name))) { watcher.close(); resolve(); }
  });
};
const command = process.argv.slice(2).join(" ");
if (basename(process.argv[1]) === "sleep") {
  await wait("install");
  // Model a rollout that finishes after browser installation. This timer is
  // the fake deployment service, not a timing assertion in the test.
  await new Promise((resolve) => setTimeout(resolve, 200));
  mark("rollout-ready");
  process.exit(Number(process.env.ROLLOUT_EXIT));
} else if (command.includes("install chromium")) {
  mark("install");
} else if (command.includes("agent-smoke.ts")) {
  await wait("rollout-ready");
  mark("smoke-ready");
  process.exit(Number(process.env.SMOKE_EXIT));
} else if (command.includes("tui-test/run.ts")) {
  mark("tui");
} else {
  const name = command.includes("e2e --project node") ? "vitest"
    : command.endsWith(" spec") ? "playwright" : null;
  if (!name) throw new Error("Unexpected command: " + command);
  mark(name);
  if (!existsSync(join(directory, "smoke-ready")) || !existsSync(join(directory, "rollout-ready"))) {
    throw new Error(name + " started before environment readiness");
  }
  await wait(name === "vitest" ? "playwright" : "vitest");
}
`,
  );
  for (const name of ["pnpm", "sleep"]) {
    // Use separate files so the fake sleep knows which service was invoked.
    await writeFile(
      join(directory, "bin", name),
      `#!${process.execPath}\n${await readFile(join(directory, "bin/command.mjs"), "utf8")}`,
      { mode: 0o755 },
    );
  }
  await writeFile(join(directory, "bin/timeout"), '#!/bin/sh\nshift\nexec "$@"\n', {
    mode: 0o755,
  });
  const script = cloudflarePreviewApps.os.previewTestCommandArgs[2]
    .replaceAll("/tmp/os-preview-", `${directory}/os-preview-`)
    .replaceAll(
      resolve(import.meta.dirname, "../../test-results/preview-summaries"),
      join(directory, "summaries"),
    );
  const child = spawn("bash", ["-c", script], {
    cwd: join(directory, "apps/os"),
    env: {
      ...process.env,
      PATH: `${directory}/bin:${process.env.PATH}`,
      TEST_DIRECTORY: directory,
      PREVIEW_OS_READINESS_ONLY: failure.readinessOnly ? "1" : "0",
      SMOKE_EXIT: String(failure.smokeExit),
      ROLLOUT_EXIT: String(failure.rolloutExit),
      PREVIEW_APP_ROLLOUT_REMAINING_SECONDS: "90",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  const terminate = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  // A broken scheduler could leave both fake test commands waiting forever.
  // Bound the entire process group, including its child commands.
  const watchdog = setTimeout(terminate, 4_000);
  child.on("close", () => clearTimeout(watchdog));
  return {
    result,
    events: async () => (await readFile(join(directory, "events"), "utf8")).trim().split("\n"),
    async [Symbol.asyncDispose]() {
      clearTimeout(watchdog);
      terminate();
      await result;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
