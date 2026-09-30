---
status: done
size: small
---

# apps/os stops importing `@iterate-com/shared/dev/is-main-module`

Pre-work item 3 for moving apps/os into `core/` (the packages/shared question), first slice.

Status: done. The slice shrank: see "What changed from the plan".

## Checklist

- [x] `dev/is-main-module`: apps/os/scripts/getin.ts drops its guard (trpc-cli, given
      `...import.meta`, already runs only when the file is the entry point); apps/os/scripts/build.ts
      uses Node's own `import.meta.main` _checked: running either file directly runs it; importing
      build.ts leaves src/generated untouched and importing getin.ts prints nothing_
- [ ] ~~`app-config` moves to apps/os~~ _dropped: see below_
- [ ] ~~`compatibility-date` moves to apps/os~~ _dropped: see below_
- [ ] ~~apps/os gets its own `temporary-directory`~~ _dropped: only worth it if packages/shared stays
      outside core_
- [x] housekeeping: #3456's task file moves to tasks/complete/

## What changed from the plan

The repo already draws this line (packages/iterate/README.md, "The SDK/platform line"): a module
goes in `iterate` when user code runs or speaks it, in apps/os when only the platform's Worker runs
it, and in packages/shared when more than one app needs it and user code never does. Nothing
outside apps/os may import apps/os (`import-js/no-restricted-paths` in .oxlintrc.json, pinned by
lint/oxlintrc-platform-line.test.ts). Moving `app-config` and `compatibility-date` into apps/os broke
that for packages/shared/src/start-app-config.ts and apps/spa/scripts/deploy.ts, and both modules
are exactly "more than one app needs it, user code never does".

So packages/shared is by design what the platform and the apps share, and the core/ question is
which of its modules come into core beside apps/os, not how apps/os stops using them.

## Implementation notes

- First attempt moved app-config, compatibility-date and a temporary-directory copy into apps/os;
  lint refused the two cross-imports and the change was reset before committing.
