import { existsSync } from "node:fs";
import type {
  DependencyCondition,
  ProcessDependency,
  RestartingProcessEntry,
  SentinelDependency,
} from "./manager.ts";
import type { RestartingProcess, RestartingProcessOptions } from "./restarting-process.ts";

interface NormalizedProcessDependency {
  type: "process";
  process: string;
  condition: DependencyCondition;
}

interface NormalizedSentinelDependency {
  type: "sentinel";
  path: string;
  timeout: number;
  pollInterval: number;
}

type NormalizedDependency = NormalizedProcessDependency | NormalizedSentinelDependency;

interface DependencyNode {
  name: string;
  dependsOn: NormalizedDependency[];
}

/** Check if a raw dependency is a sentinel dependency. */
function isSentinelDependency(dep: ProcessDependency): dep is SentinelDependency {
  return typeof dep === "object" && "type" in dep && dep.type === "sentinel";
}

/**
 * Infer the default dependency condition based on options
 */
export function inferDefaultConditionFromOptions(
  options?: RestartingProcessOptions,
): DependencyCondition {
  // If it's a task (never restarts), default to "completed"
  if (options?.restartPolicy === "never") {
    return "completed";
  }
  // Otherwise, default to "started"
  return "started";
}

const DEFAULT_SENTINEL_TIMEOUT_MS = 60_000;
const DEFAULT_SENTINEL_POLL_INTERVAL_MS = 1_000;

/**
 * Resolves process dependencies and manages startup ordering.
 * Supports both process dependencies and sentinel file dependencies.
 */
export class DependencyResolver {
  private nodes: Map<string, DependencyNode> = new Map();
  private processes: Map<string, RestartingProcess> = new Map();

  // Sentinel file tracking
  private sentinelTimers: Map<string, ReturnType<typeof setInterval>[]> = new Map();
  private sentinelMet: Map<string, boolean> = new Map();
  private sentinelTimedOut: Map<string, boolean> = new Map();

  /**
   * Build the dependency graph from process entries
   */
  buildGraph(entries: RestartingProcessEntry[], processes: Map<string, RestartingProcess>): void {
    this.processes = processes;
    this.nodes.clear();

    for (const entry of entries) {
      const node: DependencyNode = {
        name: entry.name,
        dependsOn: [],
      };

      if (entry.dependsOn) {
        for (const dep of entry.dependsOn) {
          if (isSentinelDependency(dep)) {
            node.dependsOn.push({
              type: "sentinel",
              path: dep.path,
              timeout: dep.timeout ?? DEFAULT_SENTINEL_TIMEOUT_MS,
              pollInterval: dep.pollInterval ?? DEFAULT_SENTINEL_POLL_INTERVAL_MS,
            });
          } else {
            const depName = typeof dep === "string" ? dep : dep.process;
            const targetEntry = entries.find((e) => e.name === depName);
            const normalized = this.normalizeProcessDependency(dep, targetEntry);
            node.dependsOn.push(normalized);
          }
        }
      }

      this.nodes.set(entry.name, node);
    }
  }

  private normalizeProcessDependency(
    dep: Exclude<ProcessDependency, SentinelDependency>,
    targetEntry: RestartingProcessEntry | undefined,
  ): NormalizedProcessDependency {
    const processName = typeof dep === "string" ? dep : dep.process;
    const explicitCondition = typeof dep === "object" ? dep.condition : undefined;

    if (explicitCondition) {
      return { type: "process", process: processName, condition: explicitCondition };
    }

    // Infer default condition
    const condition = inferDefaultConditionFromOptions(targetEntry?.options);
    return { type: "process", process: processName, condition };
  }

