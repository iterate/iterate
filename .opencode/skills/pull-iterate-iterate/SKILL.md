---
name: pull-iterate-iterate
description: Pull latest iterate/iterate code onto a running machine and restart the daemon.
publish: false
---

# Pull iterate/iterate

Pull the latest iterate/iterate code onto this machine, install dependencies, run post-sync steps, and restart the daemon.

## Context

The iterate/iterate repo lives at `$ITERATE_REPO` (default: `/home/iterate/src/github.com/iterate/iterate`). It was baked into the Docker image at build time with a synthetic git history (single "snapshot" commit). A git remote `origin` points to `https://github.com/iterate/iterate`.

**On older machines** the remote may not exist yet. If so, add it:

```bash
git -C "$ITERATE_REPO" remote add origin https://github.com/iterate/iterate
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

### 3. Reset to the fetched ref

```bash
git checkout -B main FETCH_HEAD
git reset --hard FETCH_HEAD
```

This detaches from whatever synthetic history existed and points to the real commit.

### 4. Install dependencies

```bash
pnpm install --frozen-lockfile --prefer-offline
```

If `--frozen-lockfile` fails (lockfile changed), retry without it:

```bash
pnpm install --prefer-offline
```

### 5. Run post-sync steps

```bash
bash "$ITERATE_REPO/sandbox/after-repo-sync-steps.sh"
```

This handles:

- Syncing home skeleton files
- Rebuilding daemon frontend (`pnpm vite build` in `apps/daemon`)
- Running database migrations (`pnpm db:migrate` in `apps/daemon`)

### 6. Report result

Print the new HEAD SHA and a summary of what changed:

```bash
echo "Updated to: $(git log --oneline -1)"
echo "Previous: <old sha from step 2>"
```

### 7. Restart the daemon

The daemon must restart to pick up the new code. Call the local daemon restart endpoint:

```bash
curl -fsS -X POST "http://127.0.0.1:${PORT:-3001}/api/orpc/daemon.restartDaemon" \
  -H "Content-Type: application/json" \
  --data '{}' || true
```

The `|| true` is important -- the daemon process will exit, which may cause the curl to fail. That's expected. Pidnap/s6 will restart it with the new code.

## Error handling

- If `git fetch` fails: check network, check if origin remote exists (add it if missing), retry.
- If `pnpm install` fails: try `pnpm install` without `--frozen-lockfile`. If that also fails, report the error.
- If `after-repo-sync-steps.sh` fails: report which step failed (skeleton sync, frontend build, or migrations). The daemon should still restart so the machine isn't stuck on old code -- migrations can be retried on next pull.
- If any step fails catastrophically, still attempt the daemon restart so the machine doesn't get stuck.
