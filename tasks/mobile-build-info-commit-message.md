---
status: in-progress
size: small
---

# Build info: show the commit message

**Status summary:** spec committed first; implementation is a three-file change. Doubles as a test run of the "get an agent PR's build onto Misha's phone" flow.

The Build info screen shows branch/commit/author/time but not *what* the commit was. A hash means nothing at a glance; the subject line is the human-readable identity of the bundle. Add it.

- [ ] stamp `message` (commit subject) in `apps/mobile/scripts/write-build-info.mjs`
- [ ] add `message` to the checked-in placeholder `apps/mobile/src/build-info.json`
- [ ] render a Message row in the Bundle section of `apps/mobile/src/app/build-info.tsx`
- [ ] publish the branch to the preview channel (`pnpm --dir apps/mobile update:preview` from the worktree) so the installed app can pull it via Check for update — the flow test: if the Message row shows this PR's commit subject, the loop works

## Notes

- On EAS build machines there's no `.git` (archive checkout) and no commit-message env var, so `message` falls back to `""` there — same convention as the other fields (empty = unstamped/unknown).
- Publishing a PR branch to the shared `preview` channel hijacks it until the next main merge re-publishes. Acceptable while the only phone is Misha's; a per-branch flow is future work.
