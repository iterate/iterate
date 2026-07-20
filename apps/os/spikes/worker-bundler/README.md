# Minimal container-free builds with `@cloudflare/worker-bundler`

Spike performed with `@cloudflare/worker-bundler@0.2.1`.

## Verdict

Use this package only for a deliberately small Worker application dialect. The
spike builds a Todo app and a Guestbook app entirely inside workerd with the
package's vanilla API:

```ts
const output = await createApp({ files });
```

There are no esbuild plugins, virtual modules, Node built-in shims, npm aliases,
framework manifests, Tailwind scanner, client entry, static asset pipeline, or
custom bundler options. Each fixture is one `src/index.ts` module using only Web
Platform APIs. The harness then loads the output through Worker Loader and runs
the apps' read and mutation flows against the built Worker.

The repository's production Todo and Guestbook pages are now plain React
`createApp` apps (server + client entries) without TanStack Start or Vite — the
same philosophy as this spike, extended only as far as JSX/React requires.

## Run it

From `apps/os`:

```sh
pnpm spike:worker-bundler

pnpm exec wrangler deploy --dry-run \
  --config spikes/worker-bundler/wrangler.jsonc
```

The command fails if either app cannot be bundled, Worker Loader cannot load
the emitted module, a build warning appears, or an expected HTTP response or
state transition changes.

## Supported boundary

This proof covers:

- a conventional `src/index.ts` module Worker;
- TypeScript compiled by worker-bundler's embedded esbuild;
- server-rendered HTML and standard form requests;
- module-local application state for the lifetime of the loaded isolate; and
- loading and executing the output through the platform's Worker Loader.

It does not claim support for:

- package scripts, Vite, Vite plugins, or framework compiler transforms;
- TanStack Start route generation, virtual modules, manifests, or server
  functions;
- Tailwind, PostCSS, imported CSS output, or browser asset graphs;
- lockfiles, arbitrary npm dependency semantics, or install lifecycle scripts; or
- durable state, bindings, migrations, or deployment configuration for the
  generated app.

## Performance

Machine: Apple M4 Max, 128 GiB RAM, macOS/Darwin arm64. Values are medians from
fresh workerd processes (cold numbers include esbuild/WASM initialization).

| Measurement                        |     Todo | Guestbook |
| ---------------------------------- | -------: | --------: |
| First `createApp` build            |  ~140 ms |   ~138 ms |
| Repeat `createApp` build           |    ~9 ms |     ~8 ms |
| Load and run all functional probes |    ~2 ms |     ~2 ms |
| Emitted Worker module              | ~2.1 KiB |  ~1.9 KiB |

There is no dependency-install phase for these apps.
