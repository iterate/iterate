---
status: done
size: small
follows-up: https://github.com/iterate/iterate/pull/1715
---

# LOC report: respect linguist-generated=true

## Status summary

Done, merged in PR #1718. Follow-up to #1715: files marked `linguist-generated=true` via
`.gitattributes` land in the "Generated" group, queried from git at runtime - no glob list to
keep in sync.

## Motivation

The LOC report's "Generated" group is a hardcoded glob, but the repo already declares what's
generated: `.gitattributes` marks `**/pnpm-lock.yaml`, `**/db/migrations/meta/*`,
`.github/workflows/*`, and `**/routeTree.gen.ts` as `linguist-generated=true` (it's what makes
GitHub collapse them in diffs). The report should agree with that single source of truth.

## Spec

- [x] Files with the `linguist-generated` attribute set land in the "Generated" group,
      regardless of glob matching order (generated beats every other group, including Tests).
- [x] No sync step to forget: query git at runtime with one batched
      `git check-attr linguist-generated --stdin -z` call for all changed files.
- [x] Drop `pnpm-lock.yaml` from the Generated glob — it's covered by `.gitattributes` now.
      Keep `**/.generated/**`, `**/generated/**`, `**/*.generated.*` since those aren't marked
      in `.gitattributes`.
- [x] Local mode (`pnpm tsx scripts/ci/loc-report.ts [base] [head]`) behaves identically.

## Decisions / assumptions (made while AFK)

- **Runtime `git check-attr` instead of eslint-plugin-codegen.** The prompt suggested codegen
  to keep a glob list in sync with `.gitattributes`; asking git directly is simpler and can't
  drift — it also honors nested `.gitattributes` files if any appear later, and any attribute
  value semantics (`true`/`set` count, `false`/`unspecified` don't). Codegen would add a lint
  dependency and a failure mode (out-of-date generated block) for no gain.
- `.github/workflows/*` is marked linguist-generated in this repo (legacy of the old TS
  workflow generator), so `claude-assistant.yml` changes will count as Generated rather than
  CI & scripts. The report honors the attribute; if that's wrong, fix `.gitattributes`.
- `git check-attr` consults the checked-out `.gitattributes`, so results reflect the head
  commit's attributes (CI checks out the PR head). Deleted files still resolve fine because
  attribute lookup doesn't need the file to exist.

## Implementation log

- `getChangedFiles` marks each file via one `git check-attr --stdin -z linguist-generated`
  call; `computeReport` routes marked files straight to the Generated group before glob
  matching. `ChangedFile` gained a required `generated` boolean.
- Verified against real merged commits: `fd0793b74` (routeTree.gen.ts -> Generated, previously
  Product) and `b35a93f0a` (pnpm-lock.yaml still Generated via the attribute after removing it
  from the glob).
