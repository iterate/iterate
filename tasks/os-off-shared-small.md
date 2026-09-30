---
status: in-progress
size: small
---

# apps/os stops importing four small pieces of packages/shared

Pre-work item 3 for moving apps/os into `core/`, first slice. Core builds from a clone of itself: outside code
may import core, core never imports outside code. `packages/shared` is outside, and apps/os imports
14 of its subpaths. This takes the four small ones.

Status: spec written, implementation not started.

## Checklist

- [ ] `dev/is-main-module`: apps/os/scripts/getin.ts drops its guard (trpc-cli, given
      `...import.meta`, already runs only when the file is the entry point); apps/os/scripts/build.ts
      uses Node's own `import.meta.main`
- [ ] `app-config` (the `APP_CONFIG` mechanism: `parseAppConfigVars`, `fieldNameOf`, `httpOrigin`,
      `optionalOrigin`, `dnsName`) moves to apps/os/src/app-config-vars.ts with its test.
      packages/shared/src/start-app-config.ts (the apps on top's schema) imports it from there
- [ ] `compatibility-date` moves to apps/os/src/compatibility-date.ts. scripts/lib (wrangler-config,
      start-app, do-reset test) and apps/spa's deploy import it from there
- [ ] `test-support/temporary-directory`: apps/os gets its own 10-line copy at
      apps/os/src/test-support/temporary-directory.ts; the shared one stays for its other ~25 users
- [ ] packages/shared's `./app-config` and `./compatibility-date` exports and files go
- [ ] apps/os/scripts/build.test.ts's outside-imports snapshot is unchanged (packages/ is allowed
      there); a grep shows apps/os no longer imports the four subpaths
- [ ] housekeeping: #3456's task file moves to tasks/complete/

## Assumptions (made without asking)

- The APP_CONFIG mechanism belongs to core, and the apps on top reuse it from apps/os (outside
  importing core is allowed), rather than a copy each side or a new `iterate` subpath.
- One compatibility date for every Worker stays (#3442): core owns the constant, everyone else
  imports it.
- Other users of `is-main-module` (other apps, scripts/) are left alone: core does not depend on them.

## Out of scope

- The other shared subpaths (platform-retry, integration-scopes, config-repo-template/reference,
  posthog, pkg-pr-new, the test policy helpers): later PRs.

## Implementation notes
