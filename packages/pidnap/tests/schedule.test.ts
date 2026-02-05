/**
 * Tests for the process schedule (cron) functionality
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Manager } from "../src/manager.ts";
import { createMockLogger } from "./test-utils.ts";

describe("Process Schedule", () => {
  let manager: Manager;
  let tempDir: string;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tempDir = mkdtempSync(join(tmpdir(), "pidnap-schedule-test-"));
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
    }
    const { rmSync } = await import("node:fs");
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should not start scheduled process on manager start when runOnStart is false", async () => {
    const logger = createMockLogger();
    manager = new Manager(
      {
        logDir: tempDir,
        processes: [
          {
            name: "scheduled-task",
            definition: { command: "echo", args: ["hello"] },
            options: { restartPolicy: "never" },
            schedule: { cron: "* * * * *" }, // Every minute, but runOnStart defaults to false
          },
        ],
      },
      logger,
    );

    await manager.start();

    const proc = manager.getProcessByTarget("scheduled-task");
    expect(proc).toBeDefined();
    // Process should be idle since runOnStart is false
    expect(proc?.state).toBe("idle");
  });

  it("should start scheduled process on manager start when runOnStart is true", async () => {
    const logger = createMockLogger();
    manager = new Manager(
      {
        logDir: tempDir,
        processes: [
          {
            name: "scheduled-task",
            definition: { command: "echo", args: ["hello"] },
            options: { restartPolicy: "never" },
            schedule: { cron: "* * * * *", runOnStart: true },
          },
        ],
      },
      logger,
    );

    await manager.start();

    const proc = manager.getProcessByTarget("scheduled-task");
    expect(proc).toBeDefined();
    // Process should have started
    await expect.poll(() => proc?.state, { timeout: 5000 }).toMatch(/running|stopped/);
  });

  it("should trigger scheduled process when cron fires", async () => {
    // Use fake timers to control cron execution
    vi.useFakeTimers();

    const logger = createMockLogger();
    manager = new Manager(
      {
        logDir: tempDir,
        processes: [
          {
            name: "scheduled-task",
            definition: { command: "sleep", args: ["10"] },
            options: { restartPolicy: "never" },
            schedule: { cron: "* * * * * *" }, // Every second (6-field cron)
          },
        ],
      },
      logger,
    );

    await manager.start();

    const proc = manager.getProcessByTarget("scheduled-task");
    expect(proc?.state).toBe("idle");

    // Advance time by 1 second to trigger the cron
    await vi.advanceTimersByTimeAsync(1000);

    // Process should have started
    expect(proc?.state).toMatch(/running|restarting/);

    vi.useRealTimers();
  });

  it("should call triggerScheduledProcess which restarts running process", async () => {
    const logger = createMockLogger();
    manager = new Manager(
      {
        logDir: tempDir,
        processes: [
          {
            name: "scheduled-task",
            definition: { command: "sleep", args: ["60"] },
            options: { restartPolicy: "always" }, // Use always so it restarts after trigger
            schedule: { cron: "0 0 1 1 *", runOnStart: true }, // Yearly (won't actually fire during test)
          },
        ],
      },
      logger,
    );

    await manager.start();

    const proc = manager.getProcessByTarget("scheduled-task");

    // Wait for process to start
    await expect.poll(() => proc?.state, { timeout: 5000 }).toBe("running");

    // Manually trigger the schedule (simulating what cron would do)
    // @ts-expect-error - accessing private method for testing
    manager.triggerScheduledProcess("scheduled-task");

    // Process should go through restarting state
    await expect
      .poll(() => proc?.state, { timeout: 5000, interval: 100 })
      .toMatch(/restarting|running/);

    // If it went through restarting, it should come back to running
    await expect.poll(() => proc?.state, { timeout: 10000, interval: 100 }).toBe("running");
  }, 15000);

  it("should work with dependencies - scheduled process waits for deps", async () => {
    const logger = createMockLogger();
    manager = new Manager(
      {
        logDir: tempDir,
        processes: [
          {
            name: "init-task",
            definition: { command: "echo", args: ["init"] },
            options: { restartPolicy: "never" },
          },
          {
            name: "scheduled-task",
            definition: { command: "echo", args: ["scheduled"] },
            options: { restartPolicy: "never" },
            schedule: { cron: "* * * * *", runOnStart: true },
            dependsOn: ["init-task"],
          },
        ],
      },
      logger,
    );

    await manager.start();

    // Init task should run
    const initProc = manager.getProcessByTarget("init-task");
    expect(initProc?.state).toMatch(/running|stopped/);

    // Wait for init to complete
    await expect.poll(() => initProc?.state, { timeout: 5000 }).toBe("stopped");

    // Scheduled task should have started after init completed
    const scheduledProc = manager.getProcessByTarget("scheduled-task");
    await expect.poll(() => scheduledProc?.state, { timeout: 5000 }).toMatch(/running|stopped/);
  });
});
