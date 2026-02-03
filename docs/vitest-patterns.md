# Vitest Testing Patterns

This document covers detailed testing patterns used in this codebase.

## Core Principles

- Use vi mocks and vi fake timers for time-based assertions
- Prefer `.toMatchInlineSnapshot()` for snapshot tests
- Tests are colocated next to source files as `*.test.ts`
- Avoid `beforeEach`/`afterEach` - use disposable objects instead

## Prefer Flat Tests with Disposable Objects

Avoid `beforeEach`/`afterEach` hooks - they scatter setup across multiple closures, making tests harder to understand. Instead, use `await using` with `Symbol.asyncDispose` for cleanup.

See: https://www.epicweb.dev/better-test-setup-with-disposable-objects

```typescript
// Bad: setup scattered across hooks
describe("myFeature", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createServer();
  });
  afterEach(async () => {
    await server.close();
  });
  it("does something", async () => {
    // what setup does this test have? have to read the hooks
  });
});

// Good: explicit setup with automatic cleanup
async function createTestServer() {
  const server = await startServer();
  return {
    server,
    async [Symbol.asyncDispose]() {
      await server.close();
    },
  };
}

it("does something", async () => {
  await using ctx = await createTestServer();
  // setup is explicit, cleanup is automatic
  ctx.server.get("/foo");
});
```

Benefits:

- Test setup is explicit and visible in each test
- Cleanup runs even if test throws (assertions fail, etc.)
- No shared mutable state between tests
- Easier to understand what each test needs

## Using pluckFields with Inline Snapshots

Use the `pluckFields` helper to extract specific fields from arrays of objects for concise inline snapshot testing:

```typescript
import { pluckFields } from "./test-utils.ts";

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
  const summary = pluckFields(events, ["type", "status"], { joinRows: true });

  expect(summary).toMatchInlineSnapshot(`
    "["started","pending"]
    ["progress","running"]
    ["completed","success"]"
  `);
});
```

Options:

- `joinRows: true` - Joins all rows with newlines into a single string
- `stringifyColumns: true` - JSON.stringify each row (can be combined with joinRows)

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

### expect.poll() - Recommended for async assertions

Polls a function until it returns the expected value or times out.

```typescript
import { expect, test } from "vitest";

test("should eventually return expected value", async () => {
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

### vi.waitUntil() - For custom conditions

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
