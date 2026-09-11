# V4 on celld: local bring-up

Status on 2026-09-07: the actual V4 Worker and separate compiler service boot on
celld 0.4.1. Basic SQLite facets work. This is a partial port, not deployment or
security acceptance. Global outbound fetch is deliberately unchanged.

## Run

Install the appropriate binary from the [celld 0.4.1 release](https://github.com/denoland/celld/releases/tag/v0.4.1),
then run from `packages/v4/project-worker`:

```bash
# Omit CELLD_BIN if celld is already on PATH.
CELLD_BIN=/absolute/path/to/celld pnpm dev:celld

# Broad local compatibility survey; currently exits nonzero.
CELLD_BIN=/absolute/path/to/celld pnpm e2e:celld --testTimeout 10000

# Repeatable basics: 19 passing assertions across five complete test files.
CELLD_BIN=/absolute/path/to/celld pnpm e2e:celld \
  e2e/facets-sqlite-basics.e2e.test.ts \
  e2e/context-built-ins-and-error-codes.e2e.test.ts \
  e2e/stream-core-reduce.e2e.test.ts \
  e2e/stream-chunked-bodies.e2e.test.ts \
  e2e/rpc-admission.e2e.test.ts
```

Each invocation creates a fresh ignored `.celld/run-*` directory, builds source
once, allocates loopback ports and retains state and logs afterwards. There is no
file watching or state reuse between invocations. Stop development with Ctrl-C.
No Doppler, deployed resources or real provider credentials are needed. The
config templates contain synthetic local-only secrets: never deploy them or
expose this experimental server publicly.

The runner accepts another binary through `CELLD_BIN`, so an unstable build can
use exactly the same lane. The upstream remote exposed only `main` when checked;
these results are from the released binary, not an unverified unstable branch.
Experimental loader/facet support is enabled with `CELLD_WORKER_LOADER=LOADER`.

## Entry points and packaging

There is no alternative V4 application API or celld-specific implementation of
the context. The runner uses `src/worker.ts` and its existing Durable Object,
plus `src/bundler.ts` in a separate service isolate. Tests connect to the ordinary
public `/api` door through `WORKER_BASE_URL`.

`wrangler.celld*.jsonc` are runner templates, not standalone deployment configs.
The runner:

1. Builds the existing SDK, type declarations and browser assets.
2. Prebundles both Worker entry points with browser/workerd resolution. Compiler
   WASM is packaged as a static module, and esbuild-wasm's `self` reference gets a
   build-time alias to the host global. TypeScript takes its browser build path.
3. Copies assets into celld's project directory and hashes the prepared outputs,
   assets and configs into an explicit `DEPLOYMENT_ID`. This feeds loader and
   compiler cache identity; native Cloudflare version IDs remain the default
   when the explicit ID is absent. This is a prepared-content identity, not a
   claim about the bytes celld subsequently rebundles.
4. Publishes the compiler first, stops that bootstrap node, then starts the main
   node against the same local store. The compiler binding addresses the named
   `Bundler` entrypoint; its original default export remains available.
5. Checks `/version`, runs tests without retries, and stops owned processes.
   Startup and shutdown are bounded. Forced termination after 45 seconds is
   reported and makes the runner fail.

`run.json` records the prepared deployment identity, binary, version-command
output and test arguments. `main.log` and `bundler.log` retain runtime output;
`tests.json` is Vitest's full machine-readable report. Existing directories are
not deleted or overwritten.

## Evidence

Host: Apple arm64, Node 26.5.0, celld 0.4.1, Vitest 4.1.10.

| Check                                                         | Result                                                |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| Broad celld survey, 53 files, 10-second default test deadline | 81 passed, 129 failed, 2 expected failures, 2 skipped |
| Celld basics command above                                    | 19 passed                                             |
| Celld compiler file                                           | 3 passed, 1 failed: repository capability traversal   |
| Workerd: compiler, provenance and new facet basics            | 15 passed                                             |
| All four TypeScript configurations                            | Passed                                                |
| Node unit suite                                               | 392 passed, 1 failed, 1 expected failure              |
| Deployment identity unit tests                                | 12 passed                                             |

The broad report is `.celld/run-j7cSYS/tests.json`; the final 19-test basics report is
`.celld/run-0EV2Ra/tests.json`. These are retained local evidence, not committed
fixtures. Vitest JSON counts the two expected failures among its 83 passes;
they are **not** evidence of working behavior. File-specific explicit deadlines
can exceed the survey's 10-second default.

The unit failure reproduces independently in
`src/context/expression-memory.test.ts`: its Node subprocess exhausts the
128 MiB heap parsing a 4.5 MiB source. The parser and its budget were not changed.
Neither this failure nor the known expected failures were suppressed.

The new facets tests prove named facet creation, independent SQLite state,
lookup without resupplying source and transaction rollback, through public ITX.
They do not prove eviction recovery, processor replay or capability transport.
The fixture exports a default handler as well as its named Durable Object;
existing named-class-only module tests remain unchanged and fail on celld.

Compiler successes cover direct TypeScript compilation, real cache miss/hit
behavior, changed-option cache identity, structured syntax diagnostics, and
checking against the actual contextual ITX declarations.

A separate `dev:celld` smoke served `/version`, `/demo` and `/docs` with HTTP 200
(`.celld/run-gAT8l1`). Both demo routes served their generated HTML assets;
browser interactions were not tested. Its Ctrl-C check exposed an orphaned
celld server child. The runner now isolates child process groups from terminal
signals, forwards the interrupt once and allows celld's own 35-second server
shutdown deadline to complete before its 45-second outer limit. A second dev
run (`.celld/run-bhqf5Q`) stopped on Ctrl-C (exit 130) with no remaining celld
processes; the final basics run also left no server process behind.

The local survey deliberately excludes self-booting Wrangler tests, tests
requiring external providers/public ingress and dedicated pressure/recovery
workloads. The exact exclusions and reasons are in
`e2e/vitest.celld.config.ts`. Loader, processor and fetch-related failures stay
visible; this lane is not a green-only filter or the complete V4 acceptance suite.

## Remaining runtime gaps

Source references below are pinned to the celld release commit
`10cb1303dac710dcb3b557e318e08c855261f68b`.

- **Capabilities crossing isolates.** Repository handles, callbacks, live lends
  and returned native RPC stubs fail on these paths. Celld explicitly rejects
  [foreign-isolate stubs and streams](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3488).
  This is more than adding facet storage.
- **Loaded-worker bindings and native input.** Tests using contextual
  `env.ITX.get()` fail, as do native `{ js: ... }` module records and richer RPC
  chaining. The [loader implementation](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2730)
  does not yet implement the complete contract V4 uses. ITX confinement has not
  been weakened to bypass this.
- **Processor module loading.** The SDK is minified and can contain
  `import{...}from"cloudflare:workers"`. Celld's
  [import scanner requires whitespace after `import`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/modules.rs#L76);
  logs show unresolved `cloudflare:workers` and `instantiate:<none>`. Named-class-only
  modules also encounter a default-export requirement. Basic facets passing does
  not imply processor facets pass.
- **Provenance crypto.** Unpadded base64url decoding and raw Ed25519 public-key
  import fail. An experimental padded/JWK path reached another missing feature:
  [Ed25519 verification](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/crypto.js#L563).
  That application experiment was reverted; provenance verification is unchanged.
- **Lifecycle and telemetry.** Even the passing basics run logs dropped frames
  for closed WebSockets. The broad run required forced process termination.
  These are unresolved runtime-quality issues, not acceptable noise. The macOS
  allocator warning and the OAuth library's disabled-CIMD warning are also retained
  in logs. No production-shaped trace, metric or deployment acceptance is claimed.

These are demonstrated gaps, not a claim that every one of the 129 failures has
an independently established root cause. The next useful step is to rerun this
same lane on the proposed unstable binary, then fix remaining failures against
that exact runtime rather than translating away V4's capability semantics.
