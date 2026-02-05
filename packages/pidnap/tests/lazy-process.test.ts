import { describe, it, expect, beforeEach } from "vitest";
import { LazyProcess, type ProcessDefinition } from "../src/lazy-process.ts";
import type { Logger } from "../src/logger.ts";
import { createMockLogger } from "./test-utils.ts";

describe("LazyProcess", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("constructor and initial state", () => {
    it("should start in idle state", () => {
      const definition: ProcessDefinition = { command: "echo", args: ["hello"] };
      const proc = new LazyProcess("test", definition, mockLogger);

      expect(proc.state).toBe("idle");
      expect(proc.name).toBe("test");
    });
  });

  describe("start()", () => {
    it("should transition state to running", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "console.log('hello')"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      expect(proc.state).toBe("running");

      // Wait for process to complete using polling for reliability
      await expect.poll(() => proc.state, { timeout: 2000 }).toBe("stopped");
    });

    it("should log stdout output", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "console.log('test output')"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();

      // Wait for process to complete and output to be logged
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Logger now uses withPrefix("OUT") for stdout
      expect(mockLogger.withPrefix).toHaveBeenCalled();
    });

    it("should throw if called when already running", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();

      await expect(proc.start()).rejects.toThrow('Process "test" is already running');

      // Cleanup
      await proc.stop();
    });

    it("should set state to error on non-zero exit code", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "process.exit(1)"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(proc.state).toBe("error");
      // Logger now uses withPrefix, so check the child logger was called
      expect(mockLogger.withPrefix).toHaveBeenCalled();
    });
  });

  describe("stop()", () => {
    it("should transition state to stopped", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "setTimeout(() => {}, 10000)"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      expect(proc.state).toBe("running");

      await proc.stop();
      expect(proc.state).toBe("stopped");
    });

    it("should resolve immediately if already stopped", async () => {
      const definition: ProcessDefinition = { command: "echo", args: ["hello"] };
      const proc = new LazyProcess("test", definition, mockLogger);

      // Never started, so it's idle
      await proc.stop();
      expect(proc.state).toBe("idle");
    });

    it("should force kill with SIGKILL after timeout", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: [
          "-e",
          // Use a script that signals when ready and ignores SIGTERM
          "process.on('SIGTERM', () => { console.log('SIGTERM ignored'); }); console.log('ready'); setTimeout(() => {}, 30000)",
        ],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();

      // Wait for process to be ready (output "ready")
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Use a short timeout to trigger SIGKILL
      await proc.stop(100);

      expect(proc.state).toBe("stopped");
      // Logger now uses withPrefix("SYS") for system messages
      expect(mockLogger.withPrefix).toHaveBeenCalled();
    });
  });

  describe("reset()", () => {
    it("should stop running process and reset to idle", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "setTimeout(() => {}, 10000)"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      expect(proc.state).toBe("running");

      await proc.reset();
      expect(proc.state).toBe("idle");
    });

    it("should allow starting again after reset", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "console.log('run')"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proc.state).toBe("stopped");

      await proc.reset();
      expect(proc.state).toBe("idle");

      await proc.start();
      expect(proc.state).toBe("running");

      await proc.stop();
    });

    it("should reset from error state to idle", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "process.exit(1)"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proc.state).toBe("error");

      await proc.reset();
      expect(proc.state).toBe("idle");
    });
  });

  describe("state transitions", () => {
    it("should follow correct lifecycle: idle -> running -> stopped", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "console.log('done')"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      expect(proc.state).toBe("idle");

      await proc.start();
      expect(proc.state).toBe("running");

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proc.state).toBe("stopped");
    });

    it("should follow correct lifecycle with stop: idle -> running -> stopping -> stopped", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", "setTimeout(() => {}, 10000)"],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      expect(proc.state).toBe("idle");

      await proc.start();
      expect(proc.state).toBe("running");

      const stopPromise = proc.stop();
      // State should be stopping or already stopped
      expect(["stopping", "stopped"]).toContain(proc.state);

      await stopPromise;
      expect(proc.state).toBe("stopped");
    });
  });

  describe("environment variables", () => {
    it("should inherit process.env by default", async () => {
      // Set a unique env var that we can check - process exits 0 if found, 1 if not
      const testEnvVar = `TEST_INHERIT_${Date.now()}`;
      process.env[testEnvVar] = "inherited";

      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", `process.exit(process.env.${testEnvVar} === 'inherited' ? 0 : 1)`],
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      await proc.waitForExit();

      // Exit code 0 means env var was inherited
      expect(proc.exitCode).toBe(0);
      expect(proc.state).toBe("stopped");

      // Cleanup
      delete process.env[testEnvVar];
    });

    it("should NOT inherit process.env when inheritProcessEnv is false", async () => {
      // Set a unique env var that should NOT be inherited
      const testEnvVar = `TEST_NO_INHERIT_${Date.now()}`;
      process.env[testEnvVar] = "should_not_appear";

      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", `process.exit(process.env.${testEnvVar} ? 1 : 0)`],
        inheritProcessEnv: false,
        env: {
          // Need PATH for node to be found
          PATH: process.env.PATH || "",
        },
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      await proc.waitForExit();

      // Exit code 0 means env var was NOT inherited (which is correct)
      expect(proc.exitCode).toBe(0);
      expect(proc.state).toBe("stopped");

      // Cleanup
      delete process.env[testEnvVar];
    });

    it("should merge definition.env with process.env by default", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", `process.exit(process.env.CUSTOM_VAR === 'custom_value' ? 0 : 1)`],
        env: {
          CUSTOM_VAR: "custom_value",
        },
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      await proc.waitForExit();

      expect(proc.exitCode).toBe(0);
      expect(proc.state).toBe("stopped");
    });

    it("should only use definition.env when inheritProcessEnv is false", async () => {
      const definition: ProcessDefinition = {
        command: "node",
        args: ["-e", `process.exit(process.env.ONLY_THIS === 'only_value' ? 0 : 1)`],
        inheritProcessEnv: false,
        env: {
          PATH: process.env.PATH || "",
          ONLY_THIS: "only_value",
        },
      };
      const proc = new LazyProcess("test", definition, mockLogger);

      await proc.start();
      await proc.waitForExit();

      expect(proc.exitCode).toBe(0);
      expect(proc.state).toBe("stopped");
    });
  });
});
