# Browser testing

Use `agent-browser` with its own isolated Chrome for Testing. It is headless by
default, so normal agent work neither opens windows nor touches a developer's
Chrome profiles, tabs, cookies, or logins.

| Request                                                | Browser mode                | Permission granted                    |
| ------------------------------------------------------ | --------------------------- | ------------------------------------- |
| Normal browser task                                    | Headless Chrome for Testing | Isolated agent session only           |
| "Let me watch", "show me the browser", or "watch mode" | Headed Chrome for Testing   | Show the isolated agent session       |
| "Use my actual Chrome"                                 | Existing developer Chrome   | Exceptional, current-task-only access |

Watch mode is still the agent's isolated browser; `--headed` merely gives it a
visible **Google Chrome for Testing** window. It does not authorize Chrome
DevTools MCP, `--auto-connect`, `--cdp`, or a named personal profile such as
`Default` or `Profile 1`.

## Disposable sessions

Derive a worktree-specific session so parallel agents do not share browser
state:

```bash
SESSION="$(agent-browser session id --scope worktree --prefix os)"
URL="$(doppler run --project os --config dev -- pnpm --silent auth:mint --browser-url)"

agent-browser --session "$SESSION" open "$URL"
agent-browser --session "$SESSION" snapshot -i
agent-browser --session "$SESSION" close
```

For watch mode, add `--headed` to the command that launches the browser:

```bash
agent-browser --session "$SESSION" --headed open "$URL"
agent-browser --session "$SESSION" snapshot -i
```

An already-running headless browser cannot become a window in place. Close it
and relaunch the same restored session or dedicated profile with `--headed`.
If a human clicks or types in the watched window, the agent must take a new
snapshot before continuing because its previous element references may be
stale.

## Reusable test logins

For ordinary OS identities, prefer a minted browser sign-in URL and a stable
restored session:

```bash
SESSION="$(agent-browser session id --scope worktree --prefix os-auth)"
agent-browser --session "$SESSION" --restore open "$URL"
# Pass the same --session and --restore flags on later commands.
agent-browser --session "$SESSION" --restore close
```

When a third-party login needs human interaction, use a dedicated automation
profile—not a profile from the developer's normal Chrome:

```bash
PROFILE="$HOME/.agent-browser/profiles/iterate-agent"
SESSION="$(agent-browser session id --scope worktree --prefix iterate-login)"

# One visible login ceremony for only the intended services.
agent-browser --session "$SESSION" --profile "$PROFILE" --headed open <login-url>
agent-browser --session "$SESSION" close

# Later automation reuses that isolated login headlessly.
agent-browser --session "$SESSION" --profile "$PROFILE" open <url>
```

Close the session before switching between headed and headless modes. Never
open the same persistent profile in two browser processes at once.

## Actual Chrome is exceptional

Attaching to a developer's real Chrome requires an explicit request for that
specific task. Permission to watch Chrome for Testing is not permission to use
the real browser, and actual-browser permission is not a standing preference.
Do not install or enable an auto-connect MCP server to make attachment the
default.
