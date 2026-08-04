---
status: done
size: small
---

# Build info: show the commit message

**Status summary:** done. Three-file change (stamp script, placeholder, screen row), published to the preview channel as the first live test of the agent-PR → phone flow. Surfaced two publish-flow gotchas, noted below; one has a follow-up task.

The Build info screen shows branch/commit/author/time but not *what* the commit was. A hash means nothing at a glance; the subject line is the human-readable identity of the bundle. Add it.

- [x] stamp `message` (commit subject) in `apps/mobile/scripts/write-build-info.mjs` _via `git log -1 --format=%s`, sliced to 200 chars; "" on EAS's .git-less archive like the other fields_
- [x] add `message` to the checked-in placeholder `apps/mobile/src/build-info.json`
- [x] render a Message row in the Bundle section of `apps/mobile/src/app/build-info.tsx` _between Commit and Built by_
- [x] publish the branch to the preview channel so the installed app can pull it via Check for update _published update `019fcd58-d5e5` (runtime `37fb004c`, matching build `50ae8bb1`) from commit 4adf339_

## Implementation notes

- **Metro cache is poisoned across worktrees.** The first `eas update` export failed because a `use dom` entry in the shared cache pointed at the root worktree's absolute path. `--clear-cache` fixes it; any worktree-hopping publish needs it.
- **`eas update` requires `--message` in non-interactive shells.** The local `update:preview` script didn't pass one, so it only works from a TTY. Tried fixing with `--message "$(git log -1 --format=%s)"` in the script and hit the bigger gotcha:
- **The runtime fingerprint hashes `package.json` scripts.** Editing `update:preview` changed the fingerprint from `37fb004c` to `f195c3d2`, which would strand every installed binary despite zero native changes. Reverted the script edit from this PR to keep the flow test honest (update `019fcd57` on the orphaned runtime is harmless). Follow-up: add a fingerprint config with `sourceSkips` for package.json scripts, then land the `--message` fix — spawned as a separate task.
