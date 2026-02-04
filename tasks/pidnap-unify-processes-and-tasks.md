---
state: pending
priority: high
size: large
---

# Pidnap: Unify Processes and Tasks

## Summary

Remove the distinction between "tasks" and "processes" in pidnap. Instead, have a single `process` abstraction with a `restartPolicy` parameter that controls restart behavior. A "task" becomes simply a process with `restartPolicy: "never"`.

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

### Option A: Unified Process with Dependencies (Recommended)

Merge tasks into processes with an explicit dependency system.

#### Config Schema

```typescript
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
  dependsOn: v.optional(
    v.array(
      v.object({
        process: v.string(), // Name of the dependency
        condition: v.optional(
          v.picklist([
            "completed", // Dependency exited with code 0 (for tasks)
            "healthy", // Dependency is running (for long-running processes)
            "started", // Dependency has started at least once
          ]),
        ), // defaults to "completed" for restartPolicy:"never", "healthy" otherwise
      }),
    ),
  ),
});
```

#### Example Config

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
    // Long-running process that depends on tasks
    {
      name: "egress-proxy",
      definition: { command: "mitmdump", args: [...] },
      options: { restartPolicy: "always" },
      dependsOn: [{ process: "install-ca-certs", condition: "completed" }],
    },
    // Long-running process that depends on another long-running process
    {
      name: "daemon",
      definition: { command: "tsx", args: ["server.ts"] },
      options: { restartPolicy: "always" },
      dependsOn: [
        { process: "db-migrate", condition: "completed" },
        { process: "egress-proxy", condition: "healthy" },
      ],
    },
  ],
});
```

#### State Machine

Unified states for all processes:

```typescript
type ProcessState =
  | "pending" // Waiting for dependencies
  | "starting" // Process is starting up
  | "running" // Process is running
  | "stopping" // Being stopped
  | "stopped" // Exited normally (code 0)
  | "failed" // Exited with error (code != 0)
  | "restarting" // Waiting to restart (backoff delay)
  | "crash-loop-backoff"
  | "max-restarts-reached"
  | "blocked"; // Dependencies not met (optional, could use "pending")
```

#### Dependency Resolution Algorithm

```typescript
// On any process state change:
function onProcessStateChange(process: Process) {
  for (const dependent of getDependents(process.name)) {
    if (areDependenciesMet(dependent)) {
      scheduleStart(dependent);
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
      return process.state === "running";
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

### Option B: Simpler Ordered Groups

Instead of full dependency trees, just allow ordered groups:

```typescript
export default defineConfig({
  // Phase 1: All run in parallel, must all complete before phase 2
  setup: [
    { name: "install-ca-certs", definition: bash("...") },
    { name: "git-config", definition: bash("...") },
  ],
  // Phase 2: All run in parallel, must all complete before services
  migrations: [
    { name: "db-migrate", definition: { command: "pnpm", args: ["db:migrate"] } },
  ],
  // Phase 3: Long-running services
  services: [
    { name: "egress-proxy", definition: {...}, options: { restartPolicy: "always" } },
    { name: "daemon", definition: {...}, options: { restartPolicy: "always" } },
  ],
});
```

**Pros**: Simpler to understand, less code
**Cons**: Less expressive, can't model "daemon depends on proxy but not on CA certs"

### Recommendation

**Option A** - The dependency graph approach is more expressive and better models real-world requirements. It's also closer to how Docker Compose works (which users may be familiar with).

## Migration Path

### Backward Compatibility

Support both old and new config formats during a transition period:

```typescript
// Old format (deprecated)
{
  tasks: [...],
  processes: [...],
}

// New format
{
  processes: [...], // includes former tasks with restartPolicy: "never"
}
```

When old format detected, automatically convert:

1. Tasks become processes with `restartPolicy: "never"`
2. All original processes implicitly depend on all tasks (preserving current behavior)
3. Log deprecation warning

### Example Migration

**Before:**

```typescript
defineConfig({
  tasks: [
    { name: "install-ca", definition: bash("...") },
    { name: "db-migrate", definition: { command: "pnpm", args: ["db:migrate"] } },
  ],
  processes: [
    { name: "daemon", definition: {...}, options: { restartPolicy: "always" } },
  ],
})
```

**After:**

```typescript
defineConfig({
  processes: [
    {
      name: "install-ca",
      definition: bash("..."),
      options: { restartPolicy: "never" },
    },
    {
      name: "db-migrate",
      definition: { command: "pnpm", args: ["db:migrate"] },
      options: { restartPolicy: "never" },
      dependsOn: [{ process: "install-ca" }],
    },
    {
      name: "daemon",
      definition: {...},
      options: { restartPolicy: "always" },
      dependsOn: [
        { process: "install-ca", condition: "completed" },
        { process: "db-migrate", condition: "completed" },
      ],
    },
  ],
})
```

## Implementation Plan

### Phase 1: Add dependency support to processes

1. Add `dependsOn` field to `RestartingProcessEntry` schema
2. Implement dependency condition types
3. Add dependency resolution logic to Manager
4. Register all processes immediately at startup (fix the 404 bug)

### Phase 2: Unify state machines

1. Extend `RestartingProcessState` with `pending`/`blocked` states
2. Update Manager to start processes based on dependency resolution
3. Remove the "initializing" manager state (or make it mean "some processes pending")

### Phase 3: Deprecate tasks

1. Add config migration that converts tasks to processes
2. Log deprecation warning when tasks array is used
3. Update all internal configs (sandbox, docker)

### Phase 4: Remove tasks

1. Delete `task-list.ts`
2. Remove tasks from Manager
3. Remove tasks from API contract
4. Update tests

## Files to Modify

### Core changes

- `packages/pidnap/src/manager.ts` - Add dependency resolution, remove task-first startup
- `packages/pidnap/src/restarting-process.ts` - Add "pending" state
- `packages/pidnap/src/task-list.ts` - Eventually delete

### Schema changes

- `packages/pidnap/src/manager.ts` - Update `ManagerConfig` schema
- `packages/pidnap/src/api/contract.ts` - Update API types

### Config updates

- `apps/os/sandbox/pidnap.config.ts` - Migrate to new format
- `packages/pidnap/docker/pidnap.config.ts` - Migrate to new format

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

  it("should support backward compatible config with tasks array", async () => {
    const manager = new Manager(
      {
        tasks: [{ name: "setup", definition: successProcess }],
        processes: [{ name: "daemon", definition: longRunningProcess }],
      },
      logger,
    );

    // Should work, with daemon implicitly depending on setup
    await manager.start();
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
});
```

## Open Questions

1. **Health checks**: Should we add health check support as part of this? The "healthy" condition currently just means "running", but a proper health check (HTTP, command, etc.) would be more robust.

2. **Dependency failure handling**: What happens when a dependency fails?
   - Option A: Block dependent forever (current implicit behavior)
   - Option B: Mark dependent as failed too
   - Option C: Configurable per-dependency

3. **Restart cascading**: When a dependency restarts, should dependents restart too?
   - For "healthy" condition: probably yes
   - For "completed" condition: probably no

4. **API changes**: Should the API expose dependency information? Current contract doesn't have it.

## Rollout Plan

1. Implement behind feature flag (or just in dev)
2. Migrate internal configs
3. Test in sandbox environment
4. Remove feature flag
5. After 1-2 releases, remove deprecated tasks support
