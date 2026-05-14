import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { runClaudeChild, signalExitCode } from "./claude-mcp.ts";

describe("claude-mcp", () => {
  it("maps Claude SIGINT to the conventional interrupted process exit code", async () => {
    const child = fakeChildProcess();
    const spawnChild = vi.fn(() => child);

    const resultPromise = runClaudeChild({
      args: ["describe tools"],
      env: {},
      signal: undefined,
      spawnChild,
    });

    child.emit("close", null, "SIGINT");

    await expect(resultPromise).resolves.toEqual({
      type: "signal",
      exitCode: 130,
      signal: "SIGINT",
    });
    expect(spawnChild).toHaveBeenCalledWith("claude", ["describe tools"], {
      env: {},
      stdio: "inherit",
    });
  });

  it("forwards aborts to Claude before resolving", async () => {
    const child = fakeChildProcess();
    const spawnChild = vi.fn(() => child);
    const controller = new AbortController();

    const resultPromise = runClaudeChild({
      args: [],
      env: {},
      signal: controller.signal,
      spawnChild,
    });

    controller.abort();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null, "SIGTERM");

    await expect(resultPromise).resolves.toEqual({
      type: "signal",
      exitCode: 143,
      signal: "SIGTERM",
    });
  });

  it("uses shell-compatible signal exit codes", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });
});

function fakeChildProcess() {
  const child = new EventEmitter() as ChildProcess;
  let killed = false;

  Object.defineProperty(child, "killed", {
    get: () => killed,
  });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });

  return child;
}
