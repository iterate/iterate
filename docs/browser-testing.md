# Browser testing

Use **[Playwriter](https://playwriter.dev/)** for agent-driven browser work. Prefer an
isolated headless session so automation does not touch a developer's personal
Chrome profiles, tabs, cookies, or logins. Use the Playwriter Chrome extension
(real browser) only when the developer explicitly authorizes actual-browser
access for that task. Load the Playwriter skill (`playwriter skill` once per
session) before the first command.

| Request                             | Browser mode                                      | Permission granted                    |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Normal local browser task           | Playwriter headless Chrome for Testing            | Isolated agent session                |
| "No windows", "run headless", or CI | Playwriter headless                               | Isolated background agent session     |
| "Use my actual Chrome"              | Extension-connected real Chrome                   | Exceptional, current-task-only        |
| Direct CDP / remote debugging       | `playwriter session new --direct`                 | Exceptional / CI tooling              |

`PLAYWRITER_AUTO_ENABLE` defaults on (leave unset). With multiple Chrome
profiles, pick a key from `playwriter browser list` when using the extension
path.

## Disposable sessions

```bash
# Headless (default for automation)
SID=$(playwriter session new --browser headless 2>&1 | sed -n 's/^Session \([0-9][0-9]*\) created.*/\1/p')
URL="$(doppler run --project os --config dev -- pnpm --silent auth:mint --browser-url)"

playwriter -s "$SID" --timeout 60000 -e "
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage());
await state.page.goto('$URL', { waitUntil: 'domcontentloaded' });
console.log(await snapshot({ page: state.page }));
"
```

Use a **new session id per agent/task** so concurrent work does not share
Playwright sandbox state. Prefer `snapshot()` over screenshots for reading the
UI. Follow observe → act → observe after navigations and clicks.

## Reusable test logins

For ordinary OS identities, prefer a minted browser sign-in URL opened in a
headless Playwriter session (or an authorized real-Chrome session). Persist
cookies in that session's browser context for the duration of the smoke; do not
import the developer's `Default` / `Profile N` Chrome profile.

When a third-party login needs human interaction, have the human complete it in
a controlled Chrome tab with the Playwriter extension enabled, then point the
agent at that tab only with explicit current-task permission.

## Keep CLI and skill current

```bash
npm i -g playwriter@latest
npx skills add remorses/playwriter --skill playwriter -g -y --copy
playwriter skill   # once per session — read in full
```

Personal installs of the skill live under `~/.agents/skills/playwriter`. Do
**not** vendor third-party browser CLI skill packs into this monorepo.

## Actual Chrome is exceptional

Attaching to a developer's real Chrome requires an explicit request for that
specific task. Permission to run headless automation is not permission to use
the real browser. Do not install or enable an auto-connect MCP server that makes
attachment the default.
