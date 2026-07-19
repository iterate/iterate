import { describe, expect, test } from "vitest";

import { runCommand } from "./run-command.ts";

describe("runCommand", () => {
  test("does not wait for a detached descendant that inherited its output pipes", async () => {
    const startedAt = performance.now();
    const result = await runCommand({
      args: [
        "--input-type=module",
        "--eval",
        [
          'import { spawn } from "node:child_process";',
          "const descendant = spawn(process.execPath,",
          '  ["--input-type=module", "--eval", "setTimeout(() => {}, 5_000)"],',
          '  { stdio: ["ignore", "inherit", "inherit"] },',
          ");",
          "descendant.unref();",
          'console.log("parent finished");',
        ].join("\n"),
      ],
      command: process.execPath,
      echoOutput: false,
      environment: process.env,
      workingDirectory: process.cwd(),
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "parent finished\n" });
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
