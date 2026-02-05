import { describe, it, expect, beforeEach } from "vitest";
import { Manager, type ManagerConfig } from "../src/manager.ts";
import type { Logger } from "../src/logger.ts";
import { createMockLogger, wait, successProcess, longRunningProcess } from "./test-utils.ts";

describe("Manager - Reload & Remove", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("reloadProcessByTarget()", () => {
    it("should reload process with new definition by name", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "test-proc",
            definition: successProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();

      // Wait for initial process to complete
      await expect.poll(() => manager.getProcessByTarget("test-proc")?.state).toBe("stopped");
      const proc = manager.getProcessByTarget("test-proc");
      expect(proc).toBeDefined();
      expect(proc?.state).toBe("stopped");

      // Reload with long-running process
      await manager.reloadProcessByTarget("test-proc", longRunningProcess);
      await wait(150);

      const reloadedProc = manager.getProcessByTarget("test-proc");
      expect(reloadedProc?.state).toBe("running");

      await manager.stop();
    });

    it("should reload process with new definition by index", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "proc1",
            definition: successProcess,
            options: { restartPolicy: "never" },
          },
          {
            name: "proc2",
            definition: successProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(300);

      // Reload second process (index 1)
      await manager.reloadProcessByTarget(1, longRunningProcess);
      await wait(150);

      const proc = manager.getProcessByTarget(1);
      expect(proc?.state).toBe("running");
      expect(proc?.name).toBe("proc2");

      await manager.stop();
    });

    it("should apply global defaults to new definition", async () => {
      const config: ManagerConfig = {
        cwd: import.meta.dirname,
        env: { GLOBAL: "value" },
        processes: [
          {
            name: "test-proc",
            definition: successProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(300);

      // Reload with definition that has its own env
      const newDefinition = {
        ...longRunningProcess,
        env: { LOCAL: "value" },
      };

      await manager.reloadProcessByTarget("test-proc", newDefinition);
      await wait(150);

      // The process should be running with both global and local env merged
      const proc = manager.getProcessByTarget("test-proc");
      expect(proc?.state).toBe("running");

      await manager.stop();
    });

    it("should support restartImmediately=false option", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "test-proc",
            definition: longRunningProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(150);

      const proc = manager.getProcessByTarget("test-proc");
      expect(proc?.state).toBe("running");

      // Reload without immediate restart
      await manager.reloadProcessByTarget("test-proc", successProcess, {
        restartImmediately: false,
      });

      // Should still be running with old process
      expect(proc?.state).toBe("running");

      await manager.stop();
    });

    it("should update restart options when provided", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "test-proc",
            definition: successProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await expect.poll(() => manager.getProcessByTarget("test-proc")?.state).toBe("stopped");

      const proc = manager.getProcessByTarget("test-proc");
      expect(proc?.state).toBe("stopped");
      expect(proc?.restarts).toBe(0);

      // Reload with new policy and short-lived process
      await manager.reloadProcessByTarget("test-proc", successProcess, {
        updateOptions: {
          restartPolicy: "always",
          maxTotalRestarts: 2,
          backoff: { type: "fixed", delayMs: 50 },
        },
      });

      // Should have restarted with new policy
      await expect.poll(() => proc?.restarts ?? 0, { timeout: 2000 }).toBeGreaterThan(0);

      await manager.stop();
    });

    it("should throw if process not found", async () => {
      const config: ManagerConfig = {
        processes: [],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();

      await expect(manager.reloadProcessByTarget("nonexistent", successProcess)).rejects.toThrow(
        "Process not found: nonexistent",
      );

      await manager.stop();
    });
  });

  describe("removeProcessByTarget()", () => {
    it("should remove process by name", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "test-proc",
            definition: longRunningProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(150);

      expect(manager.getProcessByTarget("test-proc")).toBeDefined();
      expect(manager.getRestartingProcesses().size).toBe(1);

      await manager.removeProcessByTarget("test-proc");

      expect(manager.getProcessByTarget("test-proc")).toBeUndefined();
      expect(manager.getRestartingProcesses().size).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Removed process"));

      await manager.stop();
    });

    it("should remove process by index", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "proc1",
            definition: longRunningProcess,
            options: { restartPolicy: "never" },
          },
          {
            name: "proc2",
            definition: longRunningProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(150);

      expect(manager.getRestartingProcesses().size).toBe(2);

      // Remove first process
      await manager.removeProcessByTarget(0);

      expect(manager.getRestartingProcesses().size).toBe(1);
      expect(manager.getProcessByTarget("proc1")).toBeUndefined();
      expect(manager.getProcessByTarget("proc2")).toBeDefined();

      await manager.stop();
    });

    it("should stop process before removing", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "test-proc",
            definition: longRunningProcess,
            options: { restartPolicy: "never" },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(150);

      const proc = manager.getProcessByTarget("test-proc");
      expect(proc?.state).toBe("running");

      await manager.removeProcessByTarget("test-proc");

      // Process should be stopped after removal
      expect(proc?.state).toBe("stopped");
      expect(manager.getProcessByTarget("test-proc")).toBeUndefined();

      await manager.stop();
    });

    it("should throw if process not found", async () => {
      const config: ManagerConfig = {
        processes: [],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();

      await expect(manager.removeProcessByTarget("nonexistent")).rejects.toThrow(
        "Process not found: nonexistent",
      );

      await manager.stop();
    });
  });

  describe("restartProcessByTarget()", () => {
    it("should restart process with force=true", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "test-proc",
            definition: longRunningProcess,
            options: {
              restartPolicy: "never",
              backoff: { type: "fixed", delayMs: 1000 },
            },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(150);

      const proc = manager.getProcessByTarget("test-proc");
      expect(proc?.state).toBe("running");

      const startTime = Date.now();
      await manager.restartProcessByTarget("test-proc", true);
      const elapsed = Date.now() - startTime;

      // Should restart immediately without delay
      expect(elapsed).toBeLessThan(500);
      await wait(100);
      expect(proc?.state).toBe("running");

      await manager.stop();
    });

    it("should restart process with force=false using delay", async () => {
      const config: ManagerConfig = {
        processes: [
          {
            name: "test-proc",
            definition: longRunningProcess,
            options: {
              restartPolicy: "never",
              backoff: { type: "fixed", delayMs: 200 },
            },
          },
        ],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();
      await wait(150);

      const proc = manager.getProcessByTarget("test-proc");
      expect(proc?.state).toBe("running");

      const startTime = Date.now();
      await manager.restartProcessByTarget("test-proc", false);
      const elapsed = Date.now() - startTime;

      // Should wait for delay
      expect(elapsed).toBeGreaterThanOrEqual(180);
      await wait(100);
      expect(proc?.state).toBe("running");

      await manager.stop();
    });

    it("should throw if process not found", async () => {
      const config: ManagerConfig = {
        processes: [],
      };

      const manager = new Manager(config, mockLogger);
      await manager.start();

      await expect(manager.restartProcessByTarget("nonexistent")).rejects.toThrow(
        "Process not found: nonexistent",
      );

      await manager.stop();
    });
  });
});
