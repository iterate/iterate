---
name: pull-iterate-iterate
description: Pull latest iterate/iterate code onto a running machine and restart affected processes.
publish: false
---

# Pull iterate/iterate

Pull the latest iterate/iterate code onto this machine, install dependencies, run post-sync steps, and restart the processes that run iterate/iterate code.

## How to execute

**One-shot it.** Run the entire script below as a single bash command (with `timeout: 300000`). Replace `<REF>` with the target ref from the prompt (defaults to `main`). Do NOT use the todowrite tool, do NOT break this into multiple calls, do NOT read files to "understand" the steps — just run the script.

Only fall back to interactive debugging if the one-shot script fails.

```bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"
REF="<REF>"

cd "$ITERATE_REPO"

# Ensure origin remote exists (older machines may not have it)
git remote get-url origin 2>/dev/null || git remote add origin https://github.com/iterate/iterate

# Record current state
OLD_SHA=$(git rev-parse --short HEAD)
echo "Current: $OLD_SHA ($(git branch --show-current))"

# Stash any local changes (shouldn't exist on prod, but be safe)
git diff --quiet || git stash

# Fetch and checkout
git fetch origin "$REF"
git checkout -B "$REF" "origin/$REF"

NEW_SHA=$(git rev-parse --short HEAD)
echo "Updated: $OLD_SHA -> $NEW_SHA (branch: $REF)"

# Install deps only if lockfile changed
if git diff "$OLD_SHA..HEAD" --name-only -- pnpm-lock.yaml | grep -q .; then
  echo "Lockfile changed — running pnpm install"
  pnpm install --prefer-offline || echo "WARNING: pnpm install failed, proceeding anyway"
else
  echo "Lockfile unchanged — skipping pnpm install"
fi

# Post-sync: skeleton sync, frontend rebuild, db migrations
bash "$ITERATE_REPO/sandbox/after-repo-sync-steps.sh"

# Restart the 4 processes that run iterate/iterate TypeScript code.
# Do NOT use curl — pidnap's HTTP API uses oRPC with a non-obvious wire format.
for proc in daemon-backend project-ingress-proxy events daemon-frontend; do
  echo "Restarting $proc..."
  pidnap process restart "$proc" --force || echo "WARNING: failed to restart $proc"
done

# Verify
pidnap process list

echo "Done. $OLD_SHA -> $NEW_SHA on branch $REF"
```

## If the one-shot fails

Read the error output and fix the specific issue:

- **`git fetch` fails**: check network, check if origin remote exists (the script handles this, but if the URL is wrong, fix it).
- **`pnpm install` fails**: the script already continues past this. If deps are truly broken, the processes will crash-loop — the next pull can fix it.
- **`after-repo-sync-steps.sh` fails**: check which sub-step failed (skeleton sync, vite build, or db:migrate). Fix and re-run just that step.
- **`pidnap process restart` fails**: try `pidnap process list` to see process states. A process might already be stopped or in an error state.

## Rare: if pidnap's own code changed

If the pull included changes to `packages/pidnap/`, pidnap itself needs to restart. This is rare — most pulls only change app code. If needed:

```bash
kill 1
```

This kills tini -> pidnap -> all children. The container will stop. The platform will need to start a new container.
