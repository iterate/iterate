import type { DependencyCondition, ProcessDependency, RestartingProcessEntry } from "./manager.ts";
import type { RestartingProcess, RestartingProcessOptions } from "./restarting-process.ts";

interface DependencyNode {
  name: string;
  dependsOn: Array<{ process: string; condition: DependencyCondition }>;
}

/**
 * Normalizes a ProcessDependency (string or object) to the object form
 */
function normalizeDependency(
  dep: ProcessDependency,
  targetProcess: RestartingProcess | undefined,
): { process: string; condition: DependencyCondition } {
  if (typeof dep === "string") {
    return {
      process: dep,
      condition: inferDefaultCondition(targetProcess),
    };
  }
  return {
    process: dep.process,
    condition: dep.condition ?? inferDefaultCondition(targetProcess),
  };
}

/**
 * Infer the default dependency condition based on the target process's restart policy
 */
function inferDefaultCondition(targetProcess: RestartingProcess | undefined): DependencyCondition {
  if (!targetProcess) return "completed";

  // Access the private options via the lazyProcess or by checking state behavior
  // For simplicity, we'll use "completed" for one-shot tasks (restartPolicy: "never")
  // and "healthy" for long-running processes

  // Since we can't easily access the options, we'll use a heuristic:
  // If the process has a health check, default to "healthy"
  // Otherwise, default to "started" for long-running processes
  // This will be refined when we have more context

  return "started";
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

/**
 * Resolves process dependencies and manages startup ordering
 */
export class DependencyResolver {
  private nodes: Map<string, DependencyNode> = new Map();
  private processes: Map<string, RestartingProcess> = new Map();
  private entries: Map<string, RestartingProcessEntry> = new Map();

  /**
   * Build the dependency graph from process entries
   */
  buildGraph(entries: RestartingProcessEntry[], processes: Map<string, RestartingProcess>): void {
    this.processes = processes;
    this.nodes.clear();
    this.entries.clear();

    for (const entry of entries) {
      this.entries.set(entry.name, entry);
      const node: DependencyNode = {
        name: entry.name,
        dependsOn: [],
      };

      if (entry.dependsOn) {
        for (const dep of entry.dependsOn) {
          const targetProcess = processes.get(typeof dep === "string" ? dep : dep.process);
          const targetEntry = entries.find(
            (e) => e.name === (typeof dep === "string" ? dep : dep.process),
          );
          const normalized = this.normalizeDependencyWithEntry(dep, targetEntry);
          node.dependsOn.push(normalized);
        }
      }

      this.nodes.set(entry.name, node);
    }
  }

  private normalizeDependencyWithEntry(
    dep: ProcessDependency,
    targetEntry: RestartingProcessEntry | undefined,
  ): { process: string; condition: DependencyCondition } {
    const processName = typeof dep === "string" ? dep : dep.process;
    const explicitCondition = typeof dep === "object" ? dep.condition : undefined;

    if (explicitCondition) {
      return { process: processName, condition: explicitCondition };
    }

    // Infer default condition
    const condition = inferDefaultConditionFromOptions(targetEntry?.options);
    return { process: processName, condition };
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
      if (node.dependsOn.some((dep) => dep.process === processName)) {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Check if all dependencies for a process are met
   */
  areDependenciesMet(processName: string): boolean {
    const node = this.nodes.get(processName);
    if (!node) return true;

    for (const dep of node.dependsOn) {
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
   * Get dependency info for a process (for API responses)
   */
  getDependencyInfo(processName: string): { process: string; condition: DependencyCondition }[] {
    const node = this.nodes.get(processName);
    return node?.dependsOn ?? [];
  }
}
