# Dynamic worker builds

Dynamic Workers are compiled by a small workerd sidecar whose public RPC
accepts source values and returns Worker Loader values. The OS Worker never
imports the 13 MiB esbuild Wasm module. There is no container, shell,
filesystem checkout, Wrangler subprocess, or project build command in this
path.

## Thin worker-bundler adapter

A dynamic-worker source contains exactly one property named after the upstream function:
`createWorker` or `createApp`. Its value has the same shape as that function's
options. The one substitution is `files`: it may point at an inline map or a
project repo snapshot because a custom worker-bundler `FileSystem` object
cannot cross the service-binding boundary.

On a cache miss OS resolves that descriptor to `Record<string, string>` and
puts the map back into the same options object. Paths are not rewritten. OS
then makes exactly the call the source names:

- `createWorker({ ...source.createWorker, files: resolvedFiles })`; or
- `createApp({ ...source.createApp, files: resolvedFiles })`.

There are no OS rules for the number or names of files. Entry points may be
explicit or left for worker-bundler to detect from wrangler config,
`package.json`, or its defaults. A `package.json` is passed through untouched;
worker-bundler attempts to install the root manifest's `dependencies` from the
selected npm registry before resolving the graph.

Ordinary Worker builds additionally receive these platform-owned virtual
modules by exact specifier:

- `@iterate-com/capnweb`
- `iterate/live-state`
- `iterate/processors`
- `iterate/processors/cloudflare`
- `iterate/sdk`

The public data options mirror worker-bundler's serializable knobs: `bundle`,
`externals`, `target`, `minify`, `sourcemap`, `registry`, `jsx`,
`jsxImportSource`, `define`, `loader`, and `conditions`, plus the relevant
worker or app entry points, `createWorker.virtualModules`, and
`createApp.assets`/`assetConfig`. The library's esbuild-plugin escape hatch,
custom `FileSystem` objects, and binary `ArrayBuffer` assets are not exposed
because they cannot cross the public data boundary unchanged.

## Seeded app example

Todo and Guestbook deliberately use only `server.tsx` and `client.tsx`, but
that is their example layout, not the build contract. Their refs spell out the
ordinary `createApp` options:

```ts
source: {
  createApp: {
    bundle: false,
    client: "apps/todo/client.tsx",
    files: { type: "repo", repoPath: "/repos/config" },
    server: "apps/todo/server.tsx",
  },
}
```

With `bundle: false`, worker-bundler transforms the dependency-free server as
separate modules while still compiling each client entry into a browser
bundle. The direct `esm.sh` React imports remain external browser imports.
`createApp` may return any number of client bundles and explicit text assets.
OS caches the returned content, manifest, config, and Wrangler compatibility
settings, then delegates requests to worker-bundler's own
`handleAssetRequest` before falling through to the server Worker. HTML routing,
redirects, headers, conditional requests, cache policy, and SPA fallbacks
therefore remain worker-bundler behavior rather than an OS imitation. The
platform still injects the Iterate status overlay into eligible HTML
responses.

## Cache and failure model

The build key includes normalized source identity, all build options,
compatibility settings, bundler version, artifact schema version, and (for
ordinary Workers) the complete generated platform-module contents. Identical
requests share cached artifacts across projects. With an unlocked dependency
range, the first successful registry resolution becomes that key's cached
artifact until expiry.

KV stores one complete modules/assets JSON record per successful key with a
30-day TTL. Build failures are not cached because worker-bundler does not
distinguish deterministic source failures from transient registry or runtime
failures; a later request tries again. Concurrent cache misses may build the
same immutable key; their content-addressed writes are identical, and the next
request is a hit. There is no request-crossing promise or distributed lock.

Browser fetches may stop waiting at a small budget while the same promise
continues under `waitUntil`; callers see the self-refreshing building page.
There is deliberately no last-good artifact, stale serving, distributed lock,
or refresh policy.

## Actual boundaries

`@cloudflare/worker-bundler` 0.2.1 is experimental and runs only in workerd.
Its registry client, package-format support, resolver, esbuild Wasm startup,
CPU/memory limits, and output behavior are the build system's limits. There is
no Vite, Tailwind CLI, TanStack Start adapter, lifecycle-script runner, native
module toolchain, or compatibility shim around it.

The current upstream installer has deliberately narrow npm semantics:

- it reads only the root `package.json` and installs `dependencies` plus their
  recursive `dependencies`; it does not install root `devDependencies`, peer
  dependencies, workspaces, or lockfiles;
- exact versions, semver ranges, `latest`/`*`, and dist-tags resolve through
  registry metadata; git, URL, file, and workspace specifications do not;
- it runs no lifecycle scripts and exposes a registry URL, not registry auth;
- package tarballs are reduced to a fixed set of text extensions. Native
  binaries, Wasm payloads, images, fonts, and other binary package files are
  omitted.

The OS artifact is one JSON KV value, so Cloudflare KV's 25 MiB value limit is
a hard upper bound before JSON overhead. Builds and Loader isolates also live
under Workers' 128 MiB isolate memory limit, including esbuild Wasm and
in-memory source/artifact maps. See the official [KV
limits](https://developers.cloudflare.com/kv/platform/limits/) and [Workers
limits](https://developers.cloudflare.com/workers/platform/limits/).

Today each asset lookup sends the cached text asset map through the bundler
service so it can use the upstream handler. That is faithful and simple for
small apps, but not a large-asset architecture. Cloudflare's own [Dynamic
Worker static-assets
guidance](https://developers.cloudflare.com/dynamic-workers/usage/static-assets/)
points toward host-owned KV or R2 asset storage; moving assets there is a
follow-up once the package exposes a host-friendly handler boundary.

Warnings are preserved as successful build metadata and logged; OS does not
reinterpret them as errors. The JSON artifact cache currently accepts text
assets and JSON-safe Worker Loader modules. An ArrayBuffer asset/module is an
explicit build failure until the cache grows a binary encoding.
