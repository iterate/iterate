# Project creation traces

Status: complete. Two source files changed; local checks and deployed smoke
passed. Creation spans verified, preview data erased and lease released.

Add native Cloudflare spans around existing project-creation timing steps.
Separate connection/authentication, creation, description and reply timing in
agent smoke. Preserve existing deployment waits, RPC behavior and CI ordering.
No trace-query scripts, new lookup artifacts or readiness wrappers. Work in
`codex/project-creation-traces`; push a compare link without opening a PR.

- [x] Add spans to `timedStep`, retaining its logs, return values and errors.
      *Native `create-timing.*` spans with existing identity fields and outcome.*
- [x] Separate the smoke timings, with the project ID in its existing output.
      *Await authentication before timing create; describe and reply have their own clocks.*
- [x] Check the helper behavior and verify spans on a leased preview.
      *Smoke passed without retry; 18 creation spans found, all with outcome `ok`.*
- [x] Clean up the preview, record proof, commit and push the compare branch.
      *Preview erased and lease released; deliver `main...codex/project-creation-traces`.*

## Implementation log

- Based on `origin/main` at `4a364c3b6b8204d439208fda3203ae132e5e5672`.
- The historical `stubstub` review is separate research, not part of this diff.
- Full `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and
  `git diff --check` passed. Two helper tests cover span lifetime, project
  identity, returned values and propagation of the original failure. The
  first test failed against the original helper before implementation.
- Preview lease: `preview-2`, `2b9cbaf7-7aa0-408c-a4cb-e8e8c6378287`.
  OS version `9ecb21ca-11d2-4f31-8787-2dde7c4d3784`; Auth version
  `510b4798-467d-4e73-9cc3-fbe0168d05ef`. Unchanged SDK packages use the base
  SHA; the OS deployment was built from this worktree's tracing changes.
- Smoke kept the existing deployment-age gate and passed on its first attempt.
  Authentication: 1,137ms; project creation: 9,155ms; description: 96ms;
  agent creation: 4,271ms; reply: 8,260ms. The created project was
  `prj_b7bf158f13784bdca25fee0d948bdcfb`.
- Found 18 creation spans across three traces. For example, root append took
  1,444ms and waiting for project-created took 7,280ms; artifact get/create and
  seeding took 1,412ms and 1,588ms. Concurrent spans must not be summed.
  [Creation trace](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/2a5cd1630392be36be538b4f1f27ef42),
  [artifact seed](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/1699de8ecd38ca6ce2ea1b4900618527).
- The long WebSocket trace records `Network connection lost` 17ms after smoke
  finishes, at client shutdown. Creation spans report success; both background
  artifact traces contain no error events. The foreground creation window had
  1,798 trace/log events and no errors. Local raw evidence is in
  `validation.ignoreme/` and `/tmp/iterate-small-traces-*.log`.
- Cleanup retired the OS objects, cleared D1 and two KV keys, and deleted 628
  Artifacts repos within the existing GC budget. Remaining inert repos are
  left for subsequent GC; the preview lease was released successfully.
