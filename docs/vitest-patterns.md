# Vitest Testing Patterns

This document covers detailed testing patterns used in this codebase. For the
test lanes themselves — what exists, how to run each against local dev /
previews / prd, and the canonical env vars — see [Testing](testing.md).

## Core Principles

- Use vi mocks and vi fake timers for time-based assertions
- Prefer table-based tests with hand-written literal expectations (`test.for`
  with object rows) over snapshots
- Tests are colocated next to source files as `*.test.ts`

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

`apps/os/src/ingress.test.ts` is the model at scale: dozens of routing cases
as data, one assertion body doing `toMatchObject(expected)`, a comment on any
row whose reason isn't obvious, and helper factories below the table.

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
