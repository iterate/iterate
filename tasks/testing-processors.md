We want to create e2e tests for `apps/agents`.

More specifically:

- `apps/agents` is the real app under test
- "processor testing" is a higher-level specialization on top of that
- the fixture stack should first make it easy to test the app as an internet-connected service
- then a higher layer can add event-stream-specific affordances like `waitForEvent(...)`

Requirements:

1. Each test case must be able to "mock the whole internet" / replay from HAR (via mock-http-proxy)
2. Must be possible to run against real deployed processor and events service (as well as possibly locally)
3. Must support testing with _multiple_ processors
4. Need to be able to run a great many tests in parallel

# Desired fixture layering

The main goal is not one giant agents/events fixture. The goal is a clean ladder of tiny async-disposable fixtures, each in its own well-documented file, that compose upward.

Roughly:

1. Very low-level generic fixtures in `packages/shared`
   - temp dir
   - slugified current test identity
   - free port
   - child process / dev server
   - cloudflare tunnel
   - mock HTTP proxy / HAR replay
2. Mid-level app/network fixtures in `packages/shared`
   - "start this app on a free port"
   - "make this local service reachable from outside"
   - "create an artifact directory + naming namespace for this test"
3. High-level app-specific fixtures near the owning package/app
   - `apps/events-contract/test-helpers/*` for event/stream helpers
   - `apps/agents/...` or another appropriate owner for agents-specific composition
4. Highest-level composed fixture for "I want to test this agents app behavior"
   - may include event-stream-specific helpers such as `waitForEvent(...)`
   - but should be obviously composed from the smaller building blocks

## Package ownership direction

- `packages/shared/test-helpers/` should contain the "clean" shared test helpers
- app/package-specific helpers can live beside their owning code when they depend on app-specific contracts or semantics
- `jonasland/` should be retired as a namespace; anything in there that is actually good and general should move to clearer shared homes

## Migration stance

- hard cut
- no backwards compatibility
- no temporary `jonasland` compatibility exports
- if something is worth keeping, move it to the new location and update imports directly
- do not add new code under a `jonasland` namespace

## Migration scope for now

- only move approved, known-good test helpers out of `jonasland`
- do not move deployment/runtime/provider/service code yet
- the first cleanup pass is specifically about getting the clean fixture layer into shared
- if a helper currently depends on non-test `jonasland` code, that is okay for now; we do not need to solve the entire namespace breakup in one pass

## Runner boundary

- low-level shared fixtures should be runner-agnostic
- test-runner integration should be thin and near the top of the stack
- Vitest-specific "current test" helpers should adapt Vitest metadata into plain inputs like `testName`, `slug`, and artifact namespace
- lower fixtures should not depend on Vitest globals if a plain parameter will do

## Documentation requirement

- the new shared test helpers folder should include an `AGENTS.md`
- it should explain:
  - low-level fixtures are tiny, simple, and runner-agnostic
  - higher-level fixtures compose smaller ones
  - app/package-specific helpers should live with their owning package when they depend on app semantics
  - each fixture should live in its own file, be well motivated, and have strong docstrings

## Immediate outcome to optimize for

Work backwards from the smallest proof of value:

- a very simple test of `apps/agents`
- showing that it can receive forwarded events from deployed `events.iterate.com`
- this implies exposing local `apps/agents` through a public tunnel
- the test should then add a real subscription/configured event against real `events.iterate.com`
- and observe `events.iterate.com` sending a real request back through the tunnel into `apps/agents`
- for this first proof, the inbound surface in `apps/agents` should be a tiny dedicated route in `src/routes`, not oRPC
- the outcome should be observable on the stream itself, not via test-only in-memory debug endpoints
- the shape should be as simple as the `ping-pong` processor:
  - receive forwarded request from events
  - call append on `events.iterate.com`
  - observe the appended marker event on the stream
- this means `apps/agents` needs an app config key for the events base URL
- the forwarded payload does not need a separate `path` field if the forwarded event already includes `event.streamPath`
- using lower-level shared primitives composed directly in the test
- without waiting for a polished high-level composed fixture layer first

For the first proof:

- the subscription can forward all events
- but `apps/agents` should only append the marker response when the forwarded payload matches a simple condition such as containing `"ping"`
- this keeps the forwarding setup generic while avoiding noisy or recursive responses
- the response event type can just be plain `"pong"` for this teeny tiny proof
- control events and trigger events in the test should be appended via a real oRPC client to `events.iterate.com`
- the events base URL used by the test should come from `EVENTS_BASE_URL`, with production as a sensible default if needed
- for the first pass, it is acceptable and even preferred to type the minimal oRPC client setup inline in a single Vitest test
- a cleaner/minimal shared fixture or helper can be extracted after the first real test proves the shape
- the concrete setup sequence should be:
  - obtain free port using a tiny fixture
  - start `apps/agents` on that port
  - open a tunnel to that local app
  - append `subscription/configured` against real `events.iterate.com` with the tunneled callback URL
