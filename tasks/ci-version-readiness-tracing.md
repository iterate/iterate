# Version-aware preview readiness and project creation traces

Status: specification agreed; implementation starting. This follows the shared
Playwright/Vitest setup change in #2653.

## Request

Replace OS's fixed deployment-age wait with evidence that the code handling
work is the expected deployment. Make the time spent creating a project
visible in traces and CI. Work in a new worktree, commit and push, but **do not
open a pull request**; return a GitHub compare link.

## Scope and acceptance

- [ ] Check the actual Durable Object's version before running requested work.
      A representative object cannot establish readiness for the whole fleet.
      Include objects first reached later, during project creation or tests.
- [ ] Bound version waits, report object/expected/actual versions and elapsed
      time, and propagate unrelated failures. Never replay a mutation merely
      because it threw or its connection reset.
- [ ] Remove OS's 90-second deployment-age wait once the replacement is proven.
      Let agent smoke, Vitest and Playwright run independently after their own
      prerequisites; all remain required. Keep Chromium installation concurrent.
- [ ] Turn existing project-creation timing steps into native Cloudflare spans,
      with project identity usable across background stream processing.
- [ ] Separate smoke-client connection, creation, description and agent timings;
      emit enough identity and timing information to find the deployed traces.
- [ ] Test version transitions and failures through real runtime behavior, and
      test CI ordering with controlled commands. Keep existing timeout budgets.
- [ ] Deploy to a separately leased preview, exercise creation and both suites,
      inspect version/trace/state evidence, and clean up and release the lease.
- [ ] Record validation and limits, finish the task file, commit and push the
      branch, and send the compare link without opening a PR.

## Design constraints

Edge `/api/health` already checks the deployed Worker version. It does not prove
that every Durable Object has updated. The new check must run before the
operation on the receiving object, not merely before making a later call.
Readiness describes a particular operation and version; it is not a promise
that an object can never reset afterwards.

Use existing project IDs and creation-event offsets to correlate background
steps. Preserve the difference between elapsed critical-path time and the sum
of concurrent spans. Do not claim missing trace context is propagated unless
the deployed trace proves it.

## Implementation log

- Started from `origin/main` at `4a364c3b6b8204d439208fda3203ae132e5e5672`.
  Branch: `codex/ci-version-readiness-tracing`.
