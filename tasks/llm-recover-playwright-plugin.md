---
name: LLM recover Playwright plugin
overview: Add a new Playwright plugin `llm-recover.ts` that catches locator failures, captures stack/test/snapshot, calls an LLM which responds with a JS recovery function (codemode), evals it with { page, locator, error, expect } in scope, retries up to a hard limit with attempt history. Extend the plugin system so middleware receives `testInfo`.
todos: []
isProject: false
---

# LLM recover Playwright plugin

## Current plugin system (relevant bits)

- **Entry:** [spec/test-helpers.ts](spec/test-helpers.ts) uses `addPlugins({ page, testInfo, plugins: [hydrationWaiter(), uiErrorReporter(), spinnerWaiter(), ...] })`. Plugins are registered in order; the first registered middleware is the outermost (runs first, wraps the rest).
- **Middleware contract:** [spec/playwright-plugin.ts](spec/playwright-plugin.ts) — `ActionContext` is `{ locator, method, args, page }`. No `testInfo` today. Middleware receives `(ctx, next)`; calling `next()` runs the next middleware or the original locator action; errors bubble out.
- **Error enrichment:** [spec/plugins/ui-error-reporter.ts](spec/plugins/ui-error-reporter.ts) wraps `next()` in try/catch, on failure reads error toasts and uses `adjustError(error, info, filename)` to append lines to the error message, then rethrows.
- **Spinner-waiter:** [spec/plugins/spinner-waiter.ts](spec/plugins/spinner-waiter.ts) shows pattern for suggesting fixes (e.g. `suggestSpinnerMessage`) and `adjustError`; uses `oneArgMethods` / option index from [spec/playwright-plugin.ts](spec/playwright-plugin.ts) for options (e.g. timeout).

## 1. Pass `testInfo` into middleware

Middleware needs test identity and output dir. Today `testInfo` is only used in `addPlugins` for lifecycle and is not passed into the patched locator.

- In [spec/playwright-plugin.ts](spec/playwright-plugin.ts):
  - Add `testInfo: TestInfo` to `PluginState` (set in `addPlugins` when building `state`).
  - Add `testInfo?: TestInfo` to `ActionContext`.
  - In the patched method, when building `ctx`, set `testInfo: state?.testInfo`.

No API change for existing plugins; they can ignore `testInfo`.

## 2. New plugin: `spec/plugins/llm-recover.ts`

### Design: Codemode

The LLM responds with a **JavaScript function body** that receives `{ page, locator, error, expect }` and runs arbitrary Playwright code directly. No structured response schema, no action enum — the LLM writes real code against the real Playwright API, which is then `eval`'d and executed.

The function signature:

```ts
async ({ page, locator, error, expect }) => {
  // LLM-generated code runs here
};
```

**Behaviors map naturally to code:**

- **Rethrow (unrecoverable):** `throw error` — this is the default if the LLM returns `null`/empty, so recovery is opt-in.
- **Rethrow with hint:** `error.message += '\n...hint...'; throw error`
- **Wait longer:** `await page.waitForTimeout(5000); await locator.click()`
- **Dismiss modal then retry:** `await page.locator('.modal-close').click(); await locator.click()`
- **Use different locator:** `await page.getByRole('button', { name: 'Submit' }).click()`
- **Any combination:** the LLM can add sleeps, try multiple selectors, interact with page state, etc.

**Soft assertion for false-pass protection:** When the LLM recovers successfully (function completes without throwing), emit a soft assertion failure so the test continues but is ultimately marked as failed:

```ts
expect
  .soft(
    null,
    `[llm-recover] ${locator}.${method}() failed and was recovered by LLM. Original error: ${error.message}. Recovery: ${recoveryDescription}`,
  )
  .toBeTruthy();
```

This ensures recovered actions don't silently pass — the test report shows what happened and the test still fails, prompting someone to fix the underlying issue.

### Load-time

Read `process.env.ANTHROPIC_API_KEY`; if missing, throw in the plugin factory so `llmRecover()` fails fast.

### Abstracted LLM call

Introduce `requestRecoveryCode(context, attemptHistory): Promise<string | null>` — returns a JS function body string, or null for "rethrow as-is". Implementation is a direct Anthropic API call for now. Keep this as a clean abstraction boundary so it can be swapped to a proper coding agent (e.g. opencode) later without changing the plugin.

**Prompt contents:** test title/path, file:line of failure, failed locator and method, error message, stack snippet, screenshot (base64), and optionally a truncated HTML snippet. If `attemptHistory.length > 0`, include summary of previous attempts and their errors so the LLM tries something different.

**System prompt:** instruct the LLM to respond with ONLY a JS function body (no markdown fences, no explanation). The function receives `{ page, locator, error, expect }`. If unrecoverable, throw `error` (or a new error with a helpful message). If recoverable, perform the recovery actions using the Playwright `page` API. Remind it that `locator` is the original failing locator, and it can construct new locators from `page`.

