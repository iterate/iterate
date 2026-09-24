# Browser testing

Use **[Playwriter](https://playwriter.dev/)** for agent-driven browser work. Prefer an
isolated headless session so automation does not touch a developer's personal
Chrome profiles, tabs, cookies, or logins. Use the Playwriter Chrome extension
(real browser) only when the developer explicitly authorizes actual-browser
access for that task. Load the Playwriter skill (`playwriter skill` once per
session) before the first command.

| Request                             | Browser mode                           | Permission granted                |
| ----------------------------------- | -------------------------------------- | --------------------------------- |
| Normal local browser task           | Playwriter headless Chrome for Testing | Isolated agent session            |
| "No windows", "run headless", or CI | Playwriter headless                    | Isolated background agent session |
| "Use my actual Chrome"              | Extension-connected real Chrome        | Exceptional, current-task-only    |
| Direct CDP / remote debugging       | `playwriter session new --direct`      | Exceptional / CI tooling          |

`PLAYWRITER_AUTO_ENABLE` defaults on (leave unset). With multiple Chrome
profiles, pick a key from `playwriter browser list` when using the extension
path.

## Disposable sessions

```bash
# Headless (default for automation)
SID=$(playwriter session new --browser headless 2>&1 | sed -n 's/^Session \([0-9][0-9]*\) created.*/\1/p')
BASE_URL=http://localhost:8788   # `pnpm dev`; a deployment's URL otherwise
PASSWORD=dev                     # `pnpm dev`'s; a deployment's is its APP_CONFIG login.password

playwriter -s "$SID" --timeout 60000 -e "
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage());
await state.page.goto('$BASE_URL/login', { waitUntil: 'domcontentloaded' });
await state.page.getByRole('textbox', { name: 'Email', exact: true }).fill('agent-$SID@example.com');
const password = state.page.getByRole('textbox', { name: 'Password', exact: true });
if (!(await password.isVisible()))
  await state.page.getByRole('button', { name: 'Use password instead', exact: true }).click();
await password.fill('$PASSWORD');
await state.page.getByRole('button', { name: 'Sign in', exact: true }).click();
console.log(await snapshot({ page: state.page }));
"
```

Use a **new session id per agent/task** so concurrent work does not share
Playwright sandbox state. Prefer `snapshot()` over screenshots for reading the
UI. Follow observe → act → observe after navigations and clicks.

## Reusable test logins

For ordinary OS identities, sign in through the issuer's own password step in a
headless Playwriter session (or an authorized real-Chrome session): the
deployment's global password (`login.password` in its `APP_CONFIG`; `dev` for
`pnpm dev`) signs anyone in as the email they type, so a fresh email is a fresh
disposable user. This is the same step the browser specs take. Persist
cookies in that session's browser context for the duration of the smoke; do not
import the developer's `Default` / `Profile N` Chrome profile.

When a third-party login needs human interaction, have the human complete it in
a controlled Chrome tab with the Playwriter extension enabled, then point the
agent at that tab only with explicit current-task permission.

## Keep CLI and skill current

```bash
npm i -g playwriter@latest
playwriter skill   # once per session — read in full
```

The CLI provides its current instructions through `playwriter skill`; a separate skill install is optional. Personal skills belong in the user's canonical skill tree, with links rather than tool-specific copies. Do
**not** vendor third-party browser CLI skill packs into this monorepo.

## Actual Chrome is exceptional

Attaching to a developer's real Chrome requires an explicit request for that
specific task. Permission to run headless automation is not permission to use
the real browser. Do not install or enable an auto-connect MCP server that makes
attachment the default.

## Automated browser specs

The automated browser suite is `pnpm spec` from the repository root: one root
`playwright.config.ts`, the specs under `specs/` (see `specs/AGENTS.md`). It
starts a local Worker by default. Set `DEMO_BASE_URL` and run under the
target's Doppler config (`doppler run --project project-worker --config
<preview|prd>`, which supplies its `APP_CONFIG`) to run against an existing
deployment. Recorded demos for PRs: `VIDEO_MODE=1 pnpm spec -g <name>` — see
[Pull requests](pull-requests.md#video) and [Testing](testing.md).

Use a disposable project and verify the resulting state. Do not reuse
production identities or shared test state merely to bypass authentication
setup.

## Preview browser smoke

Use this to prove that a PR's deployed preview works through the real browser,
the issuer's sign-in, routing and the app UI. The automated smoke is the Preview
OS workflow's `e2e` job (the integration suite and the browser specs against the
PR's preview). Re-run it from `apps/os` with
`doppler run --project project-worker --config preview -- pnpm preview e2e --pr <number> --name <branch>`
(see its [README](../apps/os/README.md)).

For a hands-on smoke, take the preview URL from the PR body and sign in as in
[Disposable sessions](#disposable-sessions), with the preview's password kept
in a shell variable — never echo it:

```bash
BASE_URL=https://pr<n>-<branch slug>-os-preview.iterate-dev-preview.workers.dev   # from the PR body
PASSWORD=$(doppler secrets get APP_CONFIG --project project-worker --config preview --plain | jq -r .login.password)
```

To prove the UI can mutate deployed state, change something through the UI
using locators from a fresh `snapshot()`, then confirm the result out of band
rather than trusting the page: `iterate itx run` against the preview
(`iterate config set --name preview --os-base-url "$BASE_URL"`, then
`iterate --config preview login` and `iterate --config preview itx run …`).
Live views update over a WebSocket; if one does not update, check the server
state before calling it a UI bug.

## Performance evidence in the browser

For loading-speed work on the platform's pages and the TanStack Start clients,
record three paths for the same signed-in fixture and route: a cold direct
navigation with an empty cache, a warm direct navigation with the cache
retained, and an in-app navigation after hydration. Use a production build or a
preview for asset graphs and timings; local dev is useful for red/green behavior,
but its source modules, debug metadata and rebuild work are not a production
bundle. Record the commit, route, browser, viewport, network/CPU conditions, UTC
window and whether the cache was cold.

Lab timing in an isolated headed or headless browser (Playwriter or Playwright)
is useful for comparing cold vs warm loads; compare identical URLs. Playwright is
the durable product assertion; PostHog is the field distribution; Cloudflare
telemetry is the server-side explanation. A useful Playwright contract for
server-rendered routes is:

- create an authenticated project fixture;
- navigate directly and read `page.goto()`'s response body;
- assert meaningful stable UI is in that HTML;
- interact with the hydrated locator;
- fail on all page and hydration errors.
