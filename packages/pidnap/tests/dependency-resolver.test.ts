import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DependencyResolver,
  inferDefaultConditionFromOptions,
} from "../src/dependency-resolver.ts";
import type { RestartingProcessEntry } from "../src/manager.ts";
import type { RestartingProcess } from "../src/restarting-process.ts";

// Mock RestartingProcess for testing
function mockProcess(
  name: string,
  state: string,
  opts: { exitCode?: number; hasStarted?: boolean; isHealthy?: boolean } = {},
): RestartingProcess {
  return {
    name,
    state,
    hasStarted: opts.hasStarted ?? state === "running",
    isHealthy: opts.isHealthy ?? state === "running",
    lazyProcess: { exitCode: opts.exitCode ?? null },
  } as unknown as RestartingProcess;
}

describe("DependencyResolver", () => {
  let resolver: DependencyResolver;

  beforeEach(() => {
    resolver = new DependencyResolver();
  });

  describe("buildGraph", () => {
    it("should build graph with no dependencies", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" } },
      ];
      const processes = new Map<string, RestartingProcess>();

      resolver.buildGraph(entries, processes);

      expect(resolver.getProcessesWithNoDependencies()).toEqual(["a", "b"]);
    });

    it("should build graph with string dependencies", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
      ];
      const processes = new Map<string, RestartingProcess>();

      resolver.buildGraph(entries, processes);

      expect(resolver.getProcessesWithNoDependencies()).toEqual(["a"]);
      expect(resolver.getDependencyInfo("b")).toEqual([
        { type: "process", process: "a", condition: "started" },
      ]);
    });

    it("should build graph with object dependencies", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "completed" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();

      resolver.buildGraph(entries, processes);

      expect(resolver.getDependencyInfo("b")).toEqual([
        { type: "process", process: "a", condition: "completed" },
      ]);
    });
  });

  describe("validateNoCycles", () => {
    it("should pass with no cycles", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
        { name: "c", definition: { command: "echo" }, dependsOn: ["b"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateNoCycles()).not.toThrow();
    });

    it("should detect direct cycle", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, dependsOn: ["b"] },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateNoCycles()).toThrow(
        /Circular dependency detected: a -> b -> a/,
      );
    });

    it("should detect indirect cycle", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, dependsOn: ["c"] },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
        { name: "c", definition: { command: "echo" }, dependsOn: ["b"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateNoCycles()).toThrow(/Circular dependency detected/);
    });

    it("should detect self-cycle", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, dependsOn: ["a"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateNoCycles()).toThrow(/Circular dependency detected: a -> a/);
    });
  });

  describe("validateDependenciesExist", () => {
    it("should pass when all dependencies exist", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateDependenciesExist()).not.toThrow();
    });

    it("should throw when dependency references non-existent process", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, dependsOn: ["nonexistent"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateDependenciesExist()).toThrow(
        /Process "a" depends on non-existent process "nonexistent"/,
      );
    });

    it("should report all non-existent dependencies", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, dependsOn: ["x"] },
        { name: "b", definition: { command: "echo" }, dependsOn: ["y", "z"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateDependenciesExist()).toThrow(
        /Invalid dependency configuration/,
      );
    });
  });

  describe("getStartupOrder", () => {
    it("should return topological order", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "c", definition: { command: "echo" }, dependsOn: ["b"] },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
        { name: "a", definition: { command: "echo" } },
      ];
      resolver.buildGraph(entries, new Map());

      const order = resolver.getStartupOrder();
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    });

    it("should handle diamond dependency", () => {
      // a -> b -> d
      // a -> c -> d
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
        { name: "c", definition: { command: "echo" }, dependsOn: ["a"] },
        { name: "d", definition: { command: "echo" }, dependsOn: ["b", "c"] },
      ];
      resolver.buildGraph(entries, new Map());

      const order = resolver.getStartupOrder();
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
      expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
    });
  });

  describe("getProcessesWithNoDependencies", () => {
    it("should return all processes when none have dependencies", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" } },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.getProcessesWithNoDependencies().sort()).toEqual(["a", "b"]);
    });

    it("should return only root processes", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.getProcessesWithNoDependencies()).toEqual(["a"]);
    });
  });

  describe("getDependents", () => {
    it("should return processes that depend on given process", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
        { name: "c", definition: { command: "echo" }, dependsOn: ["a"] },
        { name: "d", definition: { command: "echo" }, dependsOn: ["b"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.getDependents("a").sort()).toEqual(["b", "c"]);
      expect(resolver.getDependents("b")).toEqual(["d"]);
      expect(resolver.getDependents("d")).toEqual([]);
    });
  });

  describe("areDependenciesMet", () => {
    it("should return true when no dependencies", () => {
      const entries: RestartingProcessEntry[] = [{ name: "a", definition: { command: "echo" } }];
      resolver.buildGraph(entries, new Map());

      expect(resolver.areDependenciesMet("a")).toBe(true);
    });

    it("should check 'started' condition", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "started" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "running", { hasStarted: true }));
      resolver.buildGraph(entries, processes);

      expect(resolver.areDependenciesMet("b")).toBe(true);
    });

    it("should check 'started' condition - not met", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "started" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "idle", { hasStarted: false }));
      resolver.buildGraph(entries, processes);

      expect(resolver.areDependenciesMet("b")).toBe(false);
    });

    it("should check 'completed' condition", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, options: { restartPolicy: "never" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "completed" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "stopped", { exitCode: 0 }));
      resolver.buildGraph(entries, processes);

      expect(resolver.areDependenciesMet("b")).toBe(true);
    });

    it("should check 'completed' condition - not met (non-zero exit)", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, options: { restartPolicy: "never" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "completed" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "stopped", { exitCode: 1 }));
      resolver.buildGraph(entries, processes);

      expect(resolver.areDependenciesMet("b")).toBe(false);
    });

    it("should check 'healthy' condition", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "healthy" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "running", { isHealthy: true }));
      resolver.buildGraph(entries, processes);

      expect(resolver.areDependenciesMet("b")).toBe(true);
    });

    it("should check 'healthy' condition - not met", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "healthy" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "running", { isHealthy: false }));
      resolver.buildGraph(entries, processes);

      expect(resolver.areDependenciesMet("b")).toBe(false);
    });

    it("should return false when dependency process doesn't exist", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "b", definition: { command: "echo" }, dependsOn: ["a"] },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.areDependenciesMet("b")).toBe(false);
    });

    it("should check all dependencies", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        { name: "b", definition: { command: "echo" } },
        { name: "c", definition: { command: "echo" }, dependsOn: ["a", "b"] },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "running", { hasStarted: true }));
      processes.set("b", mockProcess("b", "idle", { hasStarted: false }));
      resolver.buildGraph(entries, processes);

      // a is started, but b is not
      expect(resolver.areDependenciesMet("c")).toBe(false);

      // Now both are started
      processes.set("b", mockProcess("b", "running", { hasStarted: true }));
      expect(resolver.areDependenciesMet("c")).toBe(true);
    });
  });

  describe("hasFailedDependency", () => {
    it("should return false when no dependencies", () => {
      const entries: RestartingProcessEntry[] = [{ name: "a", definition: { command: "echo" } }];
      resolver.buildGraph(entries, new Map());

      expect(resolver.hasFailedDependency("a")).toBe(false);
    });

    it("should detect failed 'completed' dependency (non-zero exit)", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, options: { restartPolicy: "never" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "completed" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "stopped", { exitCode: 1 }));
      resolver.buildGraph(entries, processes);

      expect(resolver.hasFailedDependency("b")).toBe(true);
    });

    it("should detect failed 'completed' dependency (max-restarts-reached)", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "completed" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "max-restarts-reached", {}));
      resolver.buildGraph(entries, processes);

      expect(resolver.hasFailedDependency("b")).toBe(true);
    });

    it("should detect transitive failed dependency", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, options: { restartPolicy: "never" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "completed" }],
        },
        {
          name: "c",
          definition: { command: "echo" },
          dependsOn: [{ process: "b", condition: "started" }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("a", mockProcess("a", "stopped", { exitCode: 1 }));
      processes.set("b", mockProcess("b", "idle", { hasStarted: false }));
      resolver.buildGraph(entries, processes);

      // b depends on a (failed), c depends on b
      expect(resolver.hasFailedDependency("c")).toBe(true);
    });
  });

  describe("getDependencyInfo", () => {
    it("should return empty array for process with no dependencies", () => {
      const entries: RestartingProcessEntry[] = [{ name: "a", definition: { command: "echo" } }];
      resolver.buildGraph(entries, new Map());

      expect(resolver.getDependencyInfo("a")).toEqual([]);
    });

    it("should return dependency info", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" } },
        {
          name: "b",
          definition: { command: "echo" },
          dependsOn: [{ process: "a", condition: "healthy" }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.getDependencyInfo("b")).toEqual([
        { type: "process", process: "a", condition: "healthy" },
      ]);
    });

    it("should return empty array for unknown process", () => {
      resolver.buildGraph([], new Map());
      expect(resolver.getDependencyInfo("unknown")).toEqual([]);
    });
  });
});

