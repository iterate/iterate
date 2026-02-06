---
state: todo
priority: high
size: large
tags:
  - durable-objects
  - machine-provider
  - reliability
  - monitoring
---

# Automated Machine Monitoring with Durable Objects

Build OS-side machine monitoring infrastructure using Durable Objects for health tracking, self-healing, and machine lifecycle management.

## Problem

Machines can become unhealthy (daemon crashes, code drift, resource exhaustion) with no automated detection or recovery. Need centralized monitoring that can detect issues and attempt automated remediation.

## Solution

### 1. Machine Durable Object Base Class

Create new `Machine` DO base class implemented by provider-specific DOs:

```typescript
// New file: apps/os/backend/workers/alchemy.run.ts (or similar)

export abstract class Machine extends DurableObject {
  abstract start(): Promise<void>
  abstract stop(): Promise<void>
  abstract restart(): Promise<void>
  abstract getHealth(): Promise<MachineHealth>
  abstract executeCommand(cmd: string): Promise<CommandResult>
  // Typesafe pidnap/daemon interaction methods
}

export class LocalDockerMachine extends Machine { ... }
export class DaytonaMachine extends Machine { ... }
```

Export all from new worker in `alchemy.run.ts`.

### 2. Health Monitoring with Alarms

Machine DO uses Cloudflare alarms to monitor health regularly:

```typescript
class Machine extends DurableObject {
  async alarm() {
    const health = await this.checkHealth();
    await this.recordHealthSnapshot(health);

    if (!health.healthy) {
      await this.attemptRecovery(health);
    }

    // Schedule next check
    await this.storage.setAlarm(Date.now() + 30_000);
  }
}
```

### 3. Health Snapshot Mapping

Track health over time with version correlation:

```typescript
interface HealthSnapshot {
  timestamp: number;
  machineImageHash: string; // Docker image / Daytona snapshot
  iterateRepoHash: string; // Daemon code version
  customerRepoHash?: string; // If applicable
  healthy: boolean;
  services: ServiceStatus[];
  metrics: ResourceMetrics;
}
```

Store mapping: `(timestamp, versions) -> works/doesn't work` for rollback decisions.

### 4. Escalating Recovery Protocol

When daemon is unhealthy, attempt fixes in order:

```typescript
async attemptRecovery(health: MachineHealth) {
  // Level 1: Restart services via pidnap
  if (await this.restartViasPidnap()) return

  // Level 2: Restore to last known working git versions
  if (await this.restoreKnownGoodVersions()) return

  // Level 3: Full machine restart
  if (await this.restartMachine()) return

  // Level 4: Signal permanent failure, request substitution from Project DO
  await this.project.onMachineBricked({
    machineId: this.id,
    lastHealth: health,
    recoveryAttempts: this.recoveryAttempts,
  })
}
```

#### Level 1: Pidnap Service Restart

- Call daemon's pidnap integration to restart unhealthy services
- Wait for health check to pass

#### Level 2: Git Version Restore

- Look up last known working `(iterateRepoHash, customerRepoHash)` from health snapshots
- Checkout those versions, reinstall deps, restart daemon

#### Level 3: Full Machine Restart

- For Daytona: stop/start workspace
- For local-docker: restart container

#### Level 4: Request Substitution

- Mark machine as permanently bricked in state
- Notify parent `Project` DO to substitute machine

### 5. Typesafe Daemon/Pidnap Interaction via oRPC

Machine DO uses typesafe pidnap oRPC client for daemon interaction:

```typescript
class Machine extends DurableObject {
  // oRPC client for typesafe pidnap communication
  private pidnapClient: PidnapORPCClient;

  // Lifecycle
  async start(): Promise<void>;
  async stop(): Promise<void>;
  async restart(): Promise<void>;

  // Health
  async getHealth(): Promise<MachineHealth>;
  async getDaemonVersion(): Promise<string>;

  // Pidnap (via oRPC client)
  async listServices(): Promise<Service[]> {
    return this.pidnapClient.services.list();
  }
  async restartService(name: string): Promise<void> {
    return this.pidnapClient.services.restart({ name });
  }
  async getServiceLogs(name: string, lines?: number): Promise<string> {
    return this.pidnapClient.services.logs({ name, lines });
  }

  // Code management
  async refreshCode(targetRef: string): Promise<void>;
  async getCurrentVersions(): Promise<VersionInfo>;
}
```

### 6. Project Durable Object - Machine Substitution

`Project` DO manages machine fleet and can substitute bricked machines:

```typescript
class Project extends DurableObject {
  async onMachineBricked(machineId: string) {
    // Mark old machine for cleanup
    await this.markMachineForCleanup(machineId);

    // Provision replacement machine
    const newMachine = await this.provisionMachine({
      copyStateFrom: machineId, // If possible
    });

    // Update routing to new machine
    await this.updateMachineMapping(machineId, newMachine.id);

    // Notify relevant parties
    await this.notifyMachineSubstitution(machineId, newMachine.id);
  }
}
```

## Implementation Order

1. Create `Machine` base class with basic start/stop/restart
2. Implement `LocalDockerMachine` and `DaytonaMachine` extending base
3. Add health check infrastructure and alarm scheduling
4. Implement health snapshot storage
5. Add Level 1 recovery (pidnap restart)
6. Add Level 2 recovery (version restore)
7. Add Level 3 recovery (machine restart)
8. Create `Project` DO with substitution logic
9. Add Level 4 recovery (substitution request)

## Related

- `apps/os/backend/providers/` - existing machine provider implementations
- `apps/daemon/server/` - daemon tRPC router
- `packages/pidnap/` - process management
- Task: `machine-health-metrics-clickhouse.md` - metrics storage
- Task: `machine-code-refresh.md` - code refresh mechanism
