# E2E Testing Guidelines

This folder contains Playwright end-to-end tests. All e2e tests for the application should go here.

## Running Tests

```bash
pnpm e2e        # Run all e2e tests
```

## Key Files

| File                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `test-helpers.ts`      | Custom test fixture and common helpers - **always import from here** |
| `spinner-waiter.ts`    | Automatic loading state handling                                     |
| `playwright.config.ts` | Playwright configuration                                             |
| `*.e2e.ts`             | Test files                                                           |

---

## Critical: Use Custom Test Helper

**Always** import `test` from `./test-helpers.ts` instead of `@playwright/test`:

```typescript
// Correct
import { test } from "./test-helpers.ts";

// WRONG - don't do this
import { test } from "@playwright/test";
```

The custom test helper automatically sets up the spinner waiter for every test.

---

## Spinner Waiter

The spinner waiter is a core feature that makes tests more reliable by automatically waiting for loading states to complete.

### How It Works

When you call methods like `.click()`, `.fill()`, `.waitFor()`, etc., the spinner waiter:

1. **Detects spinners** - Looks for elements matching:
   - `[data-spinner]` attribute
   - `[data-spinner='true']` attribute
   - Text matching "loading..." (case-insensitive)

2. **Waits intelligently** - Uses Playwright's `.or()` to wait for either:
   - The target element to become visible, OR
   - A spinner to appear

3. **Handles race conditions** - If a spinner appears, it waits for the spinner to disappear before retrying the action

4. **Provides helpful errors** - Enhances error messages with suggestions when timeouts occur

### Configuration

Default settings:

```typescript
{
  spinnerTimeout: 30_000,  // 30 seconds
  disabled: false,
}
```

To skip spinner detection for a specific action:

```typescript
await element.click({ skipSpinnerCheck: true });
```

### Adding Spinners to Your UI

For the spinner waiter to work, add `data-spinner` to loading indicators in your React code:

```tsx
{
  isLoading && <Spinner data-spinner />;
}
```

---

## Available Helpers

### Authentication

```typescript
import { login } from "./test-helpers.ts";

// Logs in with email OTP flow (uses test OTP: 424242)
await login(page, "test@example.com", baseURL);
```

### Setup Helpers

```typescript
import { ensureOrganization, ensureProject } from "./test-helpers.ts";

// Idempotent - only creates if not already on org/project pages
await ensureOrganization(page);
await ensureProject(page);
```

### Navigation Helpers

```typescript
import { getProjectBasePath, getOrganizationSlug } from "./test-helpers.ts";

const basePath = getProjectBasePath(page); // e.g., "/org-slug/project-slug"
const orgSlug = getOrganizationSlug(page.url());
```

---

## Test Patterns

### Basic Test Structure

```typescript
import { test } from "./test-helpers.ts";
import { expect } from "@playwright/test";

test.describe("Feature name", () => {
  test("should do something", async ({ page, baseURL }) => {
    await login(page, `test-${Date.now()}@example.com`, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    // Your test logic
    await expect(page.getByRole("heading", { name: "Title" })).toBeVisible();
  });
});
```

### Use Unique Test Data

Always use timestamps to ensure test data is unique:

```typescript
const testEmail = `test-${Date.now()}+e2e@example.com`;
const agentSlug = `test-agent-${Date.now()}`;
```

### Use Test IDs

Prefer `data-testid` for reliable element selection:

```typescript
// Good
await page.getByTestId("submit-button").click();

// Less reliable - text might change
await page.getByText("Submit").click();
```

### Explicit Waits

Use explicit waits with timeouts:

```typescript
await expect(page.getByRole("button")).toBeVisible({ timeout: 5000 });
await page.waitForURL(/\/dashboard/, { timeout: 10000 });
```

### Performance Monitoring

For tests that track performance:

```typescript
const timings: Record<string, number> = {};

timings.start = performance.now();
await someOperation();
timings.operationDone = performance.now();

console.log(`Operation took: ${timings.operationDone - timings.start}ms`);
```

### WebSocket/Realtime Testing

```typescript
page.on("websocket", (ws) => {
  if (ws.url().includes("/api/ws/realtime")) {
    ws.on("framereceived", (frame) => {
      messages.push(frame.payload?.toString() || "");
    });
  }
});
```

---

## Configuration

Key Playwright settings (`playwright.config.ts`):

- **Test timeout**: 120 seconds
- **Action timeout**: 1 second
- **Workers**: 1 (sequential execution)
- **Retries**: 0 locally, 2 in CI
- **Browser**: Chromium only
- **Base URL**: `APP_URL` env var or `http://localhost:5173`

---

## Gotchas

### Spinner Detection Is Broad

The spinner waiter matches any "loading..." text. Avoid using this exact text for non-loading UI elements.

### Tests Run Sequentially

`workers: 1` means tests don't run in parallel. This prevents race conditions but makes the suite slower.

### Error Messages Are Enhanced

The spinner waiter modifies error messages to include debugging suggestions. These aren't raw Playwright errors.

### Action Timeout vs Spinner Timeout

- Action timeout (1s): How long Playwright waits for an action
- Spinner timeout (30s): How long the spinner waiter waits for loading states

The spinner waiter extends the effective timeout for actions that involve loading states.