describe("inferDefaultConditionFromOptions", () => {
  it("should return 'completed' for restartPolicy: never", () => {
    expect(inferDefaultConditionFromOptions({ restartPolicy: "never" })).toBe("completed");
  });

  it("should return 'started' for restartPolicy: always", () => {
    expect(inferDefaultConditionFromOptions({ restartPolicy: "always" })).toBe("started");
  });

  it("should return 'started' for restartPolicy: on-failure", () => {
    expect(inferDefaultConditionFromOptions({ restartPolicy: "on-failure" })).toBe("started");
  });

  it("should return 'started' for undefined options", () => {
    expect(inferDefaultConditionFromOptions(undefined)).toBe("started");
  });
});

describe("Sentinel dependencies", () => {
  let resolver: DependencyResolver;
  let tempDir: string;

  beforeEach(() => {
    resolver = new DependencyResolver();
    tempDir = join(tmpdir(), `pidnap-sentinel-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    resolver.stopAllSentinelWatchers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("buildGraph with sentinel deps", () => {
    it("should build graph with sentinel dependencies", () => {
      const sentinelPath = join(tempDir, "ready.txt");
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.getDependencyInfo("a")).toEqual([]);
      expect(resolver.getSentinelDependencyInfo("a")).toEqual([
        { type: "sentinel", path: sentinelPath, timeout: 60000, pollInterval: 1000 },
      ]);
    });

    it("should support mixed process and sentinel dependencies", () => {
      const sentinelPath = join(tempDir, "ready.txt");
      const entries: RestartingProcessEntry[] = [
        { name: "db", definition: { command: "echo" } },
        {
          name: "app",
          definition: { command: "echo" },
          dependsOn: ["db", { type: "sentinel", path: sentinelPath }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("db", mockProcess("db", "running", { hasStarted: true }));
      resolver.buildGraph(entries, processes);

      expect(resolver.getDependencyInfo("app")).toEqual([
        { type: "process", process: "db", condition: "started" },
      ]);
      expect(resolver.getSentinelDependencyInfo("app")).toHaveLength(1);
    });

    it("should use custom timeout and pollInterval", () => {
      const sentinelPath = join(tempDir, "ready.txt");
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath, timeout: 5000, pollInterval: 100 }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.getSentinelDependencyInfo("a")).toEqual([
        { type: "sentinel", path: sentinelPath, timeout: 5000, pollInterval: 100 },
      ]);
    });
  });

  describe("hasSentinelDependencies", () => {
    it("should return false for process without sentinel deps", () => {
      const entries: RestartingProcessEntry[] = [
        { name: "a", definition: { command: "echo" }, dependsOn: ["b"] },
        { name: "b", definition: { command: "echo" } },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.hasSentinelDependencies("a")).toBe(false);
    });

    it("should return true for process with sentinel deps", () => {
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: "/tmp/test" }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.hasSentinelDependencies("a")).toBe(true);
    });
  });

  describe("areDependenciesMet with sentinels", () => {
    it("should return false when sentinel file does not exist", () => {
      const sentinelPath = join(tempDir, "nonexistent.txt");
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.areDependenciesMet("a")).toBe(false);
    });

    it("should return true when sentinel file exists", () => {
      const sentinelPath = join(tempDir, "exists.txt");
      writeFileSync(sentinelPath, "ready");

      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(resolver.areDependenciesMet("a")).toBe(true);
    });

    it("should require both process and sentinel deps to be met", () => {
      const sentinelPath = join(tempDir, "ready.txt");
      writeFileSync(sentinelPath, "ready");

      const entries: RestartingProcessEntry[] = [
        { name: "db", definition: { command: "echo" } },
        {
          name: "app",
          definition: { command: "echo" },
          dependsOn: ["db", { type: "sentinel", path: sentinelPath }],
        },
      ];
      const processes = new Map<string, RestartingProcess>();
      processes.set("db", mockProcess("db", "idle", { hasStarted: false }));
      resolver.buildGraph(entries, processes);

      expect(resolver.areDependenciesMet("app")).toBe(false);

      processes.set("db", mockProcess("db", "running", { hasStarted: true }));
      expect(resolver.areDependenciesMet("app")).toBe(true);
    });
  });

  describe("sentinel watchers", () => {
    it("should call onMet when file already exists", () => {
      const sentinelPath = join(tempDir, "exists.txt");
      writeFileSync(sentinelPath, "ready");

      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      const onMet = vi.fn();
      const onTimeout = vi.fn();
      resolver.startSentinelWatchers("a", onMet, onTimeout);

      expect(onMet).toHaveBeenCalledTimes(1);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("should call onMet when file appears later", async () => {
      const sentinelPath = join(tempDir, "appears-later.txt");

      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath, pollInterval: 50, timeout: 5000 }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      const onMet = vi.fn();
      const onTimeout = vi.fn();
      resolver.startSentinelWatchers("a", onMet, onTimeout);

      expect(onMet).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(sentinelPath, "ready");

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(onMet).toHaveBeenCalledTimes(1);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("should call onTimeout when file never appears", async () => {
      const sentinelPath = join(tempDir, "never-appears.txt");

      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath, pollInterval: 20, timeout: 80 }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      const onMet = vi.fn();
      const onTimeout = vi.fn();
      resolver.startSentinelWatchers("a", onMet, onTimeout);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMet).not.toHaveBeenCalled();
      expect(onTimeout).toHaveBeenCalledWith(sentinelPath);
    });

    it("should handle multiple sentinel deps for same process", async () => {
      const sentinel1 = join(tempDir, "sentinel1.txt");
      const sentinel2 = join(tempDir, "sentinel2.txt");

      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [
            { type: "sentinel", path: sentinel1, pollInterval: 50, timeout: 5000 },
            { type: "sentinel", path: sentinel2, pollInterval: 50, timeout: 5000 },
          ],
        },
      ];
      resolver.buildGraph(entries, new Map());

      const onMet = vi.fn();
      const onTimeout = vi.fn();
      resolver.startSentinelWatchers("a", onMet, onTimeout);

      writeFileSync(sentinel1, "ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onMet).not.toHaveBeenCalled();

      writeFileSync(sentinel2, "ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onMet).toHaveBeenCalledTimes(1);
    });

    it("should stop watchers cleanly", () => {
      const sentinelPath = join(tempDir, "cleanup.txt");
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath, pollInterval: 50, timeout: 60000 }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      const onMet = vi.fn();
      const onTimeout = vi.fn();
      resolver.startSentinelWatchers("a", onMet, onTimeout);

      resolver.stopSentinelWatchers("a");
      resolver.stopAllSentinelWatchers();
    });
  });

  describe("hasFailedDependency with sentinels", () => {
    it("should detect timed-out sentinel as failed", async () => {
      const sentinelPath = join(tempDir, "timeout-fail.txt");

      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: sentinelPath, pollInterval: 20, timeout: 50 }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      const onMet = vi.fn();
      const onTimeout = vi.fn();
      resolver.startSentinelWatchers("a", onMet, onTimeout);

      expect(resolver.hasFailedDependency("a")).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(resolver.hasFailedDependency("a")).toBe(true);
    });
  });

  describe("validation with sentinels", () => {
    it("should not include sentinel deps in cycle detection", () => {
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: "/tmp/test" }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateNoCycles()).not.toThrow();
    });

    it("should not include sentinel deps in dependency existence validation", () => {
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: "/tmp/test" }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      expect(() => resolver.validateDependenciesExist()).not.toThrow();
    });

    it("should not count sentinel deps as process dependencies for getProcessesWithNoDependencies", () => {
      const entries: RestartingProcessEntry[] = [
        {
          name: "a",
          definition: { command: "echo" },
          dependsOn: [{ type: "sentinel", path: "/tmp/test" }],
        },
      ];
      resolver.buildGraph(entries, new Map());

      // Has a sentinel dep so dependsOn.length > 0
      expect(resolver.getProcessesWithNoDependencies()).toEqual([]);
    });
  });
});
