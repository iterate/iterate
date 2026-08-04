---
status: done
size: small
---

# Mobile: stop package.json scripts changing the runtime fingerprint

**Status summary:** done and locally verified. One config file plus the re-landed `update:preview` fixes that the fingerprint gotcha forced out of PR #2410.

The expo-updates fingerprint runtime policy hashed `package.json` scripts: editing `update:preview` on PR #2410 moved the fingerprint from `37fb004c` to `f195c3d2`, which would have stranded every installed binary on stale JS despite zero native changes.

- [x] add `apps/mobile/fingerprint.config.js` with `sourceSkips: ["PackageJsonScriptsAll"]` _scripts never ship in the bundle; deps still count_
- [x] verify a scripts-only edit no longer changes the hash _`expo-updates fingerprint:generate` → `1bf9f0fe` with and without a script edit_
- [x] re-land the `update:preview` fixes reverted from #2410 _`--message "$(git log -1 --format=%s)"` (eas requires --message when non-interactive) and `--clear-cache` (Metro's shared cache leaks absolute paths across worktrees — see #2410's task notes)_

## Implementation notes

- Landing this changes the fingerprint once (`37fb004c` → `1bf9f0fe`-ish as computed on merge): the merge-to-main workflow will detect no matching preview build and auto-trigger one — Misha reinstalls one more time, then script edits are permanently fingerprint-neutral.
