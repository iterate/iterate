# Jonasland E2E

These tests are among the most important assets in the company.

They are durable product requirements, not incidental checks against the current implementation. We expect to rebuild major parts of the system many times. We want these tests to survive those rewrites.

Do not change these tests casually. Do not simplify them to fit the implementation. Do not redesign fixtures or test APIs without direct human instruction.

## Quick Start

Prefer one-file or one-test runs.

Important:

- raw Vitest tags are intentionally mirrored into test titles by the local `test` wrapper in `test-support/e2e-test.ts`
- use `-t docker`, `-t fly`, `-t no-internet`, `-t slow`, and `-t third-party` as fast inclusive filters
- use `--tags-filter` for exact tag slicing
- default `pnpm vitest` excludes `fly`
- use `pnpm vitest:fly` or `pnpm vitest:all` when you explicitly want Fly cases
- this package intentionally uses `vitest@4.1.0-beta.6`, which is the beta line where native test tags are available

From repo root:

```bash
pnpm jonasland e2e vitest 02a
pnpm jonasland e2e vitest 02b -t docker
pnpm jonasland e2e vitest 02b -t no-internet
pnpm jonasland e2e vitest:fly 02b
pnpm jonasland e2e vitest:all 02b -t fly
pnpm jonasland e2e vitest:all -- --tags-filter="fly and slow"
pnpm jonasland e2e playwright -g "public ingress"
```

From `jonasland/e2e`:

```bash
pnpm vitest 02a
pnpm vitest 02b -t docker
pnpm vitest 02b -t no-internet
pnpm vitest:fly 02b
pnpm vitest:all 02b -t fly
pnpm tags
```

If you are developing a single behavior, default to one numbered file filter and then narrow further with `-t`.

## Environment Variables

These env vars provide concrete inputs to the suite. They do not decide which provider cases exist in a file, and they do not replace tags.

- `JONASLAND_SANDBOX_IMAGE`: required baseline image for the suite. We expect this to come from Doppler in normal dev/CI runs, but package scripts preserve a locally-set value so you can override it.
- `E2E_DOCKER_IMAGE_REF`: optional explicit Docker test image override. If omitted, Docker-backed cases use `JONASLAND_SANDBOX_IMAGE`.
- `E2E_FLY_IMAGE_REF`: optional explicit Fly test image override. If omitted, Fly-backed cases fall back to `E2E_DOCKER_IMAGE_REF`, then `JONASLAND_SANDBOX_IMAGE`.
- `FLY_API_TOKEN`: required for Fly-backed cases.
- `E2E_RUN_INTERNET_REQUIRED`: optional policy env for broader workflows that want to decide whether internet-requiring slices should be attempted.
- `E2E_RUN_SLOW`: optional policy env for broader workflows that want to decide whether slower slices should be attempted.
- `E2E_RUN_NON_DETERMINISTIC`: optional policy env for broader workflows that want to decide whether intentionally non-deterministic slices should be attempted.
- `E2E_NO_DISPOSE`: optional policy env for broader workflows that want to decide whether to skip the disposal of the deployment on dispose. Defaults to `false`.
  Shared provider env schemas live in `test-helpers/deployment-test-env.ts`:

- `DockerDeploymentTestEnv`
- `FlyDeploymentTestEnv`

Provider cases should reference one of those schemas and parse it only when that specific test case starts running. If the needed env is missing, that case should fail immediately with a descriptive error.

## Scripts

The package scripts are intentionally small wrappers around Vitest and Playwright.

- `pnpm vitest ...`: default Vitest entrypoint, excludes `fly`
- `pnpm vitest:all ...`: Vitest with no default provider exclusion
- `pnpm vitest:docker ...`: Vitest with `--tags-filter="docker"`
- `pnpm vitest:fly ...`: Vitest with `--tags-filter="fly"`
- `pnpm playwright ...`: Playwright specs
- `pnpm tags`: print configured Vitest tags
- `pnpm test`: alias for `pnpm vitest`

Typical examples:

```bash
pnpm vitest 01a
pnpm vitest 02a -t "default-service change"
pnpm vitest 02b -t docker
pnpm vitest:fly 02c
pnpm vitest:all -- --tags-filter="third-party"
pnpm playwright playwright/03-platform/docs.spec.ts
```

## Vitest Artifacts

Vitest runs create one temp-backed artifact root per invocation. At startup, the
suite prints a line like:

```text
[vitest-artifacts] run root: /var/folders/.../T/e2e-vitest-XXXXXX
```

That root is created in the OS temp directory via `mkdtempSync(...)`. Under it,
each Vitest test that uses the local E2E fixture gets its own directory:

