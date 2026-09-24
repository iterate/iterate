# Performance tooling policy

The repository already covers the loop from field data to lab to source to preview: Playwriter
or Playwright in an isolated session, `pnpm spec`, the PostHog CLI, `vite build --manifest`,
Workers Logs, and the per-PR preview. Add a tool only when it covers a specific gap.

Vetted upstream options:

- TanStack's own skills and versioned docs ([tanstack-start.md](tanstack-start.md)).
- Cloudflare's [`web-perf` skill](https://github.com/cloudflare/skills) and the
  [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), for work led by
  traces.
- Vercel's [React best practices](https://github.com/vercel-labs/agent-skills), for waterfalls,
  dynamic imports and rerenders.
- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci), for repeated runs and
  resource budgets.

Before adopting any of them:

1. Read the source and the maintainer, not a marketplace copy.
2. Pin a reviewed release, and record its permissions and network access.
3. Run it in an isolated browser with no production secrets.
4. Keep raw traces out of git unless they are sanitized.

Never add a scanner or CI gate just to produce a score. A gate needs a regression class, a
deterministic command, a maintained threshold, and an owner for its failures.
