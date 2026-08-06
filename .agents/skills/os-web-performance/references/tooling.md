# Performance tooling policy

Prefer the repository's existing Playwright fixtures, `Playwriter`, PostHog
CLI, build output, and Cloudflare trace skills. They cover the full field → lab
→ source → preview loop without another dependency.

## Vetted upstream options

- For TanStack Start and Router, use TanStack's own skills and versioned docs
  first. The exact sources and OS-specific warnings are indexed in
  [tanstack-start.md](tanstack-start.md).
- Cloudflare's official `web-perf` skill and Chrome DevTools MCP provide a solid
  trace-led workflow: <https://github.com/cloudflare/skills> and
  <https://github.com/ChromeDevTools/chrome-devtools-mcp>.
- Vercel's React Best Practices skill is useful for framework-neutral rules on
  waterfalls, dynamic imports, and rerenders:
  <https://github.com/vercel-labs/agent-skills>.
- React Doctor offers a deterministic performance diff scan suitable for CI:
  `react-doctor --category performance --diff --json --no-telemetry`.
- Lighthouse CI supports repeat runs and resource budgets:
  <https://github.com/GoogleChrome/lighthouse-ci>.

Popularity is discovery evidence, not trust. Before adopting one:

1. inspect the source repository and maintainer rather than copied marketplace
   text;
2. pin a reviewed commit or release and record its permissions/network access;
3. run it in an isolated browser/session with least privilege and no production
   secrets;
4. keep raw trace artifacts out of git unless intentionally sanitized;
5. require the tool to complement—not replace—field p75s, Playwright behavior,
   and preview telemetry.

Do not add a scanner or CI gate merely to produce a score. Add it only with a
specific regression class, deterministic command, maintained threshold, and an
owner for failures.
