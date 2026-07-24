---
status: in-progress
size: medium
branch: tasks-app-package-bridge
---

# Package the Tasks app's project-config bridge

## Status

The connector, tiny package artifact, pkg.pr.new publishing, and docs are
implemented. Repo-wide lint, typecheck, and tests pass. The PR was reshaped
mid-flight: an earlier revision wired `@iterate-com/tasks` into the OS seeded
template and taught the kernel (config, env, seeding, dynamic builds, deploy)
to preview-pin it; that was all reverted — `apps/os` is now untouched. Only
the companion `iterate/config` PR and its install proof remain.

## Goal

Let project config workers import one tiny connector for the independently
deployed Tasks app instead of copying its auth and reverse-proxy code:

```ts
import { TasksApp } from "@iterate-com/tasks";

const tasksApp = TasksApp.create(env, {
  auth: { policy: "project-member" },
  proxy: {
    origin: "https://tasks.iterate.workers.dev",
    originOverrideKvKey: "tasks-app-origin",
  },
});
```

The returned object exposes only:

```ts
{ fetch(request: Request): Promise<Response> }
```

Tasks remains a separately deployed stateless vessel. The package contains
only the config-side connector; it must not ship the Tasks client, server,
Durable Object, or their dependency graph.

## Locked decisions

- **The OS kernel stays tasks-free.** `@iterate-com/tasks` is a package for
  external config repos (`iterate/config` first); OS never depends on it, the
  seeded template doesn't reference it, and no kernel code (config schema,
  env, repo seeding, dynamic worker builds, deploy) knows its name. The only
  in-repo consumers are `apps/tasks` itself and the pkg.pr.new workflow that
  publishes it.
- Consequence: no preview pinning for the tasks package. Config repos install
  it from `https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@main` (or a
  pinned `@<sha>`); preview environments don't co-test bridge changes. That's
  acceptable for a thin proxy connector — if it ever isn't, generic (name-
  agnostic) pkg.pr.new ref pinning is the follow-up, not per-package kernel
  knobs.
- The public name is `TasksApp`; “bridge” is only an internal term.
- Export `TasksApp` from the root of `@iterate-com/tasks`. The package has no
  other public export.
- `TasksApp.fetch` owns both auth and proxying so one ITX session serves the
  member gate and KV lookup.
- Every deployment/policy choice is a required `create` input.
- The only accepted auth value is `{ policy: "project-member" }`.
- `proxy.origin` is a full HTTPS origin. `proxy.originOverrideKvKey` names a KV
  entry whose value, when present, is also a full HTTPS origin.
- Replacing the request origin preserves method, path, query, headers, body,
  redirects, and WebSocket upgrades. Manual redirect handling is an internal
  proxy invariant, not an option.
- There is no `processEvent`: Tasks owns no config-worker stream state.
- Do not add generic remote-app abstractions or speculative auth, protocol,
  header, or fetch options.

## Checklist

- [x] Add a public-interface spec for
      `TasksApp.create(env, { auth, proxy }).fetch(request)`, starting with
      member denial and successful proxying. _`config-bridge.test.ts` covers
      both branches, full-origin overrides, and malformed origins._
- [x] Implement the connector with required options and runtime validation of
      configured/default and KV override origins. _`config-bridge.ts` exposes
      only `TasksApp.create(...).fetch`._
- [x] Preserve the trusted project ID header and project auth cookie across
      normal HTTP and WebSocket proxy requests. _The transparent-proxy spec
      checks body, routing headers, cookie, and upgrade._
- [x] Give `apps/tasks` a separate connector-only package build and root
      export while preserving its existing Vite/Cloudflare app build. _A
      separate `tsconfig.package.json` emits the package; the full Vite build
      remains green._
- [x] Make all Tasks app packages development-only for publication. _The
      connector uses a self-contained structural ITX type, so the tarball has
      no runtime or peer dependencies._
- [x] Add a packed-tarball test proving no app source, client/server bundles,
      Durable Objects, or app dependency graph ships. _The exact four-artifact
      allowlist plus README/license is checked after `pnpm pack`._
- [x] Publish `packages/iterate` and `apps/tasks` in one locked
      `pkg-pr-new` invocation. _The workflow uses locked `pkg-pr-new@0.0.79`;
      both long-form URLs (`.../iterate/iterate/iterate@<ref>` and
      `.../iterate/iterate/@iterate-com/tasks@<ref>`) verified resolving._
- ~~Add `@iterate-com/tasks` to the OS project-config template and replace
  the hand-written Tasks branch with `TasksApp`.~~ _Reverted by decision: the
  template (and everything under `apps/os`) stays tasks-free. The template
  keeps its inline proxy; `iterate/config` is the package's consumer. A
  follow-up could switch the template to the package after this merges (once
  `@main` exists), if wanted._
- ~~Pin both `iterate` and `@iterate-com/tasks` to the same exact PR SHA in
  preview-created and preview-rebuilt config repos.~~ _Reverted by decision:
  no kernel knowledge of the tasks package. Preview pinning remains
  iterate-only, exactly as on main._
- [x] Update Tasks and remote-app docs, including full-origin KV examples.
      _The README, vessel landing page, and remote-app guide use `TasksApp`
      and complete HTTPS KV values._
- [ ] Open the companion `iterate/config` PR using the published package and
      the same declarative `TasksApp` call.
- [ ] Prove a fresh minimal config install/typecheck, the normal Tasks app
      build, package contents, member denial, HTTP proxying, KV override
      proxying, and WebSocket forwarding.
- [x] Run scoped tests/typechecks/lint/format, then the repo-required validation
      appropriate to the touched packages.

## Implementation notes

- `tasks-app-origin` values are full HTTPS origins in all examples now; the
  package throws on non-HTTPS or non-origin values, and a falsy/absent KV
  value falls back to the configured origin.
- The structural ITX input type keeps `@iterate-com/tasks` completely
  dependency-free while accepting the platform's real `env.ITX` binding.
- Publishing two packages in one pkg.pr.new invocation keeps the existing
  long-form iterate URL (`https://pkg.pr.new/iterate/iterate/iterate@<ref>`)
  working — verified against this PR's own head SHA — so the kernel's
  `TEMPLATE_ITERATE_PACKAGE_SPEC` needed no change.
- The companion config PR must follow the Iterate PR because its dependency
  needs the scoped package URL emitted by `pkg.pr.new` (from `@main` after
  merge, or a `@<sha>`/`@<pr>` channel before).
