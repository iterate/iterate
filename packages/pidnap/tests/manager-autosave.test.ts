import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("keeps numeric list/get targets consistent when manager is not running", async () => {
    const manager = new Manager(
      {
        cwd: testDir,
        state: { autosaveFile: autosavePath },
      },
      createMockLogger(),
    );

    await manager.updateProcessConfig({
      processSlug: "alpha",
      definition: longRunningProcess,
    });
    await manager.updateProcessConfig({
      processSlug: "beta",
      definition: longRunningProcess,
    });

    const listed = manager.listManagedProcessEntries();
    expect(listed[1]?.name).toBe("beta");
    expect(manager.getManagedProcessEntry(1)?.name).toBe("beta");
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

  it("persists autosave state on manager stop", async () => {
    const manager = new Manager(
      {
        cwd: testDir,
        state: { autosaveFile: autosavePath },
      },
      createMockLogger(),
    );
    await manager.start();

    await manager.updateProcessConfig({
      processSlug: "worker",
      definition: longRunningProcess,
    });

    const revisionBeforeStop = JSON.parse(readFileSync(autosavePath, "utf-8")).revision as number;
    await manager.stop();
    const revisionAfterStop = JSON.parse(readFileSync(autosavePath, "utf-8")).revision as number;

    expect(revisionAfterStop).toBeGreaterThan(revisionBeforeStop);
  });

  it("preserves base dependsOn and schedule when autosave overlays config entry", async () => {
    const baseConfig = {
      cwd: testDir,
      state: { autosaveFile: autosavePath },
      processes: [
        {
          name: "init",
          definition: longRunningProcess,
        },
        {
          name: "worker",
          definition: longRunningProcess,
          dependsOn: ["init"],
          schedule: { cron: "* * * * *", runOnStart: false },
        },
      ],
    };

    const manager = new Manager(baseConfig, createMockLogger());
    await manager.start();
    await manager.updateProcessConfig({
      processSlug: "worker",
      definition: successProcess,
    });
    await manager.stop();

    const managerAfterRestart = new Manager(baseConfig, createMockLogger());
    const restored = managerAfterRestart.getManagedProcessEntry("worker");

    expect(restored?.dependsOn).toEqual(["init"]);
    expect(restored?.schedule).toEqual({ cron: "* * * * *", runOnStart: false });
  });
});
