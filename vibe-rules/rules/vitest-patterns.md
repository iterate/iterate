---
description: "Vitest test patterns and polling helpers"
globs: ["**/*.test.ts"]
---

# Vitest Testing Patterns

## Using idiomatic, built-in helpers

Use vi mocks and vi fake timers for time-based assertions.

## Prefer use .toMatchInlineSnapshot()

We like snapshot tests that are inline

## Using pluckFields with Inline Snapshots

Use the `pluckFields` helper from `@iterate-com/helpers/test-helpers/test-utils` to extract specific fields from arrays of objects for concise inline snapshot testing:

```typescript
import { pluckFields } from "@iterate-com/helpers/test-helpers/test-utils";

test("should track state changes", async () => {
  const events = await getEvents();

  // Extract only the fields we care about for the test
  const eventSummary = pluckFields(events, ["type", "data.status", "timestamp"]);

  expect(eventSummary).toMatchInlineSnapshot(`
    [
      ["started", "pending", 100],
      ["progress", "running", 200],
      ["completed", "success", 300]
    ]
  `);
});

// For more compact output, use the optional flags
test("compact state tracking", async () => {
  const events = await getEvents();

  // Create a single string with all events
  const summary = pluckFields(events, ["type", "status"], { joinRows: true });

  expect(summary).toMatchInlineSnapshot(`
    "["started","pending"]
    ["progress","running"]
    ["completed","success"]"
  `);
});

// Or create an array of JSON strings
test("stringified events", async () => {
  const events = await getEvents();

  const jsonEvents = pluckFields(events, ["type", "status"], { stringifyColumns: true });

  expect(jsonEvents).toMatchInlineSnapshot(`
    [
      "["started","pending"]",
      "["progress","running"]",
      "["completed","success"]"
    ]
  `);
});
```

Options:

- `joinRows: true` - Joins all rows with newlines into a single string
- `stringifyColumns: true` - JSON.stringify each row (can be combined with joinRows)

This is particularly useful for:

- Testing sequences of events or state changes
- Focusing on specific fields in complex objects
- Making tests more readable and maintainable
- Avoiding brittle tests that break when unrelated fields change
- Creating compact debug output for multi-step workflows

## Table-based Testing with describe.for and test.for

Use `describe.for` and `test.for` for table-driven tests. Unlike `.each`, `.for` doesn't spread array elements - it passes the entire element as a single argument:

```typescript
describe.for([
  ["add", 1, 2, 3],
  ["subtract", 5, 2, 3],
  ["multiply", 3, 4, 12],
])("%s(%i, %i) -> %i", ([operation, a, b, expected]) => {
  test("returns correct result", () => {
    const result = calculate(operation, a, b);
    expect(result).toBe(expected);
  });
});

// With object cases for better readability
test.for([
  { user: "Alice", role: "admin", canDelete: true },
  { user: "Bob", role: "user", canDelete: false },
  { user: "Charlie", role: "guest", canDelete: false },
])("$user with $role role", ({ user, role, canDelete }) => {
  const permissions = getPermissions(role);
  expect(permissions.canDelete).toBe(canDelete);
});
```

## Polling and Waiting for Conditions

### 1. expect.poll() - Recommended for async assertions

Polls a function until it returns the expected value or times out.

```typescript
import { expect, test } from "vitest";

test("should eventually return expected value", async () => {
  // Basic usage
  await expect
    .poll(
      async () => {
        const events = await trpcClient.getEvents.query();
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

  // Finding specific content
  await expect
    .poll(async () => {
      const response = await api.getMessage();
      return response.text.toLowerCase();
    })
    .toContain("expected content");
});
```

### 2. vi.waitFor() - More flexible alternative

Waits for a callback to execute successfully (without throwing).

```typescript
import { vi, expect, test } from "vitest";

test("should wait for condition", async () => {
  // Wait for any condition to be met
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

### 3. vi.waitUntil() - For custom conditions

Similar to waitFor but returns the first truthy value.

```typescript
test("should wait until condition is truthy", async () => {
  const element = await vi.waitUntil(
    async () => {
      const elements = await page.findElements(".my-class");
      return elements.length > 0 ? elements[0] : null;
    },
    { timeout: 3000 },
  );

  expect(element).toBeDefined();
});
```
