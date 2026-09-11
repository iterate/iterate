# V4 readiness for celld

2026-09-07 — source research and proposed organization, not an implemented port.
Scope: `packages/v4/project-worker`. Treat forthcoming `globalOutbound` support
as a planning assumption; this report does not investigate or work around its
absence. Upstream observations are pinned to celld v0.4.1, commit `10cb1303`.

## Recommendation

Keep **one Workers-compatible application**, with separate deployment and test
setup for Cloudflare and celld. Prepare the packaging, configuration and proof
of runtime behavior; do not rewrite the stream engine, fork the SDK, or build
a general-purpose `Runtime` interface.

This is an architectural recommendation, not a claim that the full app already
runs on celld. Celld targets the Workers programming model, and its bundler
selects `workerd,worker,browser` package conditions while leaving
`cloudflare:*` imports native. That makes the existing Workers-facing source
the right first compatibility target. See its
[compatibility documentation](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md)
and [bundler implementation](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/deploy.rs#L2153-L2245).

## Preserve the current application boundaries

| Existing module                                                                                                | Responsibility to preserve                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/worker.ts`](../packages/v4/project-worker/src/worker.ts)                                                 | Public HTTP/RPC routing and exported Worker classes: the application composition root, shared between hosts.                                                |
| [`src/iterate-context-durable-object.ts`](../packages/v4/project-worker/src/iterate-context-durable-object.ts) | Assemble a context's repositories, trust, stream, loader and lifecycle behavior. Keep native Workers operations here and in their existing focused helpers. |
| [`src/stream/`](../packages/v4/project-worker/src/stream/)                                                     | Durable events, checkpoints, projections and processor delivery. Keep synchronous SQLite transactions and the existing small storage interface.             |
| [`src/context/worker-loader.ts`](../packages/v4/project-worker/src/context/worker-loader.ts)                   | Loaded-worker identity, injected modules/bindings and runtime composition. This is the appropriate owner of any demonstrated loader-specific difference.    |
| [`src/sdk/index.ts`](../packages/v4/project-worker/src/sdk/index.ts)                                           | One authoring surface and one implementation of processor semantics, including its intentional Workers host facilities.                                     |
| [`src/bundler.ts`](../packages/v4/project-worker/src/bundler.ts)                                               | Separate compiler service and build cache, without project authority. Keep it separate from the main Worker.                                                |

No `src/host/` or `src/domain/` move is necessary to run on celld. The existing
[reading guide](../packages/v4/project-worker/docs/reading-guide.md) already
explains the program through its real modules. An author-only SDK export could
be useful for another consumer, but it is **not a celld prerequisite**: both
hosts are intended to consume the same Workers SDK.

Likewise, the Node SQLite adapter remains a test tool, not a production storage
backend. Its no-op alarm cannot establish runtime lifecycle correctness.
Preserve the existing host-independent processor tests; do not impose a new
blanket layer rule over every domain file or introduce asynchronous storage
solely for this target.

## 1. Make the test target explicit

The public E2E harness is already mostly URL-first:
[`global-setup.ts`](../packages/v4/project-worker/e2e/support/global-setup.ts)
skips its local Wrangler boot when `WORKER_BASE_URL` is supplied. The
[Playwright configuration](../packages/v4/project-worker/playwright.config.ts)
similarly accepts `DEMO_BASE_URL`. Reuse these entry points and the same public
HTTP, WebSocket and RPC assertions.

However, changing the URL does **not** retarget the whole suite:

| Exception today                                                                                                                                                                                                          | Preparation needed                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`auth.e2e.test.ts`](../packages/v4/project-worker/e2e/auth.e2e.test.ts) boots its own Wrangler harness and uses `harness.fetch` / runtime response WebSockets.                                                          | Separate auth-fixture boot/config from assertions; exercise the shared assertions through real HTTP and WebSocket clients.                                                                |
| [`log-harness.ts`](../packages/v4/project-worker/e2e/support/log-harness.ts), used by the push-delivery warning test, starts another local Wrangler pair.                                                                | Give this test an explicitly selected host fixture and log source; otherwise a nominal celld run still tests workerd.                                                                     |
| [`native-websocket-close-telemetry.deployed.e2e.test.ts`](../packages/v4/project-worker/e2e/native-websocket-close-telemetry.deployed.e2e.test.ts) selects on HTTPS but requires a fixed Cloudflare origin and tail API. | Put it in an explicitly Cloudflare-only operational job. A different HTTPS celld origin currently selects this test and fails its origin assertion, rather than providing celld evidence. |
| [`stream-lifecycle-recovery.e2e.test.ts`](../packages/v4/project-worker/e2e/stream-lifecycle-recovery.e2e.test.ts) selects on any supplied worker URL and seeds about 144 MiB.                                           | Make resource/recovery testing an explicit, isolated acceptance job, not an accidental consequence of setting an external URL.                                                            |

Use a small test-target description: runtime name/version, endpoint, build
identity, authentication and external fixture URLs. Keep provider boot, logs
and lifecycle controls in test support, not application code. Replace
localhost/HTTPS guesses with explicit suite selection and checked prerequisites;
do not let unavailable core behavior become quiet skips or a green partial run.
Deployed RPC callbacks need a reachable fixture URL, and host-routing tests need
the target's configured project hostnames.

Retain the native [`__workers-tests__`](../packages/v4/project-worker/__workers-tests__/)
lane. Its `cloudflare:test` eviction and alarm controls cannot be redirected
with a URL. Add celld-native lifecycle proofs using real host controls; share
semantic assertions where possible, without pretending different controls are
equivalent. Keep loaded-worker fixture source unchanged wherever compatibility
is the behavior under test.

## 2. Separate deployment configuration, not application source

The current [`deploy.ts`](../packages/v4/project-worker/scripts/deploy.ts) and
[`generate-deploy-config.ts`](../packages/v4/project-worker/scripts/generate-deploy-config.ts)
are deliberately Cloudflare-specific: approved account, resource IDs, routes,
observability, version metadata and atomic secret upload. Preserve that path.
Add separately selected celld config/deploy scripts when implementation starts;
there is no need to relocate the existing scripts first.

Extract only genuinely shared public deployment facts: origin, environment
name, project hostname base and project/custom-host mappings. Keep deployment
inventory typed in root `envs.ts`, with a distinct celld shape when needed;
do not force celld resources into Cloudflare account/resource types or put
secrets in that public map.

Generate a celld config from its supported schema instead of copying or
silently filtering the Cloudflare config. For example, the pinned celld parser
uses `durable_objects` bindings plus SQLite-class migrations, while V4's current
Cloudflare generator uses `exports` declarations. Account, routes, observability
and secret provisioning belong to the selected deployment tooling. Recheck
new loader configuration against the celld version chosen for the actual run.
See [accepted configuration keys](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#wrangler-configuration)
and the [SQLite DO example](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/examples/counter/wrangler.jsonc).

There is one concrete application configuration seam to prepare:

- [`app-config.ts`](../packages/v4/project-worker/src/app-config.ts) already has
  `parseAppConfig(vars, deployId)`, but `appConfigOf` currently derives the ID
  from `CF_VERSION_METADATA`, falling back to `unversioned`.
- That ID participates in loaded-worker cache keys. Celld deployments must
  supply a real build/deployment identity through a narrow configuration
  resolver; silently using `unversioned` is not an adequate production plan.
- The compiler separately uses `env.VERSION.id` in its build-cache digest.
  Supply and verify its identity too. Do not invent fake Cloudflare metadata
  bindings or scatter runtime checks through domain code.

## 3. Name the complete build products

The build includes more than the main Worker. Record these products and their
dependencies explicitly, preserving generated paths and write-if-changed
behavior. Independently callable build tasks are useful if deployment needs
them; a build-system rewrite is not a prerequisite.

| Product                      | Current source / generation                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main Worker                  | `src/worker.ts` and its imported modules, including generated loader/SDK inputs.                                                                                                                         |
| Compiler Worker              | `src/bundler.ts`, its toolchain, generated declaration inputs and imported WASM. Deploy and bind this service alongside the main Worker.                                                                 |
| Injected SDK and type assets | [`build-sdk.mjs`](../packages/v4/project-worker/build-sdk.mjs) and [`build-types.mjs`](../packages/v4/project-worker/build-types.mjs), generated from the same checked-out source.                       |
| Static demo/docs assets      | `public/demo.html` and `public/docs.html`, built by the SDK script and [`build-docs.mjs`](../packages/v4/project-worker/build-docs.mjs). The docs page also embeds example processor/dependency bundles. |

Pin source revision, dependency lockfile, runtime and bundler versions; record
hashes of the actual deployed products and the main/compiler pairing. The goal
is identical authored source and known build inputs, not an unsupported promise
of byte-identical output from Wrangler and celld's different packaging paths.

In particular, prove the compiler's WASM packaging. In the pinned celld build,
normal bundling collects imported WASM as sibling modules, but `no_bundle: true`
reads only the entrypoint and supplies no sibling WASM. Therefore “build once
and point both deployers at one JS file” is not yet a verified artifact handoff.
See [celld's bundle/no-bundle paths](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/deploy.rs#L443-L486).

## 4. Require a runtime and operations proof

Use separate named jobs: Node unit tests, public contract tests on each host,
native lifecycle conformance on each host, and provider-specific operational
acceptance. Report passed, failed and unverified coverage explicitly.

The meaningful celld proof is the existing application doing all of the following:

- Preserve append/checkpoint/projection atomicity, rollback, repository head
  checks and idempotency through actual SQLite DO storage.
- Wake from alarms and recover through eviction/restart without lost work,
  duplicate effects, retry storms or stuck subscriptions.
- Preserve RPC authority, disposal, WebSocket hibernation/reconnection and close
  behavior, plus loaded-worker isolation and secret/egress policy.
- Compile and execute real user code through the separate compiler and loader,
  including a deployment change that invalidates the appropriate caches.
- Produce coherent request/lifecycle logs and durable state. Verify native
  error properties against [`lib/errors.ts`](../packages/v4/project-worker/src/lib/errors.ts);
  an unknown error must remain a defect to explain, not be hidden by retries.

Local `celld dev` is a first smoke, not production durability evidence. Celld's
[guarantees](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/guarantees.md)
depend on the configured backing store, ownership/fencing and supervision.
A later isolated deployment must verify restart/recovery, ingress/TLS, logs,
resource bounds and upgrade/rollback behavior with that real operational setup.

## Suggested order

1. Make E2E target selection honest: remove accidental Wrangler boots from the
   shared contract lane and isolate provider/resource-specific jobs.
2. Define the shared public deployment facts and explicit main/compiler build
   identities; add tests for resolution and cache invalidation.
3. Add a generated celld configuration and packaging smoke for both Workers,
   generated SDK/types, WASM and static assets, using pinned versions.
4. Run the unchanged application against the celld public-contract lane, then
   lifecycle and isolated operational acceptance as required features land.
5. Only if those runs reveal a real mismatch, decide between an upstream fix
   and a small change in the module that owns that behavior. Do not add a
   general runtime abstraction preemptively.

This research changed documentation only. It did not run or deploy V4 on celld,
execute deployed acceptance tests, or establish current end-to-end compatibility.

## Entrypoints and startup

The existing V4 **module entrypoints**, rather than a celld-specific wrapper,
are the starting point: [`worker.ts`](../packages/v4/project-worker/src/worker.ts)
already exports the default `fetch` handler, its named
`IterateContextDurableObject`, and named `WorkerEntrypoint` subclasses
(`ItxEntrypoint` and `DummyControlPlane`); [`bundler.ts`](../packages/v4/project-worker/src/bundler.ts)
is itself a default `WorkerEntrypoint`. Those imports remain from
`cloudflare:workers`. The pinned celld source explicitly provides that module
surface and discovers exported `DurableObject` and `WorkerEntrypoint` classes
for DO namespaces and named service entrypoints, respectively ([module
exports](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/modules.rs#L404-L412),
[class registration](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/bootstrap.rs#L839-L905)).

This does **not** mean that the present V4 Wrangler configurations can be
passed through unchanged. Celld accepts `main`, DO bindings/migrations and
`services`, but rejects other top-level keys; therefore it needs its own
generated config ([supported subset](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#wrangler-configuration)).
V4’s main/compiler pairing means the celld config must explicitly define and
validate the separate deployments and the `BUNDLER` service target; retain
`FALLBACK`'s named `DummyControlPlane` service entrypoint. Celld encodes named
`services[].entrypoint` bindings, but its documented cross-isolate RPC is a
single method call—not `fetch`, pipelining, or an RPC stub that crosses an
isolate—so prove both V4 service calls against that shape ([binding parser](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/deploy.rs#L1082-L1117),
[RPC qualification](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#rpc)).

For a local source/config smoke, `celld dev` starts a node, bundles the project,
and serves it with local durable state. Production instead runs `celld deploy`
to write the Worker deployment to the fleet bucket, then one or more long-lived
celld daemons read that deployment and serve it; ingress/TLS is outside celld
([local development](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/README.md#run-it),
[fleet startup](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/README.md#how-it-works)).
