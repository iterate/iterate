---
state: pending
priority: high
size: large
---

# Pidnap: Unify Processes and Tasks

## Summary

Remove the distinction between "tasks" and "processes" in pidnap. Instead, have a single `process` abstraction with a `restartPolicy` parameter that controls restart behavior. A "task" becomes simply a process with `restartPolicy: "never"`. Process sequencing is handled via explicit `dependsOn` declarations.

## Current Architecture

### What exists today

1. **Tasks** (`task-list.ts`):
   - Run sequentially at startup before processes start
   - Have states: `pending`, `running`, `completed`, `failed`, `skipped`
   - Do not restart (one-shot execution)
   - Manager waits for all tasks to complete before starting processes

2. **Processes** (`restarting-process.ts`):
   - Long-running with configurable restart policies
   - Have states: `idle`, `running`, `restarting`, `stopping`, `stopped`, `crash-loop-backoff`, `max-restarts-reached`
   - Restart policies: `always`, `on-failure`, `never`, `unless-stopped`, `on-success`

3. **Cron Processes** (`cron-process.ts`):
   - Scheduled execution
   - (Out of scope for this refactor)

### Problems with current approach

1. Processes aren't registered in the API until all tasks complete (404 errors)
2. No way to express "process X depends on task Y but not task Z"
3. Two separate abstractions for essentially the same thing (executing a command)
4. The "initializing" state is a leaky abstraction

## Proposed Design

Merge tasks into processes with an explicit dependency system.

### Config Schema

```typescript
// Health check is an async function that returns true when healthy
const HealthCheck = v.function(); // async () => boolean

const ProcessEntry = v.object({
  name: v.string(),
  definition: ProcessDefinition,
  options: v.optional(
    v.object({
      restartPolicy: v.optional(RestartPolicy), // defaults to "always"
      backoff: v.optional(BackoffStrategy),
      crashLoop: v.optional(CrashLoopConfig),
      minUptimeMs: v.optional(v.number()),
      maxTotalRestarts: v.optional(v.number()),
    }),
  ),
  envOptions: v.optional(EnvOptions),
  healthCheck: v.optional(HealthCheck), // Used for "healthy" condition
  dependsOn: v.optional(
    v.array(
      v.object({
        process: v.string(), // Name of the dependency
        condition: v.optional(
          v.picklist([
            "completed", // Dependency exited with code 0 (for tasks)
            "healthy", // Dependency passes health check (or is running if no health check)
            "started", // Dependency has started at least once
          ]),
        ), // defaults to "completed" for restartPolicy:"never", "healthy" otherwise
      }),
    ),
  ),
});
```

### Example Config

```typescript
export default defineConfig({
  processes: [
    // One-shot task (what was previously a "task")
    {
      name: "install-ca-certs",
      definition: bash("update-ca-certificates"),
      options: { restartPolicy: "never" },
    },
    // One-shot task that depends on another task
    {
      name: "db-migrate",
      definition: { command: "pnpm", args: ["db:migrate"] },
      options: { restartPolicy: "never" },
      dependsOn: [{ process: "install-ca-certs" }], // condition defaults to "completed"
    },
    // Long-running process with health check
    {
      name: "egress-proxy",
      definition: { command: "mitmdump", args: [...] },
      options: { restartPolicy: "always" },
      healthCheck: async () => {
        // Custom health check logic
        const res = await fetch("http://localhost:8888/health");
        return res.ok;
      },
      dependsOn: [{ process: "install-ca-certs", condition: "completed" }],
    },
    // Long-running process that depends on another long-running process
    {
      name: "daemon",
      definition: { command: "tsx", args: ["server.ts"] },
      options: { restartPolicy: "always" },
      healthCheck: async () => {
        const res = await fetch("http://localhost:3000/health");
        return res.ok;
      },
      dependsOn: [
        { process: "db-migrate", condition: "completed" },
        { process: "egress-proxy", condition: "healthy" }, // waits for health check to pass
      ],
    },
  ],
});
```

### State Machine

Unified states for all processes:

```typescript
type ProcessState =
  | "pending" // Waiting for dependencies to be met
  | "starting" // Process is starting up
  | "running" // Process is running
  | "stopping" // Being stopped
  | "stopped" // Exited normally (code 0)
  | "failed" // Exited with error (code != 0)
  | "restarting" // Waiting to restart (backoff delay)
  | "crash-loop-backoff"
  | "max-restarts-reached"
  | "dependency-failed"; // A dependency failed, this process cannot start
```

The `dependency-failed` state is explicit and distinct from `failed` - it means "never started because a dependency failed", making it easy to diagnose issues.

### Health Check Design

Health checks determine when a process is considered "healthy" for the `condition: "healthy"` dependency type. A health check is simply an async function that returns `true` when healthy.