- the dev-server primitive should stay tiny:
  - async-disposable
  - takes `cwd`, `command`, `args`, `port`, optional `host`, and env
  - waits for readiness
  - exposes `baseUrl`
  - kills the process on dispose
  - should accept an optional healthcheck path argument
  - should default to `GET /api/__internal/health`, which appears to be the app-style internal health convention in this repo
  - should use argv-style process spawning, not a shell command string
  - should do the least possible thing for logs/output in v1:
    - keep logs internal
    - only surface recent stdout/stderr in failure messages
    - do not build a richer logs/artifacts API yet
- host binding needs a small amount of care:
  - `apps/agents/vite.config.ts` currently defaults `HOST` to `"::"` specifically so both `localhost`/`::1` and `127.0.0.1` work
  - so `useFreePort` can stay simple, but `useDevServer` should avoid baking in a surprising host policy without an explicit choice
  - if `host` is omitted, the fixture should leave `HOST` unset and let the app's own config decide
- the first tunnel primitive should also stay conceptually tiny from the caller's point of view:
  - it should lease its own Cloudflare tunnel from Semaphore
  - it should open the tunnel to the local port
  - it should return only a `publicUrl` plus dispose
  - it should clean up both lease and process on dispose

## App config precedent

There is already a naming/style precedent for this:

- `packages/shared/src/apps/config.ts`
  - `BaseAppConfig` already includes `externalEgressProxy`
  - so cross-service runtime URLs in app config are already an established pattern
- `apps/events/src/app.ts`
  - uses `apiBaseUrl`
- `apps/agents/src/app.ts`
  - already uses `apiBaseUrl`

So the agents app should probably add a dedicated non-public config field for talking to events, likely something like:

- `eventsBaseUrl`

That seems cleaner than `eventsAppBaseUrl` unless we discover another stronger repo-wide naming convention.

For the first proof, `apps/agents` should talk back to events via a real oRPC client, not an inline fetch helper.

So:

- shared should include the lower-level primitives as quickly as possible
- higher-level composition can stay manual in the first test
- we can add nicer composed helpers later, after the first real agents test exists

# Existing building blocks in the repo

## Mocking/replaying third-party traffic

- `packages/mock-http-proxy/README.md`
  - `useMockHttpServer` already gives us a per-test HTTP/WebSocket mock server
  - `fromTrafficWithWebSocket` already replays HAR deterministically
  - `useMitmProxy` already exposes proxy env vars for Node processes
- `jonasland/scripts/external-egress-proxy.ts`
  - wraps `mock-http-proxy` as a standalone routable process
  - likely useful when the processor-under-test is not running in the same Node process as the test runner
  - supports `--record`, `--replay`, and `--unhandled error`
- `packages/agent/src/test-helpers.ts`
  - `useProcessorTestRig(...)` already proves a useful local shape:
    - multi-processor support
    - per-test unique path
    - optional HAR replay
    - wait-for-event helper
  - limitation: HAR replay is currently in-process MSW, not a standalone routable proxy for deployed workers

## Talking to apps/events

- `apps/events/e2e/helpers.ts`
  - `requireEventsBaseUrl()`
  - `createEvents2AppFixture({ baseURL })`
  - `collectAsyncIterableUntilIdle(...)`
- `apps/events/e2e/vitest/dynamic-worker-egress.e2e.test.ts`
  - already shows the right outer shape for a real network e2e against `EVENTS_BASE_URL`
  - uses unique stream paths and polls history until a derived event appears
- `ai-engineer-workshop/lib/deploy-processor.ts`
  - already knows how to convert a processor file into a `dynamic-worker/configured` event and append it to a stream
  - likely the most reusable way to "deploy" a processor into apps/events for tests

## Existing agents e2e precedent

- `apps/agents/e2e/vitest/external-egress-proxy.e2e.test.ts`
  - already contains an inline `withAgentsDevServer(...)`
  - uses `spawn("pnpm", ["dev"])`
  - strips inherited `APP_CONFIG*`
  - waits for readiness by parsing the dev URL from process output and probing the app
  - captures stdout/stderr for failure reporting
  - tears the child process down cleanly

