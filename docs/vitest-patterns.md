# Vitest Testing Patterns

This document covers detailed testing patterns used in this codebase. For the
test suites themselves — what exists, how to run each against local dev /
previews / prd, and the canonical env vars — see [Testing](testing.md).

## The shape of a test

Every new or edited test follows these nine rules.

1. **Many inputs, one behaviour: a table.** `test.for` with object rows keyed
   `name`, titled `"$name"` ([below](#table-based-testing-with-testfor)). No
   `test.each`, tuple rows or printf titles. A body with four or more
   `expect(f(…))` on one `f` is a table.
2. **One fixture home per suite.** Unit files use their domain harness
   (`iterate/stream/test-support`), Workers files `__workers-tests__/support.ts`,
   e2e files `e2e/support/`, specs `specs/test-support/`. A helper two suites
   need moves down a layer, never into a copy
   ([where test helpers live](testing.md#where-test-helpers-live)).
3. **No casts in test bodies.** One typed builder at the bottom of the file,
   with defaults, casting at most once, with a comment. When production takes
   more than it uses, narrow its parameter (`Pick<>`) instead of casting at
   every call. The Workers suite reads the platform through `readLog` and
   `snapshot`, not `invoke(…) as {…}`.
4. **Assert the object.** `toMatchObject` on the whole value; `toEqual` only
   where exactness is the point, and say so
   ([exact equality](../lint/test-style-rules.md#exact-equality)). No
   `toBe(true)` on a derived boolean: assert the collection.
5. **A title says the behaviour in one line of about 100 characters.** The why
   goes in a comment. A file header names the subject and what is out of scope;
   it never re-lists the tests.
6. **Tests keep production's timings.** No test changes a timing constant or
   the deployment's config: nothing shortens a watchdog, re-check interval or
   quiet window for a test. Unit tests use fake timers or an injected clock. A
   Workers row may move the clock past a production constant it imports
   (`vi.useFakeTimers({ toFake: ["Date"] })`, `vi.setSystemTime`, then
   `runDurableObjectAlarm`, as the sweep rows in `facets.test.ts` do). A timer the
   clock cannot move, such as an in-memory watchdog or re-check, is waited out,
   and so is every timer in e2e. A row whose real wait takes it past its
   suite's budget is marked: an e2e row is tagged `slow`
   ([slow rows](testing.md#slow-rows)), and a Workers row is listed, with the
   timeout it waits, in `UNIT_ROW_WARN_EXEMPTIONS`
   (`packages/shared/src/test-support/e2e-policy/budgets.ts`). A fixed sleep is
   a negative wait, proving that something does not happen, with a comment
   naming what it outlasts; every other wait polls for the outcome
   ([below](#polling-and-waiting-for-conditions)).
7. **Restore by config.** The vitest configs (not the os e2e project) set
   `restoreMocks`, `unstubGlobals` and `unstubEnvs`, so a test restores no spy,
   global or env var itself; fake timers are the exception
   ([no lifecycle hooks](../lint/test-style-rules.md#no-lifecycle-hooks)).
8. **Tests don't read source text.** A rule over source, such as an import
   boundary, is lint. When two files must agree, make one the source of the
   other.
9. **A row no CI runs is not a test.** Every suite runs in CI or is marked
   manual in [Suites](testing.md#suites), and an opt-in variable has a real
   setter. An investigation probe lives in `scripts/`, or goes.

Lint enforces parts of rules 3 and 4 ([below](#test-style-lint-rules)):
helpers sit below the tests, a property assertion is `toMatchObject`, and a
spec never asserts `toBe(true)`. The configs enforce rule 7, and the
[row budget](testing.md#the-row-budget) bounds rule 6's waits in e2e. The rest,
rule 1 included, is review.

Each kind of test has one shape:

| Kind                     | Lives in                                             | Shape                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure function            | `x.test.ts` beside `x.ts`                            | One `test.for`, one assertion body, the expected value a literal in the row; wide inputs from one typed builder                                       |
| Processor or reducer     | `processor.test.ts`, `core-processor.test.ts`        | Rows of `{ name, events, expected }`, events from short builders below the tests, and a re-reduce row ([ship-with rules](testing.md#ship-with-rules)) |
| Stateful unit            | `rpc-stubs.test.ts`, `library.test.ts`               | One typed builder per collaborator, with defaults; a test passes only what differs                                                                    |
| Workers                  | `apps/os/__workers-tests__/<topic>.test.ts`          | Only cases that need `cloudflare:test` controls; `readLog` and `snapshot`; files named by topic, not by incident                                      |
| OS e2e                   | `apps/os/e2e/<topic>.e2e.test.ts`                    | One story per test on its own project (`freshCtx`); whole responses with `toMatchObject`; gates from `project-host.ts`                                |
| Agents e2e               | `apps/agents/e2e/`                                   | As OS e2e; scenarios that differ only in the fake `itx.ai` are rows                                                                                   |
| Browser spec             | `specs/<app>/*.spec.ts`                              | [specs/AGENTS.md](../specs/AGENTS.md); Playwright has no `test.for`, so `for (const row of rows) test(…)` is the table                                |
| Perf                     | `apps/os/perf/<topic>.perf.test.ts`                  | Rows of `{ metric, load }`; budgets in `perf/latency.ts`                                                                                              |
| CI script                | `scripts/**`, `apps/*/scripts/`                      | A table over the pure decision function, IO injected; no tests of argument parsing, log wording or another file's text                                |
| Config conformance       | `depot-workflows.test.ts`, `lint/oxlintrc-*.test.ts` | Only invariants that guard cost or security, each a rule over every workflow or config                                                                |
| Lint rule                | `lint/oxlint-plugin-*.test.ts`                       | Rows of `{ name, source, reports }`, each source a template literal, one body through `lintOne`                                                       |
| Test support's own tests | `packages/shared/src/test-support/`                  | A fake run from one typed builder per reporter                                                                                                        |
| Firmware host            | `apps/kit/firmware/tests/*_test.c`                   | `<assert.h>` (CMake passes `-UNDEBUG`), shared fixtures in a header (`capnweb_capture.h`), no per-file assert macros                                  |

## Test-style lint rules

Every `*.test.ts(x)` is linted for one style: flat files with top-level
`test(...)` calls (no `describe`), helpers below the tests, no lifecycle hooks,
no `vi.mock`, `test` rather than `it`, and
`expect(object).toMatchObject({ property })` rather than
`expect(object.property).toBe(...)`. Every line complies. [The rules and what to write instead](../lint/test-style-rules.md)
cover ordered rows (`test.sequential`), gated suites (`test.skipIf`), disposable
fixtures (`using`/`await using`) and the os unit suite's `cloudflare:workers` shim.

## Table-based Testing with test.for

Use `test.for` with object rows for table-driven tests: a `name` per row,
`$name` as the title, inputs and the expected value written out as literals in
the row. Unlike `.each`, `.for` doesn't spread array elements - it passes the
entire row as a single argument, so it destructures cleanly:

```typescript
test.for([
  { name: "an admin can delete", role: "admin", canDelete: true },
  { name: "a user cannot delete", role: "user", canDelete: false },
  { name: "a guest cannot delete", role: "guest", canDelete: false },
])("$name", ({ role, canDelete }) => {
  expect(getPermissions(role)).toMatchObject({ canDelete });
});
```

The Cloudflare refusal table in `apps/os/__workers-tests__/identity.test.ts`
is a model: each refusal case as a row of data with a literal expected status,
`$name` as the title, and one assertion body.

A `$field` title prints the row's value quoted and whole: every vitest config
(each `apps/os` project too) sets `chaiConfig: { truncateThreshold: 0 }`, where
Vitest's default cuts it at 40 characters with `…`. The same setting prints a
failed assertion's values whole. `test.for`'s options apply to every row, so a
per-row bound such as a timeout goes to the code it bounds
(`memory-budget.test.ts` passes each row's timeout to its child process).

Expectations are literals a reviewer can read against the row's inputs — not
snapshots. `.toMatchInlineSnapshot()` regenerates on demand, which turns
review into accepting machine output and lets wrong output get ratified; it's
all but absent from the corpus, and new tests shouldn't add it. When only part
of a structure matters, assert that part (`toMatchObject`, or pick the fields)
instead of snapshotting the whole thing.

## Polling and Waiting for Conditions

The Workers suite and the e2e suite each poll with their own
`until(label, fn, timeoutMs?)`, suite-local by design
([test helper layers](testing.md#where-test-helpers-live)):
`apps/os/__workers-tests__/support.ts` and `apps/os/e2e/support/client.ts`.
`until` returns the first value that is neither `undefined` nor `false`, and
throws `until(<label>): timed out …` once `timeoutMs` passes (10s in the
Workers suite, 20s in e2e, whose copy also polls through a throwing `fn`):

```typescript
const row = await until("subscription row", async () =>
  (await subscriptions(itx)).find((s) => s.name === name),
);
```

A row that waits out a real timeout gives `until` a deadline past it:
`facet-push-timeout-heals.test.ts` waits for the 60 s facet watchdog's heal
with `WATCHDOG_MS + 20_000`.

Unit tests, which cannot import those helpers, use Vitest's own
[`expect.poll`](https://vitest.dev/api/expect.html#poll) and
[`vi.waitFor`](https://vitest.dev/api/vi.html#vi-waitfor).
