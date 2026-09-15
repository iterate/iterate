import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cloudflarePreviewApps } from "./preview.ts";

test("both OS suites run while smoke is still pending", async () => {
  await using run = await previewCommands({ smokeExit: 0, installExit: 0 });
  const result = await run.result;
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(await run.events()).toEqual(
    expect.arrayContaining(["install", "smoke-ready", "playwright", "vitest"]),
  );
  expect(result.output).not.toContain("rollout-settle");
});

test("smoke failure still fails the run after both suites execute", async () => {
  await using run = await previewCommands({ smokeExit: 1, installExit: 0 });
  expect(await run.result).toMatchObject({ code: 1 });
  expect(await run.events()).toEqual(expect.arrayContaining(["playwright", "vitest"]));
});

test("browser installation failure does not block Vitest or smoke", async () => {
  await using run = await previewCommands({ smokeExit: 0, installExit: 1 });
  expect(await run.result).toMatchObject({ code: 1 });
  expect(await run.events()).not.toContain("playwright");
  expect(await run.events()).toEqual(expect.arrayContaining(["vitest", "smoke-ready"]));
});

// Run the actual preview shell against controllable command-line services.
// The test commands reject an early start and wait for each other, so a
// sequential implementation cannot pass either.
async function previewCommands(failure: { smokeExit: number; installExit: number }) {
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
if (command.includes("install chromium")) {
  mark("install");
  process.exit(Number(process.env.INSTALL_EXIT));
} else if (command.includes("agent-smoke.ts")) {
  await wait("vitest");
  if (process.env.INSTALL_EXIT === "0") await wait("playwright");
  mark("smoke-ready");
  process.exit(Number(process.env.SMOKE_EXIT));
} else if (command.includes("project-creation-traces.ts")) {
  mark("trace-lookup");
} else if (command.includes("tui-test/run.ts")) {
  mark("tui");
} else {
  const name = command.includes("e2e --project node") ? "vitest"
    : command.endsWith(" spec") ? "playwright" : null;
  if (!name) throw new Error("Unexpected command: " + command);
  mark(name);
  if (name === "playwright" && !existsSync(join(directory, "install"))) {
    throw new Error("browser started before installation");
  }
  await wait("smoke-ready");
}
`,
  );
  for (const name of ["pnpm"]) {
    // Put the controllable CLI ahead of the real package manager on PATH.
    await writeFile(
      join(directory, "bin", name),
      `#!${process.execPath}\n${await readFile(join(directory, "bin/command.mjs"), "utf8")}`,
      { mode: 0o755 },
    );
  }
  await writeFile(join(directory, "bin/timeout"), '#!/bin/sh\nshift\nexec "$@"\n', {
    mode: 0o755,
  });
  const script = cloudflarePreviewApps.os.previewTestCommandArgs[2].replaceAll(
    "/tmp/os-preview-",
    `${directory}/os-preview-`,
  );
  const child = spawn("bash", ["-c", script], {
    cwd: join(directory, "apps/os"),
    env: {
      ...process.env,
      PATH: `${directory}/bin:${process.env.PATH}`,
      TEST_DIRECTORY: directory,
      SMOKE_EXIT: String(failure.smokeExit),
      INSTALL_EXIT: String(failure.installExit),
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
