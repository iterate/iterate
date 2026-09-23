# Vitest Testing Patterns

This document covers detailed testing patterns used in this codebase. For the
test lanes themselves — what exists, how to run each against local dev /
previews / prd, and the canonical env vars — see [Testing](testing.md).

## Core Principles

- Use vi mocks and vi fake timers for time-based assertions
- Prefer table-based tests with hand-written literal expectations (`test.for`
  with object rows) over snapshots
- Tests are colocated next to source files as `*.test.ts`

## Test-style lint rules

Every `*.test.ts(x)` is linted for the legacy e2e lane's style: flat files with
top-level `test(...)` calls (no `describe`), helpers below the tests, no
lifecycle hooks, no `vi.mock`, `test` rather than `it`, and
`expect(object).toMatchObject({ property })` rather than
`expect(object.property).toBe(...)`. Existing lines are grandfathered; new and
changed lines comply. [The rules and what to write instead](../lint/test-style-rules.md)
cover ordered rows (`test.sequential`), gated suites (`test.skipIf`), disposable
fixtures (`using`/`await using`) and the os unit lane's `cloudflare:workers` shim.

## Table-based Testing with test.for

Use `test.for` with object rows for table-driven tests: a `name` per row,
`$name` as the title, inputs and the expected value written out as literals in
the row. Unlike `.each`, `.for` doesn't spread array elements - it passes the
entire row as a single argument, so it destructures cleanly:

```typescript
test.for([
  { user: "Alice", role: "admin", canDelete: true },
  { user: "Bob", role: "user", canDelete: false },
  { user: "Charlie", role: "guest", canDelete: false },
])("$user with $role role", ({ user, role, canDelete }) => {
  const permissions = getPermissions(role);
  expect(permissions.canDelete).toBe(canDelete);
});
```

The Cloudflare refusal table in `apps/os/__workers-tests__/identity.test.ts`
is a model: each refusal case as a row of data with a literal expected status,
`$name` as the title, and one assertion body.

Expectations are literals a reviewer can read against the row's inputs — not
snapshots. `.toMatchInlineSnapshot()` regenerates on demand, which turns
review into accepting machine output and lets wrong output get ratified; it's
all but absent from the corpus, and new tests shouldn't add it. When only part
of a structure matters, assert that part (`toMatchObject`, or pick the fields)
instead of snapshotting the whole thing.

## Polling and Waiting for Conditions

### expect.poll() - Recommended for async assertions

Polls a function until it returns the expected value or times out.

```typescript
import { expect, test } from "vitest";

test("should eventually return expected value", async () => {
  await expect
    .poll(
      async () => {
        const events = await stream.getEvents();
        return events.some((e) => e.type === "COMPLETED");
      },
      { timeout: 5000, interval: 100 },
    )
    .toBe(true);

  // With more complex assertions
  await expect
    .poll(async () => {
      const result = await fetchData();
      return result.status;
    })
    .toBe("ready");
});
```

### vi.waitFor() - More flexible alternative

Waits for a callback to execute successfully (without throwing).

```typescript
import { vi, expect, test } from "vitest";

test("should wait for condition", async () => {
  await vi.waitFor(
    async () => {
      const data = await fetchData();
      expect(data.ready).toBe(true);
    },
    { timeout: 5000, interval: 100 },
  );

  // Can include multiple assertions
  const result = await vi.waitFor(async () => {
    const response = await api.call();
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty("id");
    return response.data;
  });
});
```
