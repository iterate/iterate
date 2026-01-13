# E2E Testing

Playwright tests. Run: `pnpm e2e`

## Critical

Import `test` from `./test-helpers.ts`, NOT `@playwright/test`. Enables spinner waiter.

## Spinner Waiter

Auto-waits for loading states. Detects `aria-label-"Loading"` attrs and "loading..." text. See `spinner-waiter.ts`.

If slowness is expected, add some progress UI to buy time for the assertion: `<div>Loading...</div>` or `<div aria-label="Loading" className="tailwind-whatever" />` or similar.

## Helpers (test-helpers.ts)

- `login(page, email)` - OTP flow (test OTP: 424242)
- `createOrganization(page)` - Creates org, waits for switcher
- `createProject(page)` - Creates project, navigates to it
- `sidebarButton(page, text)` - Returns sidebar button locator

## Antipatterns

| Don't                                  | Do                                                  |
| -------------------------------------- | --------------------------------------------------- |
| `page.waitForTimeout(2000)`            | Wait for specific element                           |
| `waitForLoadState("networkidle")`      | Trust spinner-waiter or wait for element            |
| Raw `page.evaluate` for API            | Use/create helper in test-helpers.ts                |
| Cleanup code at end of test            | Use unique timestamps (`Date.now()`) for isolation  |
| `.locator('[data-slot=...]').last()`   | Use helper or `getByTestId`/`getByRole`             |
| `await el.waitFor(); await el.click()` | Just `await el.click()` (spinner-waiter handles it) |

## Patterns

```ts
// Good: concise, uses helpers, no explicit waits
test("creates machine", async ({ page }) => {
  await login(page, `test-${Date.now()}+test@nustom.com`);
  await createOrganization(page);
  await createProject(page);
  await sidebarButton(page, "Machines").click();
  await page.getByRole("button", { name: "Create Machine" }).click();
  // ...
});
```

## Examples

- `machine-sync.e2e.ts` - Concise test with helpers
- `spinner-waiter.e2e.ts` - Minimal spinner demo

## Config

120s test timeout, 30s spinner timeout, sequential (workers: 1), Chromium only.
