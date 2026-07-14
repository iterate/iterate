# Browser testing

Use `agent-browser` with its own isolated, headed Chrome for Testing. On a local
interactive machine it is visible by default so the developer can watch each
agent work. Every concurrent agent uses a unique session and therefore gets a
distinct browser window and tab-switcher entry without touching a developer's
Chrome profiles, tabs, cookies, or logins. Use headless mode only when the
developer explicitly asks for no windows or in a non-interactive/CI environment.

| Request                             | Browser mode                                  | Permission granted                     |
| ----------------------------------- | --------------------------------------------- | -------------------------------------- |
| Normal local browser task           | Headed Chrome for Testing                     | Visible isolated agent session         |
| "No windows", "run headless", or CI | Headless Chrome for Testing                   | Isolated background agent session      |
| "Use my Chrome profile/login state" | Chrome for Testing with a personal-state copy | Exceptional, current-task-only import  |
| "Use my actual Chrome"              | Existing developer Chrome                     | Exceptional, current-task-only control |

Watch mode is the normal local default and creates a visible **Google Chrome
for Testing** window. It does not authorize Chrome DevTools MCP,
`--auto-connect`, `--cdp`, or a named personal profile such as `Default` or
`Profile 1`.

## Profile and session model

`--session` and `--profile` solve different problems:

| Mechanism                                           | State                                       | Use                                                       |
| --------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| Unique `--session`                                  | Isolated live browser process               | Every agent and concurrent browser task                   |
| `--session ... --restore`                           | Saved cookies and web storage               | Reuse an ordinary test login across restarts              |
| `--profile ~/.agent-browser/profiles/iterate-agent` | Full persistent Chrome for Testing profile  | Human login to deliberately selected third-party services |
| `--profile Default` or `Profile N`                  | Temporary copy of a personal Chrome profile | Never use without explicit permission to import its state |

`agent-browser profiles` inventories profiles from the developer's real Chrome.
It is not a safe profile picker for normal automation. Use the full path to the
dedicated automation profile so the boundary is visible in every command.
When passed a listed profile name, agent-browser copies that personal profile
to a temporary directory and launches Chrome for Testing against the copy. It
does not attach to or modify the source profile, but it does import the source
profile's broad cookies and login state, so explicit current-task permission is
still required.

Concurrent agents need different session names. They may use separate temporary
profiles freely, but must never open the same persistent `--profile` directory
at the same time. One persistent profile belongs to one browser process at a
time.

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

The machine-level `~/.agent-browser/config.json` sets `"headed": true`, so the
commands above open a visible window without an extra flag. For explicit
headless operation, override that default:

```bash
agent-browser --session "$SESSION" --headed false open "$URL"
agent-browser --session "$SESSION" snapshot -i
```

An already-running browser cannot switch between headed and headless in place.
Close it and relaunch the same restored session or dedicated profile with the
desired setting.
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

# Later automation reuses that isolated login in the normal visible mode.
agent-browser --session "$SESSION" --profile "$PROFILE" open <url>
```

Close the session before switching between headed and headless modes. Never
open the same persistent profile in two browser processes at once.

## Keep the CLI and skills current

The agent-browser CLI and its corresponding skills must be current before use.
The CLI bundles the canonical skills for its exact installed version, so agents
must load `agent-browser skills get core` instead of trusting a cached guide.

```bash
# Update the CLI and its Chrome for Testing binary.
agent-browser upgrade
agent-browser install

# Refresh the global discovery skill for every supported coding agent.
npx skills add vercel-labs/agent-browser --global --agent '*' --yes
npx skills check

# Load instructions that exactly match the installed CLI.
agent-browser skills get core
```

This repository also vendors the full core skill under
`.agents/skills/agent-browser`. Its `VERSION` must match
`agent-browser --version`; refresh and commit the vendored skill whenever the
CLI changes. Updating only the npm package or only the discovery skill is not
enough.

## Actual Chrome is exceptional

Attaching to a developer's real Chrome requires an explicit request for that
specific task. Permission to watch Chrome for Testing is not permission to use
the real browser, and actual-browser permission is not a standing preference.
Do not install or enable an auto-connect MCP server to make attachment the
default.
