---
status: in-progress
size: large
branch: tasks-app-package-bridge
---

# Package the Tasks app's project-config bridge

## Status

The connector, connector-only package artifact, and joint pkg.pr.new workflow
are implemented and locally green. OS config-template consumption, preview
pinning, docs, and the companion `iterate/config` update remain.

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
      its first CI run will supply the generated scoped-package URL._
- [ ] Add `@iterate-com/tasks` to the OS project-config template and replace
      the hand-written Tasks branch with `TasksApp`.
- [ ] Pin both `iterate` and `@iterate-com/tasks` to the same exact PR SHA in
      preview-created and preview-rebuilt config repos.
- [ ] Update Tasks and remote-app docs, including full-origin KV examples.
- [ ] Open the companion `iterate/config` PR using the published package and
      the same declarative `TasksApp` call.
- [ ] Prove a fresh minimal config install/typecheck, the normal Tasks app
      build, package contents, member denial, HTTP proxying, KV override
      proxying, and WebSocket forwarding.
- [ ] Run scoped tests/typechecks/lint/format, then the repo-required validation
      appropriate to the touched packages.

## Implementation notes

- `tasks-app-origin` currently contains bare hostnames in examples. This is a
  clean cutover to full origins; update the scripts/docs rather than adding a
  compatibility parser.
- Preview pinning is part of the feature. Testing a preview against the
  connector from `@main` would not prove the PR.
- The companion config PR must follow the Iterate PR because its dependency
  needs the scoped package URL emitted by `pkg.pr.new`.
- The structural ITX input type keeps `@iterate-com/tasks` completely
  dependency-free while accepting the platform's real `env.ITX` binding.
