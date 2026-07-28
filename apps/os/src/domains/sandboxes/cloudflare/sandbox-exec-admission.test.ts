import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  cancelSandboxExecAdmissionCommand,
  guardSandboxExecAdmission,
  sandboxProcessGroupCleanupCommand,
  waitForSandboxExecAdmission,
} from "./sandbox-exec-admission.ts";

const execFileAsync = promisify(execFile);

describe("sandbox exec admission shell guard", () => {
  it("does not enter user code when cancellation arrived first", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-exec-admission-"));
    const guardDirectory = join(root, "guard");
    const marker = join(root, "user-code-ran");
    try {
      await mkdir(guardDirectory);
      await writeFile(join(guardDirectory, "cancelled"), "");

      await expect(
        execFileAsync("/bin/sh", [
          "-c",
          guardSandboxExecAdmission(`printf ran > ${shellSingleQuote(marker)}`, guardDirectory),
        ]),
      ).rejects.toMatchObject({ code: 125 });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(Number(await readFile(join(guardDirectory, "process-group"), "utf8"))).toBeGreaterThan(
        1,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("records its process group and removes the guard after normal completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-exec-admission-"));
    const guardDirectory = join(root, "guard-with-'quote");
    const marker = join(root, "user-code-ran");
    try {
      await execFileAsync("/bin/sh", [
        "-c",
        guardSandboxExecAdmission(
          [
            'test -s "$__iterate_exec_guard/process-group"',
            `printf ran > ${shellSingleQuote(marker)}`,
          ].join("\n"),
          guardDirectory,
        ),
      ]);

      await expect(readFile(marker, "utf8")).resolves.toBe("ran");
      await expect(access(guardDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("installs a persistent tombstone when admission has not started", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-exec-admission-"));
    const guardDirectory = join(root, "guard");
    try {
      await execFileAsync("/bin/sh", ["-c", cancelSandboxExecAdmissionCommand(guardDirectory, 0)]);

      await expect(readFile(join(guardDirectory, "cancelled"), "utf8")).resolves.toBe("");
      await expect(access(join(guardDirectory, "process-group"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses malformed process-group state without issuing a signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-exec-admission-"));
    const guardDirectory = join(root, "guard");
    try {
      await mkdir(guardDirectory);
      await writeFile(join(guardDirectory, "process-group"), "not-a-process-group");

      await expect(
        execFileAsync("/bin/sh", ["-c", cancelSandboxExecAdmissionCommand(guardDirectory, 0)]),
      ).rejects.toMatchObject({
        code: 70,
        stderr: expect.stringContaining("invalid guarded sandbox process group"),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses an unsafe cleanup target before constructing shell", () => {
    expect(() => sandboxProcessGroupCleanupCommand(1)).toThrow(
      "Invalid sandbox process-group id: 1",
    );
  });
});

describe("waitForSandboxExecAdmission", () => {
  it("returns the process group announced before the deadline", async () => {
    await expect(
      waitForSandboxExecAdmission({
        admission: Promise.resolve(42),
        deadlineAt: 1_100,
        now: () => 1_000,
      }),
    ).resolves.toEqual({ kind: "started", processGroupId: 42 });
  });

  it("preserves an admission failure instead of classifying it as a timeout", async () => {
    const failure = new Error("stream failed before start");
    await expect(
      waitForSandboxExecAdmission({
        admission: Promise.reject(failure),
        deadlineAt: 1_100,
        now: () => 1_000,
      }),
    ).rejects.toBe(failure);
  });

  it("returns at the deadline while continuing to observe late admission", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let rejectLate: ((error: Error) => void) | undefined;
      const admission = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });
      const outcome = waitForSandboxExecAdmission({
        admission,
        deadlineAt: 1_100,
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(outcome).resolves.toEqual({ kind: "deadline" });

      rejectLate?.(new Error("transport failed after cancellation began"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
