# Product browser specs

Root `specs/` covers flows across workers; `apps/os/e2e` covers the OS engine through itx. Specs should explain the product behavior they exercise.

- Locators already wait for actionability: click directly instead of preceding clicks with visibility/enabled assertions. For presence alone, use `locator.waitFor()`.
- Middlewright extends short action budgets only while the UI reports progress. Fix missing loading UI or product latency rather than increasing timeouts. Any explicit timeout override needs an explanatory comment. See [testing](../docs/testing.md#retries-and-timeouts).
- Annotate product error UI with `data-type="error"` so the error reporter captures it; avoid custom defensive error selectors in every test.
- Each test owns its project/state. Do not share fixtures or depend on execution order.

```bash
pnpm spec -g <test>
VIDEO_MODE=1 pnpm spec -g <test>
PLAYWRIGHT_SCREENSHOT='.*' pnpm spec dashboard
```

`PLAYWRIGHT_SCREENSHOT` accepts semicolon-separated regexes against `locator.toString()`; matching successful actions save PNGs in the report. Videos use Middlewright's annotated rendering. [Browser sessions](../docs/browser-testing.md) · [PR media](../docs/pull-requests.md#media-in-the-pr-body)
