# Dynamic worker builds

Dynamic Workers build inside the OS Worker with
`@cloudflare/worker-bundler`. There is no build service, container, shell,
package manager, Wrangler subprocess, or project build command in this path.

## Ordinary Workers

`createWorker` receives the selected repo snapshot, the entry point, optional
minification, and the platform's `iterate/*` virtual modules. It follows local
imports and installs production dependencies declared in the root
`package.json` into an in-memory filesystem before producing Worker Loader
modules.

This is a bundler, not a general build environment. It does not run lifecycle
scripts, install dev dependencies, execute Vite or another framework CLI, or
honour a package-manager lockfile. Registry ranges are resolved when a cache
miss builds, so artifacts remain scoped to the owning project.

## Basic browser apps

Setting `clientEntryPoint: "client.tsx"` selects the intentionally narrow app
path. After `rootDir` is applied, the complete app must be exactly:

```text
server.tsx
client.tsx
```

OS calls `createApp` directly. Its server `bundle` option is disabled: the one
server file is only transformed from TypeScript to JavaScript. The local client
TSX is bundled into `/client.js` (the seeded refs request minification), which
OS stores and serves as a host-side text asset. The client still needs this one
esbuild pass because browsers cannot execute TSX. Imports under
`https://esm.sh/` remain browser ESM imports, so that pass only transforms and
minifies the one local file; React and ReactDOM are fetched by the browser and
are never copied into the client asset or the dynamic Worker.

The seeded Todo and Guestbook apps use this shape. They have no app-local
`package.json`, framework config, generated router, Tailwind transform, shim,
or dependency installation.

## Deliberate limits

The basic app path does not support:

- more source files or multiple browser entries;
- npm dependencies, local helper modules, or custom virtual modules;
- binary or general static assets (only the emitted text client bundle);
- Vite, TanStack Start, Tailwind compilation, framework adapters, plugins, or
  arbitrary project build commands;
- source maps, server-side bundling, or configurable asset routing.

Use an ordinary dynamic Worker for a multi-file server graph. A richer browser
application needs a separately designed build product rather than compatibility
shims in this path.

## Measured cost

Measured on 2026-07-20 with `@cloudflare/worker-bundler` 0.2.1 and the final
seed sources in a disposable local Wrangler/workerd process. Cold results are
four first calls in four fresh isolates; warm results are five subsequent calls
in one isolate. These measure the dynamic import plus `createApp`, not repo I/O
or artifact-cache lookup.

| App       | Cold mean (range) | Warm median (range) | Server output | Client output |
| --------- | ----------------- | ------------------- | ------------- | ------------- |
| Todo      | 175 ms (173–178)  | 13 ms (12–21)       | 3,672 bytes   | 2,005 bytes   |
| Guestbook | 175 ms (171–178)  | 13 ms (11–21)       | 3,193 bytes   | 1,770 bytes   |

Each build emitted one `server.js`, one `/client.js`, no warnings, and a client
whose first statements import React and ReactDOM directly from `https://esm.sh/`.

A production-shaped OS build and Wrangler dry run reported a 31,517.55 KiB
raw / 8,434.11 KiB gzip Worker upload. The worker-bundler esbuild module is a
13,596 KiB raw / 3,761,209 byte gzip asset within that upload. Ordinary
`createWorker` bundles use the same module, so the package's public entry point
cannot shed that cost while OS retains ordinary Worker bundling. This leaves
limited compressed-upload headroom; check the dry-run size on every bundler
upgrade as well as re-running the dynamic-build timing benchmark.

## Runtime and cache

Both `createWorker` and `createApp` require workerd; they do not run under
Node.js. Successful loader modules and browser assets are stored separately in
the content-addressed KV artifact cache. Warnings are treated as build failures,
and incomplete cached artifacts are misses. Browser assets never enter the
Worker Loader isolate.

`@cloudflare/worker-bundler` is currently experimental upstream and explicitly
not recommended for production use. Its API, registry installer, module
resolution, WebAssembly startup cost, and Worker CPU/memory limits are the hard
boundary of this implementation; upgrades must change the build-key version and
re-run the real-workerd benchmarks. The behavior described here is pinned to
the upstream [`createApp` implementation at 0.2.1](https://github.com/cloudflare/agents/blob/3e8963a7/packages/worker-bundler/src/app.ts)
and its [package README](https://github.com/cloudflare/agents/tree/3e8963a7/packages/worker-bundler).
