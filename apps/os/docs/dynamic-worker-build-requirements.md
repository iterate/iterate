# Dynamic Worker Build Requirements

Status: implemented (see apps/os/src/domains/workers/).

## Current shape

Dynamic workers are built **in-workerd** with
[`@cloudflare/worker-bundler`](https://www.npmjs.com/package/@cloudflare/worker-bundler)
(`createWorker` / `createApp`). There is no container builder pool, no host
`/__dev/worker-build` endpoint, and no Vite/TanStack Start recipe.

| Piece               | Role                                                    |
| ------------------- | ------------------------------------------------------- |
| `build-backend.ts`  | Calls `createWorker` or `createApp` with prepared files |
| `build-recipe.ts`   | Pure option canonicalization, path rules, toolchain pin |
| `worker-loader.ts`  | Resolve source → build key → KV cache → LOADER          |
| `artifact-store.ts` | Content-addressed KV modules (schema v3)                |

First-party apps in `config-repo-template` are deliberately small React
workers: server entry + optional client entry, JSX via esbuild, no Vite
plugins, no framework virtual-module adapters.

## File source

Unchanged: `inline` file maps or `repo` snapshots with include/exclude masks.

## Build options

```ts
type WorkerBuildOptions = {
  entryPoint?: string; // default "worker.ts"; server entry for apps
  client?: string; // when set → createApp (server + client + assets)
  bundle?: boolean;
  minify?: boolean;
  rootDir?: string;
  virtualModules?: Record<string, string>;
};
```

Platform virtual modules (`iterate/sdk`, `iterate/processors`,
`iterate/live-state`, `iterate/processors/cloudflare`) are injected by
`canonicalWorkerBuildOptions` and hashed into the build key.

## Explicitly out of scope

- Running project `npm run build` / Vite / TanStack Start compilers
- Tailwind or CSS import pipelines (apps use plain CSS in HTML)
- Full npm lockfile / lifecycle-script package-manager semantics
- Deploy-time host seeding of template artifacts (worker-bundler only runs
  in workerd). Runtime writes content-addressed keys, so the first successful
  build of identical template content is shared fleet-wide.

## History

Earlier revisions used an esbuild-wasm sidecar, then a sandbox builder pool
(`npm install` + `wrangler deploy --dry-run`, plus a Vite lane). Those paths
were deleted in favour of the package's vanilla API and simpler first-party
apps.