```typescript
interface HealthCheckRunner {
  // Start periodic health checking
  start(): void;
  // Stop health checking
  stop(): void;
  // Current health status
  isHealthy(): boolean;
  // Wait for healthy (with timeout)
  waitForHealthy(timeoutMs?: number): Promise<boolean>;
}

// Implementation
class HealthCheckRunner {
  private healthy = false;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private check: () => Promise<boolean>,
    private intervalMs = 1000,
    private timeoutMs = 5000,
  ) {}

  async runCheck(): Promise<boolean> {
    // Use AbortController to properly clean up timeout on success
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const result = await Promise.race([
        this.check(),
        new Promise<boolean>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error("Health check timeout")),
          );
        }),
      ]);
      this.healthy = result;
      return result;
    } catch {
      this.healthy = false;
      return false;
    } finally {
      clearTimeout(timeoutId); // Always clean up the timer
    }
  }

  start() {
    this.runCheck(); // Initial check
    this.interval = setInterval(() => this.runCheck(), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async waitForHealthy(timeoutMs = 30000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.healthy) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
}
```

For processes without an explicit health check, `condition: "healthy"` simply means "is running".

### Dependency Resolution Algorithm

```typescript
// On any process state change:
function onProcessStateChange(process: Process) {
  // Check if any dependents can now start
  for (const dependent of getDependents(process.name)) {
    if (dependent.state === "pending" && areDependenciesMet(dependent)) {
      scheduleStart(dependent);
    }
  }

  // If this process failed (either directly or via dependency), cascade to dependents
  if (process.state === "failed" || process.state === "dependency-failed") {
    for (const dependent of getDependents(process.name)) {
      if (dependent.state === "pending") {
        dependent.state = "dependency-failed";
        // Cascade: this dependent's dependents also fail
        onProcessStateChange(dependent);
      }
    }
  }
}

function areDependenciesMet(process: Process): boolean {
  for (const dep of process.dependsOn ?? []) {
    const depProcess = getProcess(dep.process);
    const condition = dep.condition ?? inferDefaultCondition(depProcess);

    if (!meetsCondition(depProcess, condition)) {
      return false;
    }
  }
  return true;
}

function meetsCondition(process: Process, condition: DependencyCondition): boolean {
  switch (condition) {
    case "completed":
      return process.state === "stopped"; // exited with code 0
    case "healthy":
      if (process.healthCheck) {
        return process.state === "running" && process.healthCheckRunner.isHealthy();
      }
      return process.state === "running"; // fallback: running = healthy
    case "started":
      return ["running", "stopped", "failed"].includes(process.state);
  }
}

function inferDefaultCondition(process: Process): DependencyCondition {
  // If it's a task (never restarts), default to "completed"
  // If it's a long-running process, default to "healthy"
  return process.options.restartPolicy === "never" ? "completed" : "healthy";
}
```

### Dependency Failure Handling

When a dependency fails, all processes that depend on it are marked with the `dependency-failed` state. This cascades through the dependency graph:

```
install-ca (failed)
  └── db-migrate (dependency-failed)
        └── daemon (dependency-failed)
```

This makes it immediately clear why a process didn't start, rather than leaving it stuck in "pending" forever.

## Implementation Plan

### Phase 1: Add dependency support to processes

1. Add `dependsOn` field to `RestartingProcessEntry` schema
2. Implement dependency condition types (`completed`, `healthy`, `started`)
3. Add `dependency-failed` state to `RestartingProcessState`
4. Add dependency resolution logic to Manager
5. Register all processes immediately at startup (fix the 404 bug)

### Phase 2: Add health checks

1. Add `healthCheck` field to `RestartingProcessEntry` schema
2. Implement `HealthCheckRunner` class
3. Integrate health checks with `condition: "healthy"` dependency resolution
4. Add health status to API responses

### Phase 3: Unify state machines

1. Extend `RestartingProcessState` with `pending` state
2. Update Manager to start processes based on dependency resolution
3. Remove the "initializing" manager state (or make it mean "some processes pending")

### Phase 4: Remove tasks

1. Delete `task-list.ts`
2. Remove `tasks` from `ManagerConfig` schema
3. Remove tasks from Manager
4. Remove tasks from API contract
5. Update all internal configs (sandbox, docker)
6. Update tests

## Files to Modify

### Core changes

- `packages/pidnap/src/manager.ts` - Add dependency resolution, remove task-first startup
- `packages/pidnap/src/restarting-process.ts` - Add `pending` and `dependency-failed` states
- `packages/pidnap/src/task-list.ts` - Delete entirely
- `packages/pidnap/src/health-check.ts` - New file for health check logic

### Schema changes

- `packages/pidnap/src/manager.ts` - Update `ManagerConfig` schema (remove tasks, add dependsOn/healthCheck)
- `packages/pidnap/src/api/contract.ts` - Update API types, add health status

### Config updates

- `apps/os/sandbox/pidnap.config.ts` - Convert tasks to processes with dependencies
- `packages/pidnap/docker/pidnap.config.ts` - Convert tasks to processes with dependencies

## Proposed Tests

### Unit tests