This is likely the closest local starting point for the new lower-level `useDevServer(...)` primitive.

These are now better understood as app-specific or contract-specific higher-level helpers, not the base fixture layer.

## Making local things reachable from deployed services

- `jonasland/e2e/test-helpers/use-cloudflare-tunnel-from-semaphore.ts`
  - already leases a Cloudflare tunnel from Semaphore and returns `publicHostname` + `tunnelToken`
- `jonasland/e2e/test-helpers/use-deployment-network-services.ts`
  - `useDeploymentManagedCloudflareTunnel(...)`
  - `useFrpTunnelToPublicDeployment(...)`
  - `useDeploymentManagedFrpService(...)`
  - this is the most complete existing answer to "how can something deployed remotely reach a local mock server?"
- `jonasland/e2e/vitest/02-networking/02e-cloudflare-tunnel.e2e.test.ts`
  - demonstrates the full route:
    - lease tunnel from Semaphore
    - start a managed tunnel
    - expose a public base host
    - point a deployed workload's egress at a host-side mock proxy
    - record HAR

## Parallel-safe test hygiene

- `jonasland/e2e/test-support/e2e-test.ts`
  - already provides per-test slugs and artifact directories
  - useful model for naming deployments, output dirs, and HAR files safely under parallelism
- `apps/events/e2e/vitest.config.ts`
  - currently has `fileParallelism: false`
  - this means the existing `apps/events` e2e setup is not yet aiming for "many tests in parallel"
  - likely implication: processor e2e should be its own suite/fixture design rather than blindly extending the current events e2e config

## Existing shared home we can build from

- `packages/shared/src/jonasland/test-helpers/use-tmp-dir.ts`
  - already matches the desired style pretty well:
    - tiny
    - async-disposable
    - single purpose
    - documented
- `packages/shared/src/jonasland/create-slug.ts`
  - good example of a pure non-fixture primitive that test helpers can build on
- `packages/shared/src/jonasland/deployment/deployment.ts`
  - probably belongs in shared, but conceptually as a runtime/deployment primitive rather than a test helper

So there is already a useful split emerging between:

- pure reusable runtime utilities
- stateful async-disposable test fixtures

The cleanup goal is to keep that split, but remove the `jonasland` branding and move things to clearer locations.

# Implications of requirements

**Each test case needs to deploy or start its own server**
Because "Each test case needs its own mocked internet". The mocked internet needs to point to our mock http proxy and we can only control egress routing for an entire worker (whether run locally or deployed).

**When testing against events.iterate.com, we need to use cloudflare tunnels (or mesh) so events.iterate.com can even reach us**
There should be a usable fixture for this already that uses our semaphore to get a tunnel URL

More specifically, the strongest existing starting point appears to be:

- Semaphore lease: `useCloudflareTunnelFromSemaphore(...)`
- tunnel process management: `useDeploymentManagedCloudflareTunnel(...)`
- host-to-public TCP bridge: `useFrpTunnelToPublicDeployment(...)`
- standalone egress mock: `jonasland/scripts/external-egress-proxy.ts`

# What is "under test"

- If we change apps/events, then we can re-run all existing processor tests and make sure they still pass
- If we change a processor, we can use any deployed events app to test the processor change

# Evals vs tests

If we include a non-deterministic or flaky third party in our tests (especially an LLM), then we call the test an eval

# How I want to run a test

## Local test against events.iterate.com

- Input to test:
  - BASE_URL for events.iterate.com
  - Path prefix and namespace for the test

- Group tests into .test.ts files with describe blocks and tests

### Setting up a test

These steps should all be hidden in a fixture

- Create a mock http proxy -> gives me set of egress env vars (or a base URL I can use as external egress proxy)
- Obtain base URL for mock http proxy
  - Needs to be routable from where the "processor under test" is running - so if processor under test is deployed,
    we need a cloudflare tunnel
- Spin up the server that wraps my processor
  - Provide it with the mock http proxy base URL to be used as external egress proxy (or use env https_proxy env var etc)

- Obtain base URL for the processor server
  - This needs to be routable from whatever events.iterate.com deployment/process we're using
  - So generally speaking will need a cloudflare tunnel

- Generate a _path_ just for this test

- This gives us
  - A mock http proxy fixture
  - An orpc client for apps/events
  - A _path_

## Likely high-level fixture shape

For the eventual agents-specific top layer, something close to:

- `useProcessorE2ETestRig({ eventsBaseUrl, processor, processors, replayHarPath, recordHarPath, projectSlug })`

And it probably returns:

