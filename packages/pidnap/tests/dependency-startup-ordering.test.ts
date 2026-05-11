/**
 * Tests that dependsOn actually delays dependent process startup until the
 * dependency is truly ready — not just queued to start.
 *
 * Bug: RestartingProcess.startProcess() sets _hasStarted=true and
 * setState("running") SYNCHRONOUSLY, before the OS process is spawned.
 * State listeners fire immediately, the manager sees dependencies as met,
 * and starts dependents on the same tick. This means dependsOn is a no-op
 * for the "started" and "healthy" conditions.
 *
 * Real-world impact: archil-mount.sh restores sqlite snapshots before
 * signaling ready, but opencode starts before the restore because pidnap
 * considers archil-mount "started" the instant start() is called.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RestartingProcess } from "../src/restarting-process.ts";
import { Manager } from "../src/manager.ts";
import type { Logger } from "../src/logger.ts";
import { createMockLogger, longRunningProcess } from "./test-utils.ts";

const POLL_TIMEOUT_MS = 5000;

describe("dependency startup ordering", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("RestartingProcess", () => {
    it("hasStarted is false until the process is actually spawned", async () => {
      const proc = new RestartingProcess(
        "test",
        longRunningProcess,
        { restartPolicy: "always" },
        mockLogger,
      );

      proc.start();

      // Bug: hasStarted is immediately true before the OS process exists.
      // Fix: hasStarted should be false until lazyProcess.start() completes.
      expect(proc.hasStarted).toBe(false);

      // Eventually becomes true after the process spawns
      await expect.poll(() => proc.hasStarted, { timeout: POLL_TIMEOUT_MS }).toBe(true);
      expect(proc.state).toBe("running");

      await proc.stop();
    });

    it("isHealthy is false until the process is actually spawned", async () => {
      const proc = new RestartingProcess(
        "test",
        longRunningProcess,
        { restartPolicy: "always" },
        mockLogger,
      );

      proc.start();

      // Bug: isHealthy is immediately true because state is set to "running" synchronously.
      // Fix: isHealthy should require the process to have actually spawned.
      expect(proc.isHealthy).toBe(false);

      await expect.poll(() => proc.isHealthy, { timeout: POLL_TIMEOUT_MS }).toBe(true);

      await proc.stop();
    });
  });

  describe("Manager", () => {
    let manager: Manager;
    let tempDir: string;

    beforeEach(async () => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      tempDir = mkdtempSync(join(tmpdir(), "pidnap-dep-order-test-"));
    });

    afterEach(async () => {
      if (manager) {
        await manager.stop();
      }
      const { rmSync } = await import("node:fs");
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("dependent process stays idle until dependency has actually spawned", async () => {
      const logger = createMockLogger();
      manager = new Manager(
        {
          logDir: tempDir,
          processes: [
            {
              name: "dependency",
              definition: longRunningProcess,
              options: { restartPolicy: "always" },
            },
            {
              name: "dependent",
              definition: longRunningProcess,
              options: { restartPolicy: "always" },
              dependsOn: ["dependency"],
            },
          ],
        },
        logger,
      );

      await manager.start();

      // The dependent should NOT be running yet if the dependency
      // hasn't actually spawned. With the bug, both start on the same
      // synchronous tick so the dependent is already "running" here.
      // The fix ensures the dependent waits.
      const dependent = manager.getProcessByTarget("dependent");

      // Give the dependency a moment to actually spawn
      const dependency = manager.getProcessByTarget("dependency");
      await expect.poll(() => dependency?.hasStarted, { timeout: POLL_TIMEOUT_MS }).toBe(true);

      // NOW the dependent should start (after dependency actually spawned)
      await expect.poll(() => dependent?.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");
    });

    it("gate pattern: dependent waits for gate process to exit (completed condition)", async () => {
      const releasePath = join(tempDir, "gate-release.txt");
      const logger = createMockLogger();
      manager = new Manager(
        {
          logDir: tempDir,
          processes: [
            {
              // Use an explicit release file instead of a timer-based process.
              // The previous timed gate was correct in isolation but flaky under the
              // root parallel workspace run because a short-lived 500ms child can be
              // delayed by test-worker load. This keeps the test focused on the
              // "completed" dependency condition: the worker must remain idle until
              // the gate has actually exited 0, and the test controls exactly when
              // that exit happens.
              name: "gate",
              definition: {
                command: "node",
                args: [
                  "-e",
                  `const { existsSync } = require("node:fs");
const releasePath = ${JSON.stringify(releasePath)};
const interval = setInterval(() => {
  if (!existsSync(releasePath)) return;
  clearInterval(interval);
  process.exit(0);
}, 25);`,
                ],
              },
              options: { restartPolicy: "never" },
            },
            {
              name: "worker",
              definition: longRunningProcess,
              options: { restartPolicy: "always" },
              dependsOn: ["gate"],
            },
          ],
        },
        logger,
      );

      await manager.start();

      const worker = manager.getProcessByTarget("worker");
      const gate = manager.getProcessByTarget("gate");

      // Worker should be idle while the gate is still running
      expect(worker?.state).toBe("idle");

      // Release the gate and let it complete successfully.
      writeFileSync(releasePath, "go");

      // Wait for gate to complete
      await expect.poll(() => gate?.state, { timeout: POLL_TIMEOUT_MS }).toBe("stopped");

      // Now worker should start
      await expect.poll(() => worker?.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");
    });

    it("does not double-start when sentinel file already exists at startup", async () => {
      const sentinelPath = join(tempDir, "ready.txt");
      writeFileSync(sentinelPath, "ready");

      const logger = createMockLogger();
      manager = new Manager(
        {
          logDir: tempDir,
          processes: [
            {
              name: "worker",
              definition: longRunningProcess,
              options: { restartPolicy: "always" },
              dependsOn: [{ type: "sentinel", path: sentinelPath }],
            },
          ],
        },
        logger,
      );

      // Before the fix, start() would call startSentinelWatchersForProcess
      // which synchronously fires onMet → tryStartProcessAfterDeps → proc.start(),
      // then the startup loop would also call proc.start() → throw.
      await manager.start();

      const worker = manager.getProcessByTarget("worker");
      await expect.poll(() => worker?.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");
    });

    it("updateProcessConfig does not double-start when sentinel file already exists", async () => {
      const sentinelPath = join(tempDir, "ready.txt");
      writeFileSync(sentinelPath, "ready");

      const logger = createMockLogger();
      manager = new Manager(
        {
          logDir: tempDir,
          processes: [
            // Pre-declare with sentinel dep; will be updated at runtime
            {
              name: "worker",
              definition: longRunningProcess,
              options: { restartPolicy: "always" },
              desiredState: "stopped",
              dependsOn: [{ type: "sentinel", path: sentinelPath }],
            },
          ],
        },
        logger,
      );

      await manager.start();

      // Now update the process to running via updateProcessConfig.
      // The entry already has dependsOn from the constructor config.
      await manager.updateProcessConfig({
        processSlug: "worker",
        definition: longRunningProcess,
        options: { restartPolicy: "always" },
        desiredState: "running",
      });

      const worker = manager.getProcessByTarget("worker");
      await expect.poll(() => worker?.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");
    });
  });
});
