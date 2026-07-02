# Testing: Unit, E2E, And Playwright Specs

How the test lanes are organized, how to run each against any environment, and
the canonical environment variables. For unit-test style (fake timers, inline
snapshots, `test.for` tables), see [Vitest patterns](vitest-patterns.md).

## Lanes

| Lane             | Command (from `apps/os` unless noted) | Lives in                                       | Proves                                                                                                                                                                       |
| ---------------- | ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `pnpm test`                           | `apps/os/src/**/*.test.ts` (colocated)         | In-process logic; no deployment needed.                                                                                                                                      |
| OS e2e           | `pnpm e2e`                            | `apps/os/e2e/vitest/` (`e2e/vitest.config.ts`) | URL-driven black box against a live deployment through the itx surface: streams, stream security, project ingress, agents, admin, preview smoke.                             |
| Examples matrix  | `pnpm e2e:examples`                   | `apps/os/e2e/examples/`                        | Every itx catalogue example runs identically across five runtimes (browser, node, cli, run-script, project-worker). The browser project needs a Playwright chromium install. |
| TUI              | `pnpm exec tsx e2e/tui-test/run.ts`   | `apps/os/e2e/tui-test/`                        | The `iterate chat` TUI through a real PTY (Microsoft TUI Test) against a disposable project.                                                                                 |
| Playwright specs | `pnpm spec` (repo root)               | `specs/` (`playwright.config.ts`)              | Browser-level product flows: signup, project create, dashboard, REPL, agent chat, reactivity.                                                                                |

## Running a lane against an environment

Every non-unit lane targets a live deployment and is invoked the same way:

```bash
doppler run --config <cfg> -- pnpm <lane>
```

The Doppler config supplies the deployment identity — `APP_CONFIG_BASE_URL`
and `APP_CONFIG_ADMIN_API_SECRET` (plus optional integration secrets):

```bash
# local dev (start `pnpm dev` first; base URL comes from the discovery file)
doppler run --config dev -- pnpm e2e

# a preview slot
doppler run --config preview_3 -- pnpm e2e

# production
doppler run --config prd -- pnpm e2e
```

Local configs (`dev`, `dev_<you>`) do not set `APP_CONFIG_BASE_URL`; the
harness falls back to the dev-server discovery file
(`apps/os/.alchemy/dev-server.json`, written by `pnpm dev`). To point a lane at
a custom target (captun, another port), set the base URL explicitly _inside_
the Doppler environment:

```bash
doppler run --config dev -- env APP_CONFIG_BASE_URL=http://localhost:1234 pnpm e2e
```

## Environment variables

The rule: **one name per control**. `APP_CONFIG_*` variables come from the
Doppler config and describe the deployment under test — tests never invent
parallel names for them. `OS_E2E_*` variables are harness knobs. Nothing else
exists (the root Playwright config additionally honors the
Playwright-conventional `CI` and `VIDEO_MODE`, deliberately unrenamed).

| Variable                         | Set by                                               | Controls                                                                                      | Default                                                    |
| -------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `APP_CONFIG_BASE_URL`            | Doppler (deployed configs); unset in local configs   | THE deployment under test, for every lane                                                     | Local dev-server discovery file                            |
| `APP_CONFIG_ADMIN_API_SECRET`    | Doppler                                              | Admin credential for the itx surface (project seeding, admin lanes)                           | None — lanes that need it throw                            |
| `APP_CONFIG_INTEGRATIONS__SLACK` | Doppler                                              | Gates the slack-agent e2e suite (provides the Slack signing secret)                           | Unset → suite skips                                        |
| `OS_E2E_RUN_SLUG`                | Preview CI / you (optional)                          | Stable run slug correlating vitest-artifacts run roots across lanes                           | Random slug per run                                        |
| `OS_E2E_EXAMPLES_PARALLEL`       | Preview CI (`scripts/preview/preview.ts`)            | `"true"` enables file parallelism in the examples matrix                                      | Sequential (protects a single local dev server)            |
| `OS_E2E_EXAMPLES_SKIP_MATRIX`    | Preview CI (`scripts/preview/preview.ts`)            | `"true"` skips the matrix cases (the catalogue-coverage invariant still runs)                 | Matrix runs                                                |
| `OS_E2E_SMOKE_PROJECT_SLUG`      | You (optional)                                       | Seed-project slug for the preview smoke                                                       | `preview-mcp-smoke-<GITHUB_SHA prefix or "manual">`        |
| `OS_E2E_MCP_URL`                 | You (optional)                                       | Explicit project MCP URL for the preview smoke when it cannot be derived from the base host   | Derived from `os.iterate.com` / `os.iterate-preview-N.com` |
| `OS_E2E_CODEMODE_PROJECT_SLUG`   | You (optional)                                       | Project slug for `e2e/workspace-itx-preview-example.ts`                                       | `workspace-itx-example-<timestamp>`                        |
| `OS_E2E_TUI_PROJECT_ID`          | `e2e/tui-test/run.ts` (internal; passed to the spec) | The disposable project the TUI spec chats against                                             | Unset → TUI spec skips                                     |
| `OS_E2E_TUI_SNAPSHOT`            | You                                                  | `"1"` opts into the manual aesthetic TUI snapshot test                                        | Skipped                                                    |
| `CI`                             | GitHub Actions                                       | Playwright: `forbidOnly`, 2 retries, trace on first retry, never reuse an existing dev server | Unset locally                                              |
| `VIDEO_MODE`                     | You                                                  | `"1"` makes Playwright record video with relaxed timeouts                                     | Video only retained on failure                             |

## Artifacts

- **Vitest e2e lanes** write per-run artifact roots under the OS temp dir —
  `os-e2e-*` (`pnpm e2e`) and `os-itx-e2e-*` (`pnpm e2e:examples`); that is
  `/tmp/os-e2e-*` and `/tmp/os-itx-e2e-*` on Linux/CI — containing per-test
  console logs. The active root is printed at startup
  (`[vitest-artifacts] run root: …`); `OS_E2E_RUN_SLUG` names the run.
- **Playwright** writes `test-results/` at the repo root: traces, videos, and
  screenshots under `test-results/playwright-output`, plus HTML and JSON
  reports.
- **Preview CI** uploads all of the above (`test-results`,
  `apps/os/test-results`, `/tmp/os-e2e-*`, `/tmp/os-itx-e2e-*`) as a GitHub
  Actions artifact — see `previewTestArtifacts` in
  `scripts/preview/preview.ts`.
