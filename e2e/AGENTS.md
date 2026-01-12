# E2E Testing

Playwright tests. Run: `pnpm e2e`

## Critical

Import `test` from `./test-helpers.ts`, NOT `@playwright/test`. Enables spinner waiter.

## Spinner Waiter

Auto-waits for loading states. Detects `data-spinner` attrs and "loading..." text. See `spinner-waiter.ts`.

Skip per-action: `element.click({ skipSpinnerCheck: true })`

Add to UI: `<Spinner data-spinner />`

## Examples

- `agents.e2e.ts` - Full CRUD with login, setup, assertions (start here)
- `spinner-waiter.e2e.ts` - Minimal spinner demo

## Helpers (test-helpers.ts)

- `login(page, email, baseURL)` - OTP flow (test OTP: 424242)
- `ensureOrganization(page)` - Creates org if needed
- `ensureProject(page)` - Creates project if needed

## Config

120s test timeout, 30s spinner timeout, sequential (workers: 1), Chromium only.
