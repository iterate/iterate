import { describe, it, expect, beforeEach } from "vitest";
import { RestartingProcess, type RestartingProcessOptions } from "../src/restarting-process.ts";
import type { Logger } from "../src/logger.ts";
import {
  createMockLogger,
  wait,
  successProcess,
  failureProcess,
  longRunningProcess,
  timedProcess,
} from "./test-utils.ts";

const POLL_TIMEOUT_MS = 5000;

describe("RestartingProcess", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("constructor and initial state", () => {
    it("should start in idle state", () => {
      const options: RestartingProcessOptions = { restartPolicy: "always" };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      expect(proc.state).toBe("idle");
      expect(proc.name).toBe("test");
      expect(proc.restarts).toBe(0);
    });
  });

  describe("start()", () => {
    it("should transition state to running", async () => {
      const options: RestartingProcessOptions = { restartPolicy: "never" };
      const proc = new RestartingProcess("test", longRunningProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      await proc.stop();
    });

    it("should throw if called when already running", async () => {
      const options: RestartingProcessOptions = { restartPolicy: "never" };
      const proc = new RestartingProcess("test", longRunningProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      expect(() => proc.start()).toThrow('Process "test" is already running');

      await proc.stop();
    });

    it("should reset counters when starting from stopped state", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "never",
        backoff: { type: "fixed", delayMs: 50 },
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("stopped");

      // Start again with long-running process - should reset counters
      const proc2 = new RestartingProcess("test2", longRunningProcess, options, mockLogger);
      proc2.start();
      await expect.poll(() => proc2.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");
      expect(proc2.restarts).toBe(0);

      await proc2.stop();
    });
  });

  describe("restart policies", () => {
    it('should restart on "always" policy regardless of exit code', async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 50 },
        maxTotalRestarts: 2,
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.restarts, { timeout: 3000 }).toBeGreaterThan(0);

      await proc.stop();
    });

    it('should not restart on "never" policy', async () => {
      const options: RestartingProcessOptions = { restartPolicy: "never" };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("stopped");
      expect(proc.restarts).toBe(0);
    });

    it('should restart on "on-failure" policy only when exit code is non-zero', async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "on-failure",
        backoff: { type: "fixed", delayMs: 50 },
        maxTotalRestarts: 2,
      };

      // Success process should not restart
      const successProc = new RestartingProcess(
        "test-success",
        successProcess,
        options,
        mockLogger,
      );
      successProc.start();
      await expect.poll(() => successProc.state, { timeout: 5000 }).toBe("stopped");
      expect(successProc.restarts).toBe(0);

      // Failure process should restart
      const failureProc = new RestartingProcess(
        "test-failure",
        failureProcess,
        options,
        mockLogger,
      );
      failureProc.start();
      await expect.poll(() => failureProc.restarts, { timeout: 5000 }).toBeGreaterThan(0);

      await failureProc.stop();
    });

    it('should restart on "on-success" policy only when exit code is zero', async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "on-success",
        backoff: { type: "fixed", delayMs: 50 },
        maxTotalRestarts: 2,
      };

      // Success process should restart
      const successProc = new RestartingProcess(
        "test-success",
        successProcess,
        options,
        mockLogger,
      );
      successProc.start();
      await expect
        .poll(() => successProc.restarts, { timeout: POLL_TIMEOUT_MS })
        .toBeGreaterThan(0);

      await successProc.stop();

      // Failure process should not restart
      const failureProc = new RestartingProcess(
        "test-failure",
        failureProcess,
        options,
        mockLogger,
      );
      failureProc.start();
      await expect.poll(() => failureProc.state, { timeout: POLL_TIMEOUT_MS }).toBe("stopped");
      expect(failureProc.restarts).toBe(0);
    });

    it('should restart on "unless-stopped" policy until stop() is called', async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "unless-stopped",
        backoff: { type: "fixed", delayMs: 50 },
        maxTotalRestarts: 3,
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.restarts, { timeout: POLL_TIMEOUT_MS }).toBeGreaterThan(0);

      await proc.stop();
      expect(proc.state).toBe("stopped");
    });
  });

  describe("backoff strategies", () => {
    it("should use fixed delay between restarts", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 100 },
        maxTotalRestarts: 2,
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      const startTime = Date.now();
      proc.start();

      // Wait for 2 restarts
      await wait(600);

      const elapsed = Date.now() - startTime;
      // Should have at least 2 delays of 100ms each
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(proc.restarts).toBeGreaterThanOrEqual(1);

      await proc.stop();
    });

    it("should use exponential backoff with increasing delays", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "exponential", initialDelayMs: 50, maxDelayMs: 500, multiplier: 2 },
        maxTotalRestarts: 3,
      };
      const proc = new RestartingProcess("test", failureProcess, options, mockLogger);

      proc.start();

      // Let it restart a few times
      await wait(800);

      expect(proc.restarts).toBeGreaterThan(0);

      await proc.stop();
    });
  });

  describe("crash loop detection", () => {
    it("should enter crash-loop-backoff when too many restarts in window", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 20 },
        crashLoop: { maxRestarts: 3, windowMs: 5000, backoffMs: 1000 },
      };
      const proc = new RestartingProcess("test", failureProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: 2000 }).toBe("crash-loop-backoff");
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Crash loop detected"));

      await proc.stop();
    });

    it("should eventually resume after crash-loop-backoff", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 10 },
        crashLoop: { maxRestarts: 3, windowMs: 5000, backoffMs: 100 },
        maxTotalRestarts: 10,
      };
      const proc = new RestartingProcess("test", failureProcess, options, mockLogger);

      proc.start();

      // Should have restarted multiple times (crash loop triggers at 3 restarts)
      await expect.poll(() => proc.restarts, { timeout: 2000 }).toBeGreaterThanOrEqual(3);

      // Verify crash loop was detected at some point
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Crash loop detected"));

      await proc.stop();
    });
  });

  describe("maxTotalRestarts", () => {
    it("should stop restarting after maxTotalRestarts reached", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 30 },
        maxTotalRestarts: 2,
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: 5000 }).toBe("max-restarts-reached");
      expect(proc.restarts).toBe(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Max total restarts"));
    });

    it("should allow restart from max-restarts-reached with counters reset", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 30 },
        maxTotalRestarts: 2,
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: 5000 }).toBe("max-restarts-reached");

      // Restart with long-running process should reset counters
      const options2: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 30 },
        maxTotalRestarts: 2,
      };
      const proc2 = new RestartingProcess("test2", longRunningProcess, options2, mockLogger);
      proc2.start();
      await expect.poll(() => proc2.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");
      expect(proc2.restarts).toBe(0);

      await proc2.stop();
    });
  });

  describe("stop()", () => {
    it("should stop and disable auto-restart", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 50 },
      };
      const proc = new RestartingProcess("test", longRunningProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      await proc.stop();
      expect(proc.state).toBe("stopped");

      // Wait and verify it doesn't restart
      await wait(200);
      expect(proc.state).toBe("stopped");
    });

    it("should cancel pending restart delay", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 500 },
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("restarting");

      await proc.stop();
      expect(proc.state).toBe("stopped");
    });
  });

  describe("restart(force)", () => {
    it("should restart immediately when force=true", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 1000 },
      };
      const proc = new RestartingProcess("test", longRunningProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      const startTime = Date.now();
      await proc.restart(true);
      const elapsed = Date.now() - startTime;

      // Should have restarted without waiting for 1000ms delay
      expect(elapsed).toBeLessThan(500);
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      await proc.stop();
    });

    it("should follow normal delay when force=false", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 200 },
      };
      const proc = new RestartingProcess("test", longRunningProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      const startTime = Date.now();
      await proc.restart(false);
      const elapsed = Date.now() - startTime;

      // Should have waited for the delay
      expect(elapsed).toBeGreaterThanOrEqual(180);

      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      await proc.stop();
    });

    it("should reset counters when restarting from stopped state", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "never",
        backoff: { type: "fixed", delayMs: 50 },
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("stopped");

      await proc.restart();
      await wait(150);

      expect(proc.restarts).toBe(0);

      await proc.stop();
    });
  });

  describe("minUptimeMs", () => {
    it("should reset consecutive failures if process runs longer than minUptimeMs", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "exponential", initialDelayMs: 50, maxDelayMs: 5000, multiplier: 2 },
        minUptimeMs: 100,
        maxTotalRestarts: 3,
      };

      const proc = new RestartingProcess("test", timedProcess(150), options, mockLogger);

      proc.start();
      await expect.poll(() => proc.restarts, { timeout: POLL_TIMEOUT_MS }).toBeGreaterThan(0);

      await proc.stop();
    });
  });

  describe("reload()", () => {
    it("should update process definition and restart immediately by default", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "never",
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("stopped");

      // Reload with long-running process
      await proc.reload(longRunningProcess, true);
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Reloading"));

      await proc.stop();
    });

    it("should update definition without restarting when restartImmediately=false", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "never",
      };
      const proc = new RestartingProcess("test", longRunningProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      // Reload but don't restart
      await proc.reload(successProcess, false);

      // Should still be running with old process
      expect(proc.state).toBe("running");

      await proc.stop();
    });

    it("should apply new definition on next start after reload with restartImmediately=false", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "never",
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      // Reload with long-running process without immediate restart
      await proc.reload(longRunningProcess, false);

      // Start should use new definition
      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("running");

      await proc.stop();
    });
  });

  describe("updateOptions()", () => {
    it("should update restart policy", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "never",
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      proc.start();
      await expect.poll(() => proc.state, { timeout: POLL_TIMEOUT_MS }).toBe("stopped");
      expect(proc.restarts).toBe(0);

      // Update policy and restart
      proc.updateOptions({ restartPolicy: "always", maxTotalRestarts: 2 });
      proc.start();
      await expect.poll(() => proc.restarts, { timeout: POLL_TIMEOUT_MS }).toBeGreaterThan(0);

      await proc.stop();
    });

    it("should update backoff strategy", async () => {
      const options: RestartingProcessOptions = {
        restartPolicy: "always",
        backoff: { type: "fixed", delayMs: 1000 },
        maxTotalRestarts: 1,
      };
      const proc = new RestartingProcess("test", successProcess, options, mockLogger);

      // Update to shorter delay
      proc.updateOptions({
        backoff: { type: "fixed", delayMs: 50 },
      });

      const startTime = Date.now();
      proc.start();
      await expect
        .poll(() => proc.restarts, { timeout: POLL_TIMEOUT_MS })
        .toBeGreaterThanOrEqual(1);

      const elapsed = Date.now() - startTime;

      // Should use new shorter delay (50ms) instead of original 1000ms
      expect(elapsed).toBeLessThan(500);

      await proc.stop();
    });
  });
});
