# Project creation traces

Status: starting a small extraction from the earlier readiness/tracing branch.

Add native Cloudflare spans around existing project-creation timing steps.
Separate connection/authentication, creation, description and reply timing in
agent smoke. Preserve existing deployment waits, RPC behavior and CI ordering.
No trace-query scripts, new lookup artifacts or readiness wrappers. Work in
`codex/project-creation-traces`; push a compare link without opening a PR.

- [ ] Add spans to `timedStep`, retaining its logs, return values and errors.
- [ ] Separate the smoke timings, with the project ID in its existing output.
- [ ] Check the helper behavior and verify spans on a leased preview.
- [ ] Clean up the preview, record proof, commit and push the compare branch.

## Implementation log

- Based on `origin/main` at `4a364c3b6b8204d439208fda3203ae132e5e5672`.
- The historical `stubstub` review is separate research, not part of this diff.
