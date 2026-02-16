# High level goal

To have a self-improving system, that proactively and reactively responds to issues.

It should be able to suggest improvements, fix errors, improve performance etc. autonomously with little-to-no human input. This should include improvements to itself.

# Logging

Every log should use https://www.evlog.dev/

This means: each request should emit ONE log line with exactly the information needed.

Lines should include at least, fine & coarse timings, any errors or warnings, and if http, the status, method and path.

We should avoid doing the spread operator when doing logs so we don't accidentally log too much (secrets, confidential info etc.).

To start with, we will NOT perform sampling, but in future it should be possible to do tail sampling. E.G only log X% of 2XX requests.

# Context

To do their jobs, agents need information. The more the better.

- Access to cloudflare logs (Cloudflare Observability MCP)
- Access to posthog (PostHog MCP)
- Access to recent git commits & PRs
- Optional, but recommended - being able to access vendor specific stuff like VictoriaMetrics on Fly
- Optional, allow them to shell into sandboxes and run commands
- Optional - access to some underlying roadmap or design direction - but this should be in git
- Anything else (e.g. access to a gmail mailbox for support + slack threads)

In order for this to be useful, the agent needs to ensure that:

1. Logs are not too noisy - ideally ~0 false positive errors - that is, every error in the logs is a real system error - we have a bug. We also do not want to gum up context - signal to noise should be high.
2. Logs contain the information needed.

# The Architect Agent

The architect is a proactive, long-running coding agent. It is an OpenCode subagent defined in `.opencode/agents/architect.md`. It can be invoked via `@architect` in an OpenCode session, or dispatched automatically by the build agent.

Its job is to ensure the long-term health of the codebase. It should be methodical and correct. It is okay if it is slow. It should put more focus on more recent changes but consider the whole codebase.

Its first priority is always observability — making sure logs exist, follow evlog, and contain enough information to diagnose problems. You cannot fix what you cannot see.

After that, it finds and fixes errors, flaky tests, performance regressions, dead code, and duplication.

The artefact created by a completed run is a pull request (if anything needs changing). Commits and PR descriptions should be descriptive — they are the decision log.

### Criteria

It should ask itself:

- Do I have enough information to validate this problem? If not, step #1 is to add that information to the logs / metrics.
- How confident am I that this solves the problem? Have I added a test to confirm that it works? If I remove the code I added, does that test fail?
- Is this the smallest change that can solve this problem? Can I break this up into a series of smaller sub-problems / PRs?

# Rollback tool

We might need a tool that does a rollback without needing to go via PR - this can go via github actions manual dispatch easily.
If this happens, the agent should open a PR later to allow it to be audited.
