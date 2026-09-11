# AI Gateway metadata and emergency limits

Company-funded agent calls, direct `itx.ai.run`, and supported OpenAI JSON egress
go through the host-selected Cloudflare AI Gateway. Host-owned metadata identifies
the environment, project ID, stream path and optional event offset. Project identity
comes from local host data; attribution does not read the project directory.
For agents, the offset identifies the individual LLM request; for compaction it
identifies the triggering usage report. Script calls use the script-request offset.
Caller-supplied gateway IDs and metadata cannot replace this host-owned metadata.

Existing OpenAI egress behavior is unchanged: supported JSON calls without an
explicit project-secret reference use the platform key, even if an Authorization
header supplies another key. Explicit project secrets keep their existing Secret DO
path. Unsupported requests fall through to normal egress. Correcting credential
ownership is separate work; this does not add voice/audio support.

The request preparation and dispatch contract is described in
[intercepted models](intercepted-models.md). Interception replaces the final provider
call and follows the same response decoding.

## Refusals

There is no budget-specific event, paused state, UI, or response type.
HTTP 429 follows ordinary failure handling:

- Agent requests use the existing bounded retry policy: three total attempts by
  default, then wait for fresh input.
- Compaction logs the failure; later qualifying usage can attempt compaction again.
- Direct AI calls throw on unsuccessful responses, or return the response when
  `returnRawResponse` is requested. Egress returns the HTTP response.
- Callers of direct AI/egress control their own retries.

No cost ledger, cost-log ingestion, or cross-service budgeting is included.

## Gateway rules

The account-level rules live in
`apps/os/scripts/ai-gateway-budgets.ts`. Proposed limits are $30/day globally
in production ($10/day in the development account), $10/day per environment/project,
and $3/hour per environment/project/stream. These are rolling Gateway windows;
they are separate from any future Iterate budget model.

Preview deployments share the development account. The existing Auth + OS
production workflow reconciles both accounts after a successful deployment on a
push to main. Preview branches and manually dispatched deployments do not write
these shared rules.

Account names come from `cloudflareAccounts` in `envs.ts`:

| Account       | Cloudflare account ID              | Doppler credentials |
| ------------- | ---------------------------------- | ------------------- |
| `prd`         | `04b3b57291ef2626c6a8daa9d47065a7` | `_shared/prd`       |
| `dev/preview` | `376ef7ed81b0573f93524de763666c15` | `_shared/preview`   |

The resolver checks that Doppler's account ID matches this map. No preview slot
is selected or deployed by this command.

Inspect the proposed change before applying it:

```sh
pnpm --dir apps/os ai-gateway-budgets --account prd --apply false
```

Use `--apply true` to write the reviewed configuration. Unknown existing rule IDs
must be explicitly adopted through `replaceRuleIds`; no-op runs avoid resetting
spending counters. Use the CLI for a deliberate manual reconciliation.

This reduced implementation has not been deployed or applied to either account.
A preview proof of routing, attribution, response streaming and refusals remains
necessary before production rollout.
