---
state: draft
priority: medium
size: medium
tags: [os, dynamic-workers, packages, pkg-pr-new]
---

# Dynamic worker host: install the dependencies a tarball-URL dependency declares

Config repos depend on first-party packages through pkg.pr.new tarball URLs
(`iterate`, `@iterate-com/docs`, `@iterate-com/voice-agent`). The dynamic
worker host (`@cloudflare/worker-bundler`, driven from
`apps/os/src/domains/workers/build-backend.ts`) resolves transitive
dependencies of registry packages, but not the dependencies a tarball's own
package.json declares. Consequences today:

- `packages/iterate/tsdown.config.ts` bundles capnweb, sqlfu, yaml and zod
  into every starter-app "physical" worker and into the github-ai-linter
  entry, with `alwaysBundle` / `onlyBundle` lists that must be kept in step
  with the SDK's imports.
- The SDK's library entries leave zod and capnweb external, so every config
  template declares `zod` and any config-repo file that reaches
  `iterate/processors` needs it too (`@iterate-com/voice-agent`'s installer
  writes the line for that reason).
- Any second-party package has to choose between the same bundling and
  telling its users which of the SDK's dependencies to declare.

If the host read a tarball dependency's `dependencies` and installed them
(flat, like the registry path), all of that goes away: the SDK's entries stop
bundling anything, templates stop declaring zod, and a package is an ordinary
npm package. Check first whether the bundler already supports this for
tarball specs behind an option, and what its flat node_modules does with two
versions of zod; the repo already patches this bundler
(`patches/@cloudflare__worker-bundler@0.2.1.patch`), so a small upstream-able
change is on the table.

Prompted by the review of #2600 (Jonas, 2026-09-08).
