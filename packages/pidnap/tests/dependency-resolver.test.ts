import { describe, it, expect, beforeEach } from "vitest";
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
      expect(resolver.getDependencyInfo("b")).toEqual([{ process: "a", condition: "started" }]);
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

      expect(resolver.getDependencyInfo("b")).toEqual([{ process: "a", condition: "completed" }]);
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

      expect(resolver.getDependencyInfo("b")).toEqual([{ process: "a", condition: "healthy" }]);
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
