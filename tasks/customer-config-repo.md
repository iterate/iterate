---
state: todo
---

# Customer Config Repo

## Goal

Allow customers to connect their GitHub account and choose a repo as their config repo (the "iterate repo"). Currently we use `repo-templates/default` to find and load `iterate.config.ts` — we want the customer to specify this.

## What this allows

- Load `iterate.config.ts` from the customer's repo
- Allow customers to specify processes they want to run when the machine starts
- In future, store skills, tools, etc in the repo
- Allow Iterate to modify this repo and make PRs against it to change its own config

## Scope (v1)

- Single config repo per project (no multi-repo support)
- Main branch only (no branch selection or PR previews)
- If no config repo is connected, fall back to default config

## DB changes

- Add `configRepoId` FK on `project` table pointing to a `project_repo` row (one config repo per project)
- The existing `project_repo` table already stores connected repos — no schema change needed there

## Boot flow

1. Daemon boots with baked-in code (sandbox image already has the iterate monorepo)
2. Daemon calls OS via oRPC to get config repo info (repo URL, branch, fresh installation token)
3. Daemon clones the config repo locally
4. Daemon loads `iterate.config.ts` from the cloned repo
5. Daemon reconciles pidnap processes based on loaded config

This is a single-phase boot — no setup push or 2-phase restart needed. The daemon is self-sufficient: it calls out to OS for what it needs.

## Config reload on push

1. GitHub webhook fires on push to main → OS already receives these webhooks
2. OS forwards the event to the daemon (via oRPC procedure on daemon)
3. Daemon calls OS oRPC to get a fresh installation token (tokens expire ~1hr)
4. Daemon runs `git pull` on the config repo
5. Daemon reloads `iterate.config.ts` and reconciles pidnap processes

## Error handling

- If the config repo has no `iterate.config.ts` or it fails to import: daemon reports error to OS for display to the user
- If OS is unreachable on boot: daemon cannot start (acceptable — OS being down breaks egress anyway)

## Implementation as oRPC procedures

Per architectural preference: any logic running in the sandbox should be an oRPC procedure. This means:

- Config repo clone/pull = oRPC procedure on daemon, callable via `iterate exec-ts daemon.cloneConfigRepo()` or similar
- OS endpoint to get config repo info + fresh token = oRPC procedure on OS worker

## What needs to happen

1. **DB migration**: add `configRepoId` column to `project` table
2. **OS oRPC endpoint**: return config repo info (clone URL, branch, installation token) for a given project/machine
3. **Daemon oRPC procedure**: clone config repo, load config, reconcile processes
4. **Daemon startup (`start.ts`)**: call OS to get config, clone repo, then `loadConfig(repoPath)` instead of falling back to `repo-templates/default`
5. **UI**: add config repo selection in project settings (pick from repos accessible via GitHub App installation)
6. **Webhook forwarding**: OS receives GitHub push webhooks already — add handler to forward to daemon for config reload
7. **Error reporting**: daemon reports config load failures to OS for user-facing display
