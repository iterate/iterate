# Test-style rules

Six `iterate/*` rules keep a test file flat and readable: the file opens with a
`test(...)`, every test owns its state, and a failure prints the object, not one
field of it. They were introduced in
[#1361](https://github.com/iterate/iterate/pull/1361), re-armed in
[#1965](https://github.com/iterate/iterate/pull/1965), and are armed on every
`*.test.ts` and `*.test.tsx` in the repository: each workspace's unit tests, the
os Workers suite and the e2e suite.

Every line must comply. Where a rule genuinely does not apply to a file, exclude that
exact path in `.oxlintrc.json` with a comment saying why.

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
  concurrently (`--sequence.concurrent`). Rows that share state they also
  measure or reset (one seeded context) are `test.sequential(...)`, and a table
  of them is `test.sequential.for(rows)(...)`. Sequential rows run one at a time,
  in file order, while the file's other rows stay concurrent.
  `apps/os/e2e/isolate-ceilings-deployed.e2e.test.ts` is the model. Prefer a row
  that owns its state over an ordered one: a test that creates its own project
  needs no ordering, and a row that reads worker logs boots its own worker
  (`apps/os/e2e/push-delivery-no-dropped-warns.e2e.test.ts`, sequential only so
  one extra workerd runs at a time).
- **Gated suites.** `describe.skipIf(cond)` becomes `test.skipIf(cond)` on each
  test.
- **Tables.** `describe.for`/`describe.each` become `test.for` with object rows
  ([Vitest patterns](../docs/vitest-patterns.md)).

## No lifecycle hooks

- **Per-test resources** are fixtures the test disposes:
  `using fixture = createFixture()` or `await using echo = await startEcho()`,
  where the helper returns an object with `[Symbol.dispose]` or
  `[Symbol.asyncDispose]`. Several resources go on one `AsyncDisposableStack`.
  The lint tests here (`createOxlintFixture`) are the model.
- **Vitest globals** (fake timers, `vi.stubGlobal`, `vi.stubEnv`, `vi.spyOn`)
  are restored per test with `onTestFinished(...)` inside the test that changed
  them (`vi.useRealTimers()`, `vi.unstubAllGlobals()`, `vi.unstubAllEnvs()`,
  `spy.mockRestore()`). Only apps/kit's config restores them itself
  (`unstubGlobals`, `restoreMocks`).
- **Setup every file of a suite needs** (the os e2e suite's
  `setupFiles: ["./e2e/support/setup.ts"]`, which injects the shared worker's
  URL and disposes each test's sessions) belongs in that suite's `setupFiles`.
  Setup one file needs is an idempotent call at the top of each test that needs
  it.

## No vi.mock

Module mocking replaces an import for the whole file, so the test proves the
code against a module that does not exist. Pass the dependency in instead: a
`fetch`, a clock, a downloader or a `waitUntil` as a parameter or constructor
argument (`apps/os/src/context/rpc-stubs.test.ts` injects its `waitUntil`).
`vi.fn()`, `vi.spyOn(...)` and `vi.stubGlobal(...)` are not module mocks.

For `cloudflare:workers`: the os unit project aliases it to
[`src/test/cloudflare-workers-shim.ts`](../apps/os/src/test/cloudflare-workers-shim.ts),
and Start's generated server entry to a stand-in page
([`src/test/start-server-entry-shim.ts`](../apps/os/src/test/start-server-entry-shim.ts)).
A module whose only platform dependency is a base class (`RpcTarget`,
`WorkerEntrypoint`, `DurableObject`) loads in node with no `vi.mock` in the
test file. Behaviour that needs the real runtime belongs in
the Workers suite (`apps/os/__workers-tests__/`).

## Exact equality

`toMatchObject` matches a subset. When the exact value is the point (a payload
that must round-trip untouched), assert on the whole object with `toEqual`, or
keep the property assertion with a reasoned disable:

```ts
// oxlint-disable-next-line iterate/prefer-object-property-match -- exact round-trip: extra keys must fail
expect(event.payload).toEqual({ text: "hello" });
```
