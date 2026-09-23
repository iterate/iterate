# Test-style rules

Six `iterate/*` rules keep a test file flat and readable: the file opens with a
`test(...)`, every test owns its state, and a failure prints the object, not one
field of it. They came from the legacy e2e lane ([#1361](https://github.com/iterate/iterate/pull/1361),
re-armed in [#1965](https://github.com/iterate/iterate/pull/1965)) and are armed on
every `*.test.ts` and `*.test.tsx` in the repository: each workspace's unit tests,
the os Workers lane and the e2e lane.

Each rule is wrapped in [grandfatherRule](grandfather-rule.md) with an inclusive
**2026-09-23 23:59:59 UTC** author-date cutoff. Lines last authored on or before then are
exempt; new and changed lines must comply. Fix an old line when you touch it.

| Rule                           | Flags                                                      | Write instead                                          |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ |
| `no-describe`                  | `describe(...)`, `describe.*(...)`                         | Top-level `test(...)` calls; see below                 |
| `no-lifecycle-hooks`           | `beforeAll`, `beforeEach`, `afterAll`, `afterEach`         | A disposable fixture inside the test; see below        |
| `no-vi-mock`                   | `vi.mock`, `vi.doMock`                                     | Dependency injection or a controllable fake; see below |
| `helpers-after-tests`          | A function or class declared above the last top-level test | Move it below the tests                                |
| `prefer-object-property-match` | `expect(object.property).toBe/toEqual/toStrictEqual(...)`  | `expect(object).toMatchObject({ property: ... })`      |
| `prefer-test-over-it`          | `it(...)` and importing `it`                               | `test(...)`                                            |

## No describe

The file name already says what the tests are about, and a wrapper is where
shared closure state and lifecycle hooks grow. Put the group in the title
(`"session teardown: a handle disposes only what it registered"`) or a
`// ── section ──` comment.

- **Rows that must run in order.** `pnpm e2e` runs every file's tests
  concurrently (`--sequence.concurrent`). A row that reads worker-global state
  (its own worker's logs, one seeded context it also resets) is
  `test.sequential(...)`, and a table of them is `test.sequential.for(rows)(...)`.
  Sequential rows run one at a time, in file order, while the file's other rows
  stay concurrent. `apps/os/e2e/push-delivery-no-dropped-warns.e2e.test.ts` is
  the model. Prefer a row that owns its state over an ordered one: the legacy
  e2e lane ran concurrently with no ordered rows, because every test created its
  own project.
- **Gated suites.** `describe.skipIf(cond)` becomes `test.skipIf(cond)` on each
  test, as the legacy Slack suite did.
- **Tables.** `describe.for`/`describe.each` become `test.for` with object rows
  ([Vitest patterns](../docs/vitest-patterns.md)).

## No lifecycle hooks

- **Per-test resources** are fixtures the test disposes:
  `using fixture = createFixture()` or `await using echo = await startEcho()`,
  where the helper returns an object with `[Symbol.dispose]` or
  `[Symbol.asyncDispose]`. Several resources go on one `AsyncDisposableStack`.
  The lint tests here (`createOxlintFixture`) are the model.
- **Vitest globals** (`vi.useRealTimers()`, `vi.unstubAllGlobals()`,
  `vi.restoreAllMocks()` after each test) are restored by the lane's config
  (`unstubGlobals`, `unstubEnvs`, `restoreMocks`), or per test with
  `onTestFinished(...)` inside the test that changed them.
- **Setup every file of a lane needs** (the Workers lane's directory schema)
  belongs in that lane's `setupFiles`. Setup one file needs is an idempotent call
  at the top of each test that needs it.

## No vi.mock

Module mocking replaces an import for the whole file, so the test proves the
code against a module that does not exist. Pass the dependency in instead: a
`fetch`, a clock, a downloader or a `waitUntil` as a parameter or constructor
argument (`apps/os/src/context/rpc-stubs.test.ts` injects its `waitUntil`).
`vi.fn()`, `vi.spyOn(...)` and `vi.stubGlobal(...)` are not module mocks.

For `cloudflare:workers`: the os unit project aliases it to
[`src/test/cloudflare-workers-shim.ts`](../apps/os/src/test/cloudflare-workers-shim.ts),
as the legacy unit lane did. A module whose only platform dependency is a base
class (`RpcTarget`, `WorkerEntrypoint`, `DurableObject`) loads in node with no
`vi.mock` in the test file. Behaviour that needs the real runtime belongs in
the Workers lane (`apps/os/__workers-tests__/`).

## Exact equality

`toMatchObject` matches a subset. When the exact value is the point (a payload
that must round-trip untouched), assert on the whole object with `toEqual`, or
keep the property assertion with a reasoned disable:

```ts
// oxlint-disable-next-line iterate/prefer-object-property-match -- exact round-trip: extra keys must fail
expect(event.payload).toEqual({ text: "hello" });
```
