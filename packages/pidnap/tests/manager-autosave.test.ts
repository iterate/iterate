import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Manager } from "../src/manager.ts";
import { createMockLogger, longRunningProcess, successProcess, wait } from "./test-utils.ts";

describe("Manager autosave state", () => {
  const testDir = join(import.meta.dirname, ".temp/manager-autosave");
  const autosavePath = join(testDir, ".pidnap", "autosave.json");

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("fails fast when autosave file is corrupt", () => {
    mkdirSync(join(testDir, ".pidnap"), { recursive: true });
    writeFileSync(autosavePath, "{invalid json", "utf-8");

    expect(
      () =>
        new Manager(
          {
            cwd: testDir,
            state: { autosaveFile: autosavePath },
          },
          createMockLogger(),
        ),
    ).toThrow(/autosave state/i);
  });

  it("restores durable upserts across manager restarts", async () => {
    const manager = new Manager(
      {
        cwd: testDir,
        state: { autosaveFile: autosavePath },
      },
      createMockLogger(),
    );
    await manager.start();

    await manager.updateProcessConfig({
      processSlug: "opencode",
      definition: longRunningProcess,
      persistence: "durable",
      desiredState: "running",
    });

    await manager.stop();

    const managerAfterRestart = new Manager(
      {
        cwd: testDir,
        state: { autosaveFile: autosavePath },
      },
      createMockLogger(),
    );
    await managerAfterRestart.start();

    const restored = managerAfterRestart.getManagedProcessEntry("opencode");
    expect(restored?.source).toBe("overlay");
    expect(restored?.persistence).toBe("durable");
    expect(restored?.desiredState).toBe("running");
    expect(managerAfterRestart.getProcessByTarget("opencode")).toBeDefined();

    await managerAfterRestart.stop();
  });

  it("does not persist deletions of config-defined processes", async () => {
    const manager = new Manager(
      {
        cwd: testDir,
        state: { autosaveFile: autosavePath },
        processes: [
          {
            name: "daemon-backend",
            definition: longRunningProcess,
          },
        ],
      },
      createMockLogger(),
    );
    await manager.start();

    await manager.deleteProcessBySlug("daemon-backend");
    await manager.stop();

    const managerAfterRestart = new Manager(
      {
        cwd: testDir,
        state: { autosaveFile: autosavePath },
        processes: [
          {
            name: "daemon-backend",
            definition: longRunningProcess,
          },
        ],
      },
      createMockLogger(),
    );
    await managerAfterRestart.start();

    const restored = managerAfterRestart.getManagedProcessEntry("daemon-backend");
    expect(restored).toBeDefined();
    expect(restored?.source).toBe("config");
    expect(managerAfterRestart.getProcessByTarget("daemon-backend")).toBeDefined();

    await managerAfterRestart.stop();
  });

  it("updates definition without changing desired state when restartImmediately=false", async () => {
    const manager = new Manager(
      {
        cwd: testDir,
        state: { autosaveFile: autosavePath },
        processes: [
          {
            name: "daemon-backend",
            definition: longRunningProcess,
          },
        ],
      },
      createMockLogger(),
    );
    await manager.start();
    await wait(100);

    await manager.updateProcessConfig({
      processSlug: "daemon-backend",
      definition: successProcess,
      restartImmediately: false,
    });

    const proc = manager.getProcessByTarget("daemon-backend");
    const entry = manager.getManagedProcessEntry("daemon-backend");
    expect(proc?.state).toBe("running");
    expect(entry?.desiredState).toBe("running");

    await manager.stop();
  });
});
