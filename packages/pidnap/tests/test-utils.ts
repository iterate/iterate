import { vi } from "vitest";
import type { ProcessDefinition } from "../src/lazy-process.ts";
import type { Logger } from "../src/logger.ts";

/**
 * Creates a mock logger for testing
 */
export function createMockLogger(): Logger {
  const mockLogger: Logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    withPrefix: vi.fn(() => createMockLogger()),
  };
  return mockLogger;
}

/**
 * Wait for a specified number of milliseconds
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Short-lived process that exits with code 0
 */
export const successProcess: ProcessDefinition = {
  command: "node",
  args: ["-e", "process.exit(0)"],
};

/**
 * Short-lived process that exits with code 1
 */
export const failureProcess: ProcessDefinition = {
  command: "node",
  args: ["-e", "process.exit(1)"],
};

/**
 * Long-running process (30 seconds)
 */
export const longRunningProcess: ProcessDefinition = {
  command: "node",
  args: ["-e", "setTimeout(() => {}, 30000)"],
};

/**
 * Process that runs for a specific duration then exits with code 0
 */
export function timedProcess(ms: number): ProcessDefinition {
  return {
    command: "node",
    args: ["-e", `setTimeout(() => process.exit(0), ${ms})`],
  };
}

/**
 * Process that runs for a specific duration then exits with specified code
 */
export function timedProcessWithExitCode(ms: number, exitCode: number): ProcessDefinition {
  return {
    command: "node",
    args: ["-e", `setTimeout(() => process.exit(${exitCode}), ${ms})`],
  };
}