```text
<run-root>/<slugified-file-path>/<test-slug>/
```

Modern Vitest docs relevant to this harness:

- [`provide`](https://main.vitest.dev/config/provide)
- [`globalSetup`](https://v4.vitest.dev/config/globalsetup)
- [`onConsoleLog`](https://main.vitest.dev/config/onconsolelog)
- [`test.extend`](https://vitest.dev/guide/test-context.html#test-extend)

We intentionally use:

- `test.provide` in `vitest.config.ts` for internal run metadata that test workers
  need
- `onConsoleLog(...)` in `vitest.config.ts` for per-test console interception
- the local `test.extend(...)` fixture in `test-support/e2e-test.ts` for per-test
  result files

We intentionally do not use `process.env` for this internal artifact plumbing.
In this package, env vars are for real external inputs like image refs,
credentials, and policy toggles. The artifact harness state is Vitest-owned
runner state, so it stays inside Vitest.

### Using The Fixture

Tests that want artifact output should import the local base `test` from
`test-support/e2e-test.ts`, not `test` directly from `vitest`:

```ts
import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

test("writes artifacts", async ({ e2e, expect }) => {
  console.log(`output dir: ${e2e.outputDir}`);
  expect(e2e.testSlug.length).toBeGreaterThan(0);
});
```

The fixture exposes a single `{ e2e }` object with the current test's artifact
metadata:

- `e2e.outputDir`: per-test artifact directory
- `e2e.outputLogPath`: path to `vitest-output.log`
- `e2e.resultPath`: path to `result.json`
- `e2e.deploymentSlug`: default DNS-safe deployment slug, prefixed with `YYYYMMDD-`
- `e2e.testSlug`: slugified per-test directory name
- `e2e.fileSlug`: slugified per-file directory name
- `e2e.runRoot`: root directory for the whole Vitest invocation
- `e2e.fullName`, `e2e.testId`

### What Gets Written There

By default the harness writes:

- `vitest-output.log`: captured `console.*` output for that test
- `result.json`: structured final test result (`passed`, `failed`, etc)

The fixture also appends a final footer to `vitest-output.log` when the test
finishes:

- passing tests end with a `state: passed` footer
- failing tests end with a `state: failed` footer plus failure details

Tests can place additional artifacts in the same directory. For example,
`useDeployment({ artifactDir: e2e.outputDir })` writes `deployment-logs.yaml`
next to the Vitest log and result files.

When a test needs a deployment name, prefer `e2e.deploymentSlug` over rebuilding
one from `e2e.testSlug`. It already uses the shared
`createDeploymentSlug({ includeDate: true })` logic, so it is DNS-safe and
stable for repeated local debug runs on the same day.

### Why It Is Split This Way

- `vitest.config.ts` creates the once-per-run root, provides it to workers, and
  mirrors `console.*` into `vitest-output.log`
- `test-support/e2e-test.ts` resolves the per-test directory from the injected
  run root and records the final result footer plus `result.json`

That keeps the test API explicit: if a test wants artifact output, it opts into
the local fixture and uses `{ e2e }`.

## Tagging

We are standardizing on native Vitest tags for boolean test dimensions.

Public Vitest docs:

- `https://main.vitest.dev/guide/test-tags.html`

Important version note:

- native Vitest test tags are documented as `4.1.0+`
- this package intentionally uses `vitest@4.1.0-beta.6`

Why tags:

- tags are the right tool for boolean slices like provider, slowness, offline capability, and third-party dependency
- they keep the CLI expressive without exploding the number of package scripts
- they let us slice the suite across multiple axes at once
- they are better than sprinkling ad hoc enablement booleans through case arrays

What should stay as env vars instead:

- concrete values like `E2E_DOCKER_IMAGE_REF`
- credentials like `FLY_API_TOKEN`
- policy inputs that some higher-level workflow may consult

### Current Tag Set

Use this smaller stable vocabulary for now:

- `docker`
- `fly`
- `slow`
- `no-internet`
- `third-party`

Meaning:

- `docker`: the test belongs to the Docker provider slice
- `fly`: the test belongs to the Fly provider slice
- `slow`: the test takes materially longer than the normal inner loop
- `no-internet`: the test should work without internet access
- `third-party`: the test depends on a third party outside our control, excluding the machine provider itself

The machine provider itself does not count as `third-party`. A Fly-backed test is not automatically tagged `third-party` just because it uses Fly.

### Tagging Rules

- use only the tags above unless we explicitly expand the vocabulary
- a Docker-specific test should carry `docker`
- a Fly-specific test should carry `fly`
- a Fly case is often also `slow`, but spell both tags out explicitly
- a test that is intended to work fully offline should carry `no-internet`
- a test that hits an external dependency outside our control should carry `third-party`
- a test that is notably slower than the normal inner loop should carry `slow`

### How We Use Tags In Code

Keep tag arrays explicit on each case object, then pass them straight through to the test options.
When the case object is threaded through a shared test body, prefer `tc` as the
parameter name (`test case`) over vague names like `entry` or reusing
destructuring in several places.

```ts
const cases = [
  {
    id: "docker",
    tags: ["docker", "no-internet"] as const,
  },
  {
    id: "fly",
    tags: ["fly", "slow"] as const,
  },
];

describe.each(cases)("$id", (tc) => {
  test("...", { tags: [...tc.tags] }, async () => {
    // ...
  });
});
```

Selection happens at the CLI:

```bash
pnpm vitest 01a
pnpm vitest:all -- --tags-filter="fly and slow"
pnpm vitest 01a -t docker
```

## Parameterising Tests

Use parameterisation to express real behavioral variants. Do not use it to hide selection logic.

Rules:

- keep one `cases` array when the behavior is the same and only provider details vary
- always declare all real cases in that array
- put an explicit `tags` array on each case object
- use tags and `-t` to decide what runs
- let the case reference an env schema and parse it only when that case starts
- when provider-wide config is needed, prefer a lazy `createProvider()` function on
  the case object so collection-time imports do not eagerly parse env for skipped
  provider cases
- prefer `createDockerProvider(...)` / `createFlyProvider(...)` over any direct
  factory/bind step at the callsite
- return a generic `Deployment` from the case `create(...)` callback so the shared test body interacts with the common contract

Avoid this pattern:

- `enabled: process.env.FOO && process.env.BAR`
- `.filter((entry) => entry.enabled)`
- ternaries that build the tag list at the callsite instead of carrying the tags on the case object

Canonical example:

- `jonasland/e2e/vitest/01-providers/01a-provider-contract.e2e.test.ts`

That file is the reference for:

- explicit per-case tag arrays
- lazy `createProvider()` provider setup for env-gated cases like Fly
- `Deployment.create({ provider, opts })` provider cases
- per-case env schema parsing at case start
- merging provider defaults before `deploymentOpts`

## Concurrency

These tests are intentionally written to run concurrently up to the configured limit in `vitest.config.ts`.

- use unique slugs, container names, app names, ports, and other externally visible identifiers
- do not rely on shared mutable state between cases
- do not quietly serialize a test file just because fixture design is awkward
- if a test cannot safely run in parallel, that is usually a fixture design problem worth fixing
- in Vitest concurrent tests, use the per-test context argument instead of global Vitest state
- prefer `({ task, expect })` in test callbacks
- use `task.name` when you need a stable test-local name
- use context-bound `expect`, not global `expect`, when the test may run concurrently

## Testing From Orbit

We deliberately do not co-locate these tests with the code they exercise.

Unit tests should live close to the implementation. End-to-end tests should live far away from it. We test from orbit: from outside the system boundary, across real interfaces, with as little privileged knowledge as possible.

The same philosophy should later apply to evals.

The core abstraction is not "a process on localhost". It is "an internet-connected entity". We want to model whole companies, services, and agents as systems that can be reached, routed to, observed, and constrained across the internet edge.

That is why we invest in:

- mock HTTP servers at the edge
- HAR capture and replay
- ingress testing
- egress interception
- browser-driven tests through public routes

## Development Process

Always work from a failing test whenever possible.

1. If there is already a failing test for the behavior you care about, make that test pass.
2. If there is no failing test, write one that describes the behavior you want.
3. If you are debugging a failure discovered elsewhere in the codebase, isolate it here as a failing orbit-level test if possible.
4. Run tests surgically. Do not blast the whole suite when one targeted case will do.
5. Get Docker green before Fly unless the scenario is inherently Fly-only.

These tests are intentionally high-bar. Fixture design should be small, explicit, and hard to misuse. Prefer table-driven cases over ad hoc branching.
Do not introduce tiny helper functions for code that is only used once. Inline it unless the abstraction is genuinely reused or clarifies an important boundary.
Before adding any new test helper, first check `packages/shared/src/jonasland/test-helpers/use-deployment.ts` and the nearby exports in `packages/shared/src/jonasland/test-helpers/`.
If a helper is genuinely reusable across multiple E2E files, prefer putting it there rather than growing file-local helper suites.
If a helper starts as file-local polling or lifecycle glue and then appears in a second test, move it onto `e2e.useDeployment(...)` or the shared `useDeployment` fixture instead of growing more ad hoc helper blocks in test files.

# Important Coding Rules

- Do not use pointless type declarations in tests.
- Do not declare loads of single-use interfaces at the top of a file.
- Do add comments that explain context: why the test exists, what situation it models, or what failure mode it is protecting against.
- Comments are only bad when they merely restate the code immediately below them.
- Prefer `deployment.shell({ cmd: "..." })` for shell snippets, pipes, redirects, `&&`, or anything else that is actually shell code. Keep `deployment.exec([...])` for real argv-style process execution.
- Prefer matching the shape you care about with `toMatchObject(...)` and inline Vitest matchers like `expect.anything()` or `expect.stringContaining(...)` instead of asserting every property one by one.

Example:

```ts
expect(deployment.snapshot()).toMatchObject({
  state: "connected",
  locator: expect.anything(),
  opts: {
    slug: e2e.deploymentSlug,
    image: expect.stringContaining("debian"),
  },
});
```

## Onion Layers

The suite is organized as onion layers.

If an outer-layer test fails, walk inward. Do not start by debugging the most complicated workflow. First prove the lower layers beneath it still work.

- `01-providers`: deployment provider contract, lifecycle, attach/reconnect, logs, restarts, persistence, neutral image behavior
- `02-networking`: internal ingress, public ingress, egress, edge routing
- `03-platform`: pidnap, registry, events, observability, docs, agent-facing services

Playwright participates in the same onion. It is not a separate concept. It is just a different orbit-level client.

## Orthogonal Axes

The onion layer is only one axis.

We also care about:

- provider: `docker`, `fly`, later others
- connectivity mode: `offline-local-only`, `mocked-edge`, `har-record`, `har-replay`, `internet-required`
- runner: `vitest`, `playwright`

Internet path versus non-internet path is orthogonal to the onion layers.

We aspire to remove third-party dependency wherever possible, but that is not the same thing as saying everything can run offline. Some tests inherently require internet access, especially anything involving the Cloudflare ingress proxy or Fly. A meaningful subset of Docker tests should still work fully offline using only local Docker and host networking.

## Folder Structure

```text
jonasland/e2e/
  README.md
  AGENTS.md -> README.md
  test-support/
    e2e-test.ts
    e2e-test.test.ts
  vitest/
    01-providers/
      01a-provider-contract.e2e.test.ts
    02-networking/
      02a-ingress.e2e.test.ts
      02b-egress.e2e.test.ts
      02c-public-ingress.e2e.test.ts
      02d-internal-ingress.e2e.test.ts
      02e-cloudflare-tunnel.e2e.test.ts
      02f-egress-docker-only-manual.e2e.test.ts
    03-platform/
      03a-pidnap.e2e.test.ts
      03b-events-service.e2e.test.ts
      03c-registry-service.e2e.test.ts
      03d-otel-tracing.e2e.test.ts
      03e-docs.e2e.test.ts
      03f-open-observe.e2e.test.ts
      03g-example-service.e2e.test.ts
      03h-agents.e2e.test.ts
  playwright/
    01-providers/
      static-page.spec.ts
    02-networking/
      ingress.spec.ts
      egress.spec.ts
      example-service.spec.ts
    03-platform/
      docs.spec.ts
      outerbase.spec.ts
```

HAR recordings should be colocated with the tests that use them.

`tests/old` and `spec/old` are migration source material only. They exist for inspiration, not as the desired final home of this suite.

## What Each File Means

Vitest:

- `01a-provider-contract.e2e.test.ts`: the innermost provider abstraction
- `02a-ingress.e2e.test.ts`: local ingress and default-service behavior inside the sandbox
- `02b-egress.e2e.test.ts`: transparent egress, mocked edge, and HAR-backed egress
- `02c-public-ingress.e2e.test.ts`: public ingress through ingress proxy and related edge infrastructure
- `02d-internal-ingress.e2e.test.ts`: deployment-local ingress checks using curl or fetch
- `02e-cloudflare-tunnel.e2e.test.ts`: Cloudflare tunnel coverage for sandbox services
- `02f-egress-docker-only-manual.e2e.test.ts`: explicit Docker-only/manual egress harness
- `03a-pidnap.e2e.test.ts`: process management and restart persistence
- `03b-events-service.e2e.test.ts`: event append, firehose, and workflow behavior
- `03c-registry-service.e2e.test.ts`: route publication and public URL resolution
- `03d-otel-tracing.e2e.test.ts`: tracing and service-call observability
- `03e-docs.e2e.test.ts`: docs service as a platform workload
- `03f-open-observe.e2e.test.ts`: open-observe as a platform workload
- `03g-example-service.e2e.test.ts`: example-service as a platform workload
- `03h-agents.e2e.test.ts`: `claude`, `pi`, `opencode`, and `codex`, with live and replayed edge coverage where possible

Playwright:

- `static-page.spec.ts`: browser reachability to a simple page served from a minimal container
- `ingress.spec.ts`: browser-visible ingress behavior
- `egress.spec.ts`: browser-visible egress behavior
- `example-service.spec.ts`: an example service UI that triggers egress requests
- `docs.spec.ts`: docs service browser coverage
- `outerbase.spec.ts`: outerbase browser coverage

## Special Case Hosts

- `e2e-test.ingress.iterate.com` is reserved for subdomain-routing E2E coverage against Fly.
- Cloudflare now has an active edge cert for both `e2e-test.ingress.iterate.com` and `*.e2e-test.ingress.iterate.com`.
- Use this host family when the sandbox is configured for subdomain routing rather than dunder-prefix routing.
- Example targets:
  `https://home.e2e-test.ingress.iterate.com`
  `https://events.e2e-test.ingress.iterate.com`
- Keep using the normal generated `*.ingress.iterate.com` hosts for dunder-prefix cases like `events__<slug>.ingress.iterate.com`.

### Custom Domain Test Hosts

- `iterate-e2e-test-custom-cloudflare-domain.com` is the Cloudflare-DNS-hosted custom-domain fixture.
- This host family is useful for proving true apex + wildcard custom-hostname behavior through Cloudflare for SaaS.
- Current expected DNS shape in the customer Cloudflare zone:
  - apex `CNAME` / proxied -> `cname.ingress.iterate.com`
  - wildcard `CNAME` / proxied -> `cname.ingress.iterate.com`
  - ownership `TXT` and `_acme-challenge` delegation records as returned by the provider-side Cloudflare custom-hostname object
- Example targets:
  `https://iterate-e2e-test-custom-cloudflare-domain.com`
  `https://home.iterate-e2e-test-custom-cloudflare-domain.com`
  `https://events.iterate-e2e-test-custom-cloudflare-domain.com`

- `iterate.iterate-e2e-test-custom-domain-no-cloudflare.com` is the Route53-hosted custom-domain fixture to use when DNS is not on Cloudflare.
- For external DNS providers like Route53, use a subdomain, not the zone apex.
- Current expected Route53 shape for the working non-apex case:
  - `iterate.iterate-e2e-test-custom-domain-no-cloudflare.com CNAME cname.ingress.iterate.com`
  - `_cf-custom-hostname.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com TXT <provider-issued-token>`
  - `_acme-challenge.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com CNAME <provider-issued-target>`
- Example targets:
  `https://iterate.iterate-e2e-test-custom-domain-no-cloudflare.com`
  `https://home.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com`
  `https://events.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com`

### Why Route53 Apex Does Not Work Here

- Cloudflare for SaaS normally validates a custom hostname by checking that it CNAMEs into the provider zone.
- Cloudflare-hosted DNS can make an apex behave like that because Cloudflare supports apex CNAME flattening.
- Route53 does not allow a literal `CNAME` at the zone apex, so `iterate-e2e-test-custom-domain-no-cloudflare.com` cannot satisfy that validation in the current setup.
- The provider-side custom-hostname object for that Route53 apex stayed in the `custom hostname does not CNAME to this zone` state, which matches Cloudflare's documented behavior for zones without Apex Proxying enabled.
- A true external-DNS apex would require Cloudflare Apex Proxying on the provider side, which uses dedicated `A` / `AAAA` targets instead of a CNAME.
- This limitation is about where DNS is hosted, not where the domain is registered. The domain can still be registered at AWS, Namecheap, or anywhere else; the deciding factor is whether the authoritative DNS zone is on Cloudflare or whether the provider has Apex Proxying enabled.

## Table-Driven Conventions

Prefer explicit case arrays.

- provider cases should usually live at file scope
- connectivity mode should usually be part of the case data
- provider-specific exceptions can stay in the same file when small
- if provider-only behavior becomes substantial, split into `docker-*` or `fly-*` files

## Surgical Runs

Run the smallest thing that can answer your question.

Vitest:

```bash
pnpm vitest 01a
pnpm vitest 02b -t docker
pnpm vitest:all -t "restart persistence"
```

Playwright:

```bash
pnpm playwright playwright/01-providers/static-page.spec.ts
pnpm playwright -g "public ingress"
```

Start with Docker. Only move to Fly after Docker is working, unless the requirement is specifically about Fly.
