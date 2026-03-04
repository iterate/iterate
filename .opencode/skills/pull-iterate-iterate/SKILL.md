---
name: pull-iterate-iterate
description: Pull latest iterate/iterate code onto a running machine and restart affected processes.
publish: false
---

# Pull iterate/iterate

Pull the latest iterate/iterate code onto this machine, install dependencies, run post-sync steps, and restart the processes that run iterate/iterate code.

## Context

The iterate/iterate repo lives at `$ITERATE_REPO` (default: `/home/iterate/src/github.com/iterate/iterate`). It was baked into the Docker image at build time with a synthetic git history (single "snapshot" commit). A git remote `origin` points to `https://github.com/iterate/iterate.git`.

**On older machines** the remote may not exist yet. If so, add it:

```bash
git -C "$ITERATE_REPO" remote add origin https://github.com/iterate/iterate.git
```

## Steps

### 1. Fetch the target ref

The ref to pull is provided in the prompt (defaults to `main`).

```bash
cd "$ITERATE_REPO"
git fetch origin <ref>
```

### 2. Check current state

```bash
git status
git log --oneline -1
```

If there are local uncommitted changes:

- These shouldn't exist on production machines. Run `git stash` to save them, then proceed.
- After reset, the stash is available if needed but don't pop it automatically.

### 3. Switch to the branch and reset to the fetched ref

```bash
git checkout -B <ref> origin/<ref>
```

This creates or resets the local branch to match the remote, just like a normal `git checkout` workflow. The local branch name will reflect the actual remote branch (e.g. `main`, `greetinghello`, etc.).

### 4. Check if lockfile changed

```bash
cd "$ITERATE_REPO"
git diff <old-sha>..HEAD --name-only -- pnpm-lock.yaml
```

If the output is empty, the lockfile hasn't changed — `pnpm install` can be **skipped entirely** (the `node_modules` baked into the image are still valid). Set a variable like `LOCKFILE_CHANGED=true/false` to use in the next step.

### 5. Install dependencies (if needed) and run post-sync steps

**If the lockfile changed**, run install + post-sync as a single command:

```bash
cd "$ITERATE_REPO" && pnpm install --prefer-offline && bash "$ITERATE_REPO/sandbox/after-repo-sync-steps.sh"
```

**If the lockfile did NOT change**, skip `pnpm install` and just run post-sync:

```bash
cd "$ITERATE_REPO" && bash "$ITERATE_REPO/sandbox/after-repo-sync-steps.sh"
```

The timeout for either command should be at least 300 seconds (5 minutes). Pass `timeout: 300000` if using execCommand.

**If `pnpm install` fails but the lockfile didn't change**: this means something is wrong with the npm registry or network, but the existing `node_modules` should be fine. Proceed to post-sync steps and process restarts anyway — the code will still work.

**If `pnpm install` fails AND the lockfile changed**: report the error but still proceed to post-sync + restarts. New code with wrong deps is better than old code — the processes will crash-loop if deps are truly incompatible, but often the lockfile change is minor (patch bumps) and old deps still work.

Post-sync steps handle:

- Syncing home skeleton files
- Rebuilding daemon frontend (`pnpm vite build` in `apps/daemon`)
- Running database migrations (`pnpm db:migrate` in `apps/daemon`)

### 6. Report result

Print the new HEAD SHA and a summary of what changed:

```bash
echo "Updated to: $(git log --oneline -1)"
echo "Previous: <old sha from step 2>"
```

### 7. Restart processes that run iterate/iterate code

Use pidnap's HTTP API to restart only the processes that run our TypeScript code. Other processes (egress-proxy, opencode, jaeger, archil, cloudflare-tunnel) are external binaries and don't need restarting.

Restart these 4 processes:

```bash
PIDNAP_URL="http://127.0.0.1:9876/rpc"

for proc in daemon-backend project-ingress-proxy events daemon-frontend; do
  echo "Restarting $proc..."
  curl -fsS -X POST "$PIDNAP_URL/processes.restart" \
    -H "Content-Type: application/json" \
    --data "{\"target\": \"$proc\", \"force\": true}" || echo "Warning: failed to restart $proc"
done
```

**Note:** `daemon-frontend` serves a static vite build — step 5 already rebuilt it, so restarting the preview server picks up the new build output.

**Note:** `force: true` skips backoff delay so the process restarts immediately.

After restarting, verify the processes are running:

```bash
curl -fsS "$PIDNAP_URL/processes.list" | jq '.[] | {name, state}'
```

### 8. (Rare) If pidnap's own code changed

If the pull included changes to `packages/pidnap/`, pidnap itself needs to restart. This is rare — most pulls only change app code. If needed:

```bash
kill 1
```

This kills tini → pidnap → all children. The container will stop (there is no restart loop). The platform will need to start a new container or the machine will need manual intervention. Only do this if the pull specifically changed pidnap code.

## Error handling

- If `git fetch` fails: check network, check if origin remote exists (add it if missing), retry.
- If `pnpm install` fails and lockfile didn't change: **skip it** and proceed to post-sync + restarts. The existing `node_modules` are still valid.
- If `pnpm install` fails and lockfile changed: report the error but **still proceed** to post-sync + restarts. New code with slightly wrong deps is better than being stuck on old code. Processes will crash-loop if deps are truly incompatible, and the next pull can fix it.
- If `after-repo-sync-steps.sh` fails: report which step failed (skeleton sync, frontend build, or migrations). Still proceed with the process restarts — the new code is checked out and deps are installed, so processes will at least start. Migrations can be retried on next pull.
- If a process restart fails: report which process failed. The machine is still functional — the failed process will be on old code but other processes will have restarted.

**Key principle: always get to the restart step.** A failed `pnpm install` should never prevent process restarts. The goal is to get new code running as fast as possible — partial updates beat no updates.