- `events`
  - apps/events client from `createEvents2AppFixture(...)`
- `path`
  - unique per-test stream path
- `mockInternet`
  - standalone proxy server URL
  - HAR read/write helpers
  - maybe raw fixture handle from `useMockHttpServer(...)`
- `processorTarget`
  - either a locally started server or an already-deployed processor endpoint
- `deployProcessor(...)` helper
  - for the case where the test wants to push a processor into apps/events via `dynamic-worker/configured`
- `waitForEvent(...)`
  - probably lifted/adapted from `packages/agent/src/test-helpers.ts`

### Important split

There are really 2 different higher-level modes hidden in this task:

1. **Dynamic worker mode**
   - the "processor" is deployed into apps/events by appending a configured event
   - `ai-engineer-workshop/lib/deploy-processor.ts` is already close to the right primitive
   - no separate processor server is required

2. **External processor server mode**
   - the processor under test is its own long-running service
   - we need to start or deploy it and give it egress settings pointing at the mock proxy
   - this is where the tunnel + FRP + standalone proxy pieces matter most

If these modes are both required, they should probably share:

- path generation
- events client
- HAR management
- wait/poll helpers

but not necessarily share the same "processor startup" abstraction.

## Multiple processors

Existing proof point:

- `packages/agent/src/test-helpers.ts` already accepts `processors: readonly StoppableProcessor[]`
- it starts multiple runtimes against the same path

This suggests we should define "multiple processors" explicitly as one of:

- multiple processors attached to the same stream path
- multiple independently deployed processors in one test case
- one processor under test plus helper processors / fixtures

The first interpretation is already proven locally. The second is much more operationally expensive.

## Parallelism implications

The repo already has patterns for parallel-safe slugs and artifacts, but the hard constraint here is external resources:

- Cloudflare tunnel leases from Semaphore are finite
- each independently mocked internet probably needs either:
  - its own worker/deployment, or
  - a shared proxy that multiplexes traffic by path/namespace
- standalone local ports / HAR output paths / deployment slugs must all be unique per test

So the most realistic staged rollout seems to be:

1. get the fixture working with one proxy per test
2. make it parallel-safe with unique slugs/artifacts
3. only then optimize to one proxy per file with path-based multiplexing

## Likely first implementation

- target `EVENTS_BASE_URL`
- use `createEvents2AppFixture(...)`
- generate unique stream paths
- treat `apps/agents` as the main app-under-test
- prefer lower-level primitives over a polished composed test rig in the first pass
- support dynamic-worker processors first via `deployProcessor(...)`
- support HAR replay via standalone `external-egress-proxy.ts`
- when remote reachability is needed, reuse the Semaphore + tunnel + FRP helpers from `jonasland`
- copy/adapt `waitForEvent(...)` from `packages/agent/src/test-helpers.ts`

This would validate the hard parts without yet solving every possible agents-app runtime shape.

# Implementation notes

- `useMockHttpServer` is enough for the simplest case. We do not need `useMitmProxy` if the processor wrapper can be configured to send outbound traffic to the mock server explicitly.
- `useMockHttpServer` already supports proxy-style request rewriting. By default it rewrites incoming requests using `x-forwarded-host` and `x-forwarded-proto` before MSW/HAR matching.
- So the processor wrapper can treat the mock server as its egress base URL, while still preserving the original destination in headers:
  - request goes to `http://<test-mock-server>/<path>`
  - headers include `x-forwarded-host: api.openai.com`
  - headers include `x-forwarded-proto: https`
- This lets us register handlers against the real upstream URL shape, or replay HAR traffic for the real upstream URL shape, while avoiding per-test CA / TLS / MITM setup.
- We only need the MITM proxy variant when the code under test cannot be pointed at an explicit proxy target and instead only supports transparent proxy env vars / TLS interception.

# Open questions to resolve explicitly

- What is the clean package layout for moving the good `jonasland` runtime/test code into clearer shared locations without carrying the old namespace forward?
- Is the primary app-under-test shape for v1 a locally started `apps/agents` dev server, a deployed `apps/agents` instance, or both?
- Within the agents app, is the primary "processor under test" shape a dynamic worker configured into apps/events, or an external server we own/deploy separately?
- Do we need first-class support for multiple processors in one test on day 1, or is one processor plus future-proofing enough?
- Should this live under `apps/events/e2e`, or should it be a separate suite with parallelism settings that differ from today's `apps/events` e2e config?

# Future improvements

- Use mesh network instead of cloudflare tunnel
- Use a single mock http proxy for all tests in a given test file (multiplex across tests using paths)