```typescript
describe("Process dependencies", () => {
  it("should start process when all dependencies are met", async () => {
    const manager = new Manager(
      {
        processes: [
          { name: "task-a", definition: successProcess, options: { restartPolicy: "never" } },
          {
            name: "service-b",
            definition: longRunningProcess,
            options: { restartPolicy: "always" },
            dependsOn: [{ process: "task-a", condition: "completed" }],
          },
        ],
      },
      logger,
    );

    await manager.start();

    // service-b should wait for task-a
    expect(manager.getProcess("service-b")?.state).toBe("pending");

    // Wait for task-a to complete
    await waitFor(() => manager.getProcess("task-a")?.state === "stopped");

    // Now service-b should start
    await waitFor(() => manager.getProcess("service-b")?.state === "running");
  });

  it("should support healthy condition for long-running dependencies", async () => {
    const manager = new Manager(
      {
        processes: [
          { name: "proxy", definition: longRunningProcess, options: { restartPolicy: "always" } },
          {
            name: "daemon",
            definition: longRunningProcess,
            options: { restartPolicy: "always" },
            dependsOn: [{ process: "proxy", condition: "healthy" }],
          },
        ],
      },
      logger,
    );

    await manager.start();

    // daemon should wait for proxy to be running
    await waitFor(() => manager.getProcess("proxy")?.state === "running");
    await waitFor(() => manager.getProcess("daemon")?.state === "running");
  });

  it("should detect circular dependencies", async () => {
    expect(
      () =>
        new Manager(
          {
            processes: [
              { name: "a", definition: successProcess, dependsOn: [{ process: "b" }] },
              { name: "b", definition: successProcess, dependsOn: [{ process: "a" }] },
            ],
          },
          logger,
        ),
    ).toThrow(/circular dependency/i);
  });

  it("should register all processes immediately (no 404s)", async () => {
    const manager = new Manager(
      {
        processes: [
          {
            name: "slow-task",
            definition: timedProcess(1000),
            options: { restartPolicy: "never" },
          },
          { name: "daemon", definition: longRunningProcess, dependsOn: [{ process: "slow-task" }] },
        ],
      },
      logger,
    );

    await manager.start();

    // Both processes should be queryable immediately
    expect(manager.getProcess("slow-task")).toBeDefined();
    expect(manager.getProcess("daemon")).toBeDefined();
    expect(manager.getProcess("daemon")?.state).toBe("pending"); // waiting
  });

  it("should mark dependents as dependency-failed when dependency fails", async () => {
    const manager = new Manager(
      {
        processes: [
          { name: "task-a", definition: failureProcess, options: { restartPolicy: "never" } },
          {
            name: "service-b",
            definition: longRunningProcess,
            dependsOn: [{ process: "task-a" }],
          },
        ],
      },
      logger,
    );

    await manager.start();

    // Wait for task-a to fail
    await waitFor(() => manager.getProcess("task-a")?.state === "failed");

    // service-b should be marked as dependency-failed
    expect(manager.getProcess("service-b")?.state).toBe("dependency-failed");
  });

  it("should cascade dependency-failed through the graph", async () => {
    const manager = new Manager(
      {
        processes: [
          { name: "a", definition: failureProcess, options: { restartPolicy: "never" } },
          { name: "b", definition: longRunningProcess, dependsOn: [{ process: "a" }] },
          { name: "c", definition: longRunningProcess, dependsOn: [{ process: "b" }] },
        ],
      },
      logger,
    );

    await manager.start();
    await waitFor(() => manager.getProcess("a")?.state === "failed");

    expect(manager.getProcess("b")?.state).toBe("dependency-failed");
    expect(manager.getProcess("c")?.state).toBe("dependency-failed");
  });
});

describe("Health checks", () => {
  it("should wait for health check before starting dependent", async () => {
    let healthy = false;
    const manager = new Manager(
      {
        processes: [
          {
            name: "proxy",
            definition: longRunningProcess,
            healthCheck: async () => healthy,
          },
          {
            name: "daemon",
            definition: longRunningProcess,
            dependsOn: [{ process: "proxy", condition: "healthy" }],
          },
        ],
      },
      logger,
    );

    await manager.start();

    // proxy is running but not healthy
    await waitFor(() => manager.getProcess("proxy")?.state === "running");
    expect(manager.getProcess("daemon")?.state).toBe("pending");

    // Make proxy healthy
    healthy = true;
    await waitFor(() => manager.getProcess("daemon")?.state === "running");
  });
});
```

### Integration tests

```typescript
describe("API with dependencies", () => {
  it("should return pending state for blocked processes", async () => {
    // Start manager with slow dependency
    // Call API to get daemon status
    // Should return pending, not 404
  });

  it("should return dependency-failed state with reason", async () => {
    // Start manager with failing dependency
    // Call API to get dependent status
    // Should return dependency-failed
  });
});
```

## Rollout Plan

1. Implement in dev
2. Update internal configs (sandbox, docker)
3. Test in sandbox environment
4. Deploy to production