### Middleware (register first so it's outermost)

- **Retry loop** with hard limit (e.g. 5). Track **attempt history** (code returned, resulting error). Pass history into LLM each time.
- On each catch (until limit):
  - **Context:** From `error`: full `error.stack`. From `ctx`: `locator` (`.toString()` for selector), `method`, `args`. From `ctx.testInfo` (if present): `titlePath()`, `file`, `line`, `outputDir`. Derive "failing line" by parsing the stack for the first spec file frame.
  - **Snapshot:** `page.screenshot()` as base64. Optionally `page.content()` (truncated). Save screenshot to output dir.
  - **LLM:** Call `requestRecoveryCode(context, attemptHistory)`.
  - **Execute:** If code returned, `eval` it into an async function and call with `{ page, locator, error, expect }`. If it throws, push to attempt history and loop. If it completes, emit soft assertion (see above) and return.
  - **Null/empty response:** Treat as rethrow — throw the original error.
  - **Eval failure** (syntax error in LLM code): Push to attempt history with the syntax error, loop continues.
  - **Artifact:** Write to `testInfo.outputDir/llm-recover/` a JSON file containing: test id/title, failure summary, each attempt (code, result/error), screenshots, and timing.
- When limit reached, rethrow the last error with `adjustError` summarizing all attempts.

### Dependencies

`import { z } from "zod/v4"` (for any config validation). For Anthropic: direct `fetch` to Messages API. `node:fs` and `node:path` for artifacts. `expect` from `@playwright/test` for soft assertions.

## 3. Export and wiring

- Export `llmRecover` (and optional options type) from [spec/plugins/index.ts](spec/plugins/index.ts).
- In [spec/test-helpers.ts](spec/test-helpers.ts), add `llmRecover()` to the `plugins` array **only when** `process.env.LLM_RECOVER` is set (gate on this rather than just ANTHROPIC_API_KEY, so the key can exist in env without enabling recovery). Document in spec AGENTS.md.

## 4. Ordering and retry behavior

- Register `llmRecover()` **first** in the plugins array so its middleware is the outermost and sees the final error after spinner-waiter / ui-error-reporter have enriched it.
- **Retry with limit:** Hard limit (e.g. 5) per failing action. Each request receives `attemptHistory` so the LLM can try different strategies. When the limit is reached, rethrow the last error.

## Files to add/change

| File                                                       | Change                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [spec/playwright-plugin.ts](spec/playwright-plugin.ts)     | Add `testInfo` to `PluginState` and `ActionContext`; set and pass in patch.                                                                                                          |
| [spec/plugins/llm-recover.ts](spec/plugins/llm-recover.ts) | New plugin: codemode recovery — LLM returns JS function body, eval with `{ page, locator, error, expect }`, retry loop, attempt history, soft assertion on recovery, artifact write. |
| [spec/plugins/index.ts](spec/plugins/index.ts)             | Export `llmRecover`.                                                                                                                                                                 |
| [spec/test-helpers.ts](spec/test-helpers.ts)               | Add `llmRecover()` to plugins when `LLM_RECOVER` env var is set.                                                                                                                     |
| [spec/AGENTS.md](spec/AGENTS.md)                           | Short note on LLM recover plugin and opt-in env.                                                                                                                                     |

## Future work

- **Agent-mode provider:** Replace the single Anthropic API call with a proper coding agent (e.g. opencode) that can interactively test its assumptions — try a locator, see if it works, refine. This would make the `recover` case much more reliable. Keep the `requestRecoveryCode` abstraction clean to make this swap easy.
- **Accessibility snapshot:** In addition to screenshot, send an accessibility tree snapshot for better locator suggestions.
- **Token/cost tracking:** Log token usage per attempt in the artifact for cost visibility.

## Design decisions log

- **Codemode (LLM returns JS, not structured data):** The LLM returns a JS function body, not a JSON action descriptor. This lets it use the full Playwright API — sleeps, multiple selectors, conditional logic, page state inspection — without us maintaining a parallel schema of allowed actions. The test sandbox is already isolated, so eval is acceptable.
- **Soft assertions for false-pass protection:** When recovery succeeds, `expect.soft(...)` marks the test as failed while allowing it to continue. This prevents silent false passes — someone must fix the underlying issue.
- **`null` = rethrow:** If the LLM returns null/empty, the original error is rethrown as-is. Recovery is explicitly opt-in from the LLM's perspective.
- **Single API call for v1, agent loop later:** A single LLM call with full context (screenshot, error, test info) is sufficient for classification + simple recovery. The retry loop with attempt history provides multi-turn reasoning. A proper agent loop would help for cases where the LLM needs to explore the DOM interactively, but that's a natural v2 after seeing where v1 falls short.
- **Gate on `LLM_RECOVER` env var, not just `ANTHROPIC_API_KEY`:** The API key may be in the environment for other reasons. Explicit opt-in is clearer.
