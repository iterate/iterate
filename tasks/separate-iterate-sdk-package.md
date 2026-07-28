---
state: todo
priority: medium
size: medium
dependsOn: []
tags: [iterate-package, sdk, cli, userspace-workers]
---

# Publish the Iterate SDK separately from the CLI and terminal UI

## Context

`packages/iterate` is currently both the published SDK and the installed
`iterate` CLI. That makes every package consumer inherit one package-wide
runtime dependency graph even when it imports a narrow SDK subpath such as
`iterate/sdk/capnweb/react`.

This is particularly expensive for userspace apps. The dynamic worker builder
installs a package and all of its declared runtime dependencies before esbuild
can tree-shake unused exports. A guestbook client that only needs LiveState
therefore also downloads Clack, trpc-cli, ORPC, and other unrelated CLI
dependency trees. OpenTUI is now optional and is not traversed by the current
worker-bundler installer, but it still belongs on the CLI side of the eventual
package boundary. Subpath exports cannot fix the underlying problem because npm
dependencies are declared for the whole package, not per export.

PR #2167 applied a tactical cleanup by correctly classifying optional TUI and
type-only dependencies. Until this task lands, the existing worker-bundler
patch also contains a deliberately gross workaround: when the package being
installed is named `iterate`, the installer follows only a hard-coded SDK
dependency allowlist (`@iterate-com/capnweb`, `@tanstack/react-query`, `react`,
and `zod`). This avoids downloading the known CLI graph during dynamic app
builds without pretending to provide import-aware package installation.

The allowlist does not change the published manifest or solve the package
boundary. A new SDK runtime dependency must be added to the allowlist or the
userspace build will fail, deliberately and visibly. Remove the allowlist and
the worker-bundler patch as part of this task once seeded apps install the real
SDK artifact.

## Goal

Publish a lean Iterate SDK artifact whose dependency graph contains only the
runtime and peer dependencies needed by the public SDK entries. Keep the CLI
and terminal UI in a separately installable artifact without changing the
simple userspace import experience.

Seeded apps should still be able to write imports such as:

```ts
import { CapnWebProvider, useLiveState } from "iterate/sdk/capnweb/react";
import { StreamProcessor } from "iterate/processors";
```

The dependency key may remain `iterate` while resolving to a differently named
SDK tarball/package. `APP_CONFIG_ITERATE_REPO_PKG_REF` should continue to
pin the exact pkg.pr.new artifacts for a preview PR head.

## Proposed package boundary

- SDK artifact: browser LiveState, generic Cap'n Web React bindings, the itx
  client bindings, stream processors, worker helpers, and their declarations.
- CLI artifact: command registration, authentication/setup prompts, terminal
  chat, OpenTUI, ORPC/trpc-cli, Node WebSocket transport where CLI-specific,
  and the `iterate` executable.
- The SDK must not acquire a runtime dependency on the CLI package.
- Prefer one source of truth for SDK implementation and declarations. Do not
  copy generated or hand-written modules between packages.
- Keep React and React Query as normal peer dependencies for React-facing
  entrypoints. Keep Node-only and terminal-only dependencies out of the SDK.
- Decide package names and release compatibility explicitly. Preserving
  `npm install -g iterate` may mean the existing package name remains the CLI,
  while userspace manifests install the SDK package under the local dependency
  name `iterate`.

## Publishing and preview requirements

- pkg.pr.new publishes the SDK as its own artifact for every PR head.
- Preview deployment derives exact immutable pkg.pr.new URLs from
  `PREVIEW_PULL_REQUEST_HEAD_SHA` and exposes the ref through
  `APP_CONFIG_ITERATE_REPO_PKG_REF`.
- Dynamic build cache identity includes the selected pkg.pr.new knobs.
- Production and non-preview environments have an explicit stable SDK package
  policy; they must not silently fall back to an unrelated moving version.
- The package must install through conventional npm-compatible semantics. Do
  not teach worker-bundler to lazily approximate a package manager or maintain
  an application-specific transitive-dependency allowlist. The temporary
  `iterate` allowlist described above is explicitly technical debt to delete,
  not part of the target design.

## Acceptance criteria

- [ ] A freshly packed SDK has no dependencies on OpenTUI, Clack, ORPC,
      trpc-cli, Octokit, or CLI-only Node packages.
- [ ] Remove the hard-coded `iterate` dependency allowlist from the
      worker-bundler patch; installing the SDK follows its complete published
      dependency graph normally.
- [ ] The guestbook and todo templates consume the published SDK through their
      existing `iterate/...` imports with no virtual-module copies or CDN
      imports.
- [ ] `iterate/sdk/capnweb/react` supplies the same generic provider/hook used
      by `apps/os`, including the reconnectable `makeConnection` path and the
      explicit `{ root }` override.
- [ ] Processor and Cloudflare worker exports remain available from the SDK
      without pulling the CLI graph into userspace builds.
- [ ] A workerd end-to-end test builds a seeded app using the exact pkg.pr.new
      SDK artifact for the current PR head and exercises a LiveState update.
- [ ] Package-level tests prove the published export map and declaration files
      come from the intended SDK artifact rather than workspace source.
- [ ] The separately installed CLI still runs setup/auth commands and launches
      terminal chat on every supported platform.
- [ ] Frontend and package documentation explain which artifact applications
      and CLI users install, while preserving the concise import examples.

## Non-goals

- Dependency-aware or import-aware installation inside worker-bundler.
- Reintroducing generated virtual modules for Iterate or Cap'n Web.
- Duplicating LiveState, connection, processor, or generated itx code between
  the SDK and CLI packages.
