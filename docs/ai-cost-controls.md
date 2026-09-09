# AI Gateway metadata and emergency limits

Company-funded agent calls, direct `itx.ai.run`, and supported OpenAI JSON egress
go through the host-selected Cloudflare AI Gateway. Host-owned metadata identifies
the environment, project ID, project slug, stream path and optional event offset.
For agents, the offset identifies the individual LLM request; for compaction it
identifies the triggering usage report. Script calls use the script-request offset.
Caller-supplied gateway IDs and metadata cannot replace this host-owned metadata.

OpenAI customer credentials retain their own billing. Company credentials
(including copies stored as project secrets) use the Gateway; unsupported company
transports fail closed. This does not add voice/audio support.

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

Preview deployments share the development account. A separate workflow owns rule
reconciliation rather than each Worker deployment writing account-level settings.

Inspect the proposed change before applying it:

```sh
pnpm --dir apps/os ai-gateway-budgets --env prd --apply false
```

Use `--apply true` to write the reviewed configuration. Unknown existing rule IDs
must be explicitly adopted through `replaceRuleIds`; no-op runs avoid resetting
spending counters. The workflow reconciles both accounts when rule files change
on main or when manually dispatched.

This reduced implementation has not been deployed or applied to either account.
A preview proof of routing, attribution, response streaming and refusals remains
necessary before production rollout.
