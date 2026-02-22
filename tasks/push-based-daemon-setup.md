---
state: in-progress
priority: high
size: large
---

# Push-based daemon setup (kill fetchBootstrapData)

## Problem

Daemon does too much on startup: reports ready, pulls env vars via `getEnv`, applies them, clones repos, reconciles pidnap, runs a 30-min refresh scheduler. Makes it complex, slow, and tightly coupled to the OS data model.

## New model

**Daemon:** starts listening, reports "ready", done. Tiny, fast, dumb.

**OS:** reacts to "daemon is ready" by pushing setup data via new tRPC procedures (`tool.writeFile`, `tool.execCommand`).

## Daemon changes

### 1. Add `tool.writeFile` procedure

`tool.writeFile({ path: string, content: string, mode?: number }) → { path, bytesWritten }`

- Resolves `~` to homedir
- `mkdir -p` parent
- Default mode 0o644

### 2. Add `tool.execCommand` procedure

`tool.execCommand({ command: string[] }) → { exitCode, stdout, stderr }`

- First element = binary, rest = args
- Uses `tinyexec`, timeout 120s
- Positional for CLI

### 3. Simplify `start.ts`

`bootstrapWithControlPlane` → just `reportStatusToPlatform()` + `startCronTaskScheduler()`.

### 4. Delete bootstrap machinery

- Delete `bootstrap-refresh.ts`
- Remove `refreshEnv` from `platformRouter`
- Remove `applyEnvVars`, `cloneRepos`, `cloneRepoInternal`, `clearGitHubCredentials`, `buildProxyAndCaLines`, `platformEnvVars` from `platform.ts`

## OS changes

### 5. New event: `machine:setup-pushed`

In `outbox/client.ts`.

### 6. New consumer: `pushMachineSetup`

On `machine:daemon-status-reported`, guarded `status === "ready" && externalId`.

- Build daemon tRPC client
- Generate `.env` content on OS side (port `buildProxyAndCaLines` + dotenv formatting from daemon)
- Call `tool.writeFile({ path: "~/.iterate/.env", content, mode: 0o600 })`
- For each repo: `tool.execCommand({ command: ["git", "clone", "--branch", branch, "--single-branch", url, path] })`
- Emit `machine:setup-pushed`

### 7. Change `sendReadinessProbe` trigger

From `machine:daemon-status-reported` → `machine:setup-pushed`. Keep delay for opencode restart.

### 8. Update `pokeRunningMachinesToRefresh`

Instead of calling `refreshEnv`, build `.env` content + call `tool.writeFile` directly.

### 9. Port env file builder to OS

Move `buildProxyAndCaLines` + dotenv formatting into `apps/os/backend/utils/env-file-builder.ts`.

### 10. Remove `getEnv` from oRPC contract

Daemon no longer calls it. OS calls the logic internally via the consumer.

## Ordering

```
machine:created → provisionMachine
  → daemon boots, reports "ready"
    → machine:daemon-status-reported
      → pushMachineSetup (no delay): writes .env, clones repos
        → machine:setup-pushed
          → sendReadinessProbe (delay ~15-30s)
            → probe pipeline (unchanged)
```

## What stays the same

- `buildMachineEnvVars` for sandbox creation (initial container env vars)
- Credential helper + mitmproxy chain for git auth
- `ITERATE_OS_BASE_URL/API_KEY/MACHINE_ID` injected at sandbox creation
- Probe pipeline after sendReadinessProbe

## Decisions

- `reconcilePidnapProcesses`: removed — pidnap watches `.env`, restarts on change
- `clearGitHubCredentials`: removed — legacy cleanup, no longer needed
- Cron task scheduler: starts unconditionally on daemon boot
- Pidnap lifecycle events to OS: out of scope for now