  /**
   * Validate that all process dependency references exist.
   * Sentinel dependencies are not validated here (they reference file paths, not processes).
   * @throws Error if a dependency references a non-existent process
   */
  validateDependenciesExist(): void {
    const allProcessNames = new Set(this.nodes.keys());
    const errors: string[] = [];

    for (const [name, node] of this.nodes) {
      for (const dep of node.dependsOn) {
        if (dep.type === "sentinel") continue;
        if (!allProcessNames.has(dep.process)) {
          errors.push(`Process "${name}" depends on non-existent process "${dep.process}"`);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Invalid dependency configuration:\n  - ${errors.join("\n  - ")}`);
    }
  }

  /**
   * Validate that there are no circular dependencies
   * @throws Error if circular dependency is detected
   */
  validateNoCycles(): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const visit = (name: string, path: string[]): void => {
      if (recursionStack.has(name)) {
        const cycleStart = path.indexOf(name);
        const cycle = [...path.slice(cycleStart), name].join(" -> ");
        throw new Error(`Circular dependency detected: ${cycle}`);
      }

      if (visited.has(name)) return;

      visited.add(name);
      recursionStack.add(name);

      const node = this.nodes.get(name);
      if (node) {
        for (const dep of node.dependsOn) {
          if (dep.type === "sentinel") continue;
          visit(dep.process, [...path, name]);
        }
      }

      recursionStack.delete(name);
    };

    for (const name of this.nodes.keys()) {
      visit(name, []);
    }
  }

  /**
   * Get the topologically sorted startup order
   * Processes with no dependencies come first
   */
  getStartupOrder(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      visited.add(name);

      const node = this.nodes.get(name);
      if (node) {
        for (const dep of node.dependsOn) {
          if (dep.type === "sentinel") continue;
          visit(dep.process);
        }
      }

      result.push(name);
    };

    for (const name of this.nodes.keys()) {
      visit(name);
    }

    return result;
  }

  /**
   * Get processes that have no dependencies (can start immediately)
   */
  getProcessesWithNoDependencies(): string[] {
    const result: string[] = [];
    for (const [name, node] of this.nodes) {
      if (node.dependsOn.length === 0) {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Get the dependents of a process (processes that depend on it)
   */
  getDependents(processName: string): string[] {
    const result: string[] = [];
    for (const [name, node] of this.nodes) {
      if (node.dependsOn.some((dep) => dep.type === "process" && dep.process === processName)) {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Start watching sentinel files for a process.
   * Calls `onMet` when all sentinels for the process are satisfied.
   * Calls `onTimeout` if any sentinel times out.
   */
  startSentinelWatchers(
    processName: string,
    onMet: () => void,
    onTimeout: (path: string) => void,
  ): void {
    const node = this.nodes.get(processName);
    if (!node) return;

    const sentinelDeps = node.dependsOn.filter(
      (dep): dep is NormalizedSentinelDependency => dep.type === "sentinel",
    );
    if (sentinelDeps.length === 0) return;

    const timers: ReturnType<typeof setInterval>[] = [];
    let pendingCount = sentinelDeps.length;

    for (const dep of sentinelDeps) {
      const sentinelKey = `${processName}:${dep.path}`;

      // Already met (file exists now)
      if (existsSync(dep.path)) {
        this.sentinelMet.set(sentinelKey, true);
        pendingCount--;
        if (pendingCount === 0) {
          onMet();
        }
        continue;
      }

      const startTime = Date.now();

      const pollTimer = setInterval(() => {
        if (existsSync(dep.path)) {
          clearInterval(pollTimer);
          this.sentinelMet.set(sentinelKey, true);
          pendingCount--;
          if (pendingCount === 0) {
            onMet();
          }
          return;
        }

        if (Date.now() - startTime >= dep.timeout) {
          clearInterval(pollTimer);
          this.sentinelTimedOut.set(sentinelKey, true);
          onTimeout(dep.path);
        }
      }, dep.pollInterval);

      timers.push(pollTimer);
    }

    if (timers.length > 0) {
      this.sentinelTimers.set(processName, timers);
    }
  }

  /**
   * Stop watching sentinel files for a process.
   */
  stopSentinelWatchers(processName: string): void {
    const timers = this.sentinelTimers.get(processName);
    if (timers) {
      for (const timer of timers) {
        clearInterval(timer);
      }
      this.sentinelTimers.delete(processName);
    }

    // Clean up sentinel state for this process
    for (const key of [...this.sentinelMet.keys(), ...this.sentinelTimedOut.keys()]) {
      if (key.startsWith(`${processName}:`)) {
        this.sentinelMet.delete(key);
        this.sentinelTimedOut.delete(key);
      }
    }
  }

  /**
   * Stop all sentinel watchers.
   */
  stopAllSentinelWatchers(): void {
    for (const timers of this.sentinelTimers.values()) {
      for (const timer of timers) {
        clearInterval(timer);
      }
    }
    this.sentinelTimers.clear();
    this.sentinelMet.clear();
    this.sentinelTimedOut.clear();
  }

  /**
   * Check if a process has any sentinel dependencies.
   */
  hasSentinelDependencies(processName: string): boolean {
    const node = this.nodes.get(processName);
    if (!node) return false;
    return node.dependsOn.some((dep) => dep.type === "sentinel");
  }

  /**
   * Check if all dependencies for a process are met (process + sentinel).
   */
  areDependenciesMet(processName: string): boolean {
    const node = this.nodes.get(processName);
    if (!node) return true;

    for (const dep of node.dependsOn) {
      if (dep.type === "sentinel") {
        // Check sentinel inline
        const sentinelKey = `${processName}:${dep.path}`;
        if (!this.sentinelMet.get(sentinelKey) && !existsSync(dep.path)) {
          return false;
        }
        // Mark as met if file exists
        if (!this.sentinelMet.get(sentinelKey)) {
          this.sentinelMet.set(sentinelKey, true);
        }
        continue;
      }

      const depProcess = this.processes.get(dep.process);
      if (!depProcess) {
        // Dependency doesn't exist - treat as not met
        return false;
      }

      if (!this.meetsCondition(depProcess, dep.condition)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a dependency has failed (cannot be met)
   */
  hasFailedDependency(processName: string): boolean {
    const node = this.nodes.get(processName);
    if (!node) return false;

    for (const dep of node.dependsOn) {
      if (dep.type === "sentinel") {
        // Sentinel timed out = failed
        const sentinelKey = `${processName}:${dep.path}`;
        if (this.sentinelTimedOut.get(sentinelKey)) return true;
        continue;
      }

      const depProcess = this.processes.get(dep.process);
      if (!depProcess) continue;

      // Check if the dependency itself has failed
      if (
        (dep.condition === "completed" &&
          depProcess.state === "stopped" &&
          depProcess.lazyProcess.exitCode !== 0) ||
        (dep.condition === "completed" && depProcess.state === "max-restarts-reached")
      ) {
        return true;
      }

      // Check if the dependency has a failed dependency (transitive)
      if (this.hasFailedDependency(dep.process)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a process meets a specific condition
   */
  private meetsCondition(process: RestartingProcess, condition: DependencyCondition): boolean {
    switch (condition) {
      case "completed":
        // Exited with code 0
        return process.state === "stopped" && process.lazyProcess.exitCode === 0;

      case "healthy":
        // Running and healthy (via health check or just running if no health check)
        return process.isHealthy;

      case "started":
        // Has started at least once
        return process.hasStarted;

      default:
        return false;
    }
  }

  /**
   * Get dependency info for a process (for API responses).
   * Returns only process dependencies (sentinel deps are returned separately).
   */
  getDependencyInfo(processName: string): NormalizedProcessDependency[] {
    const node = this.nodes.get(processName);
    if (!node) return [];
    return node.dependsOn.filter(
      (dep): dep is NormalizedProcessDependency => dep.type === "process",
    );
  }

  /**
   * Get sentinel dependency info for a process (for API responses).
   */
  getSentinelDependencyInfo(processName: string): NormalizedSentinelDependency[] {
    const node = this.nodes.get(processName);
    if (!node) return [];
    return node.dependsOn.filter(
      (dep): dep is NormalizedSentinelDependency => dep.type === "sentinel",
    );
  }
}
