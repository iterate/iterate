# AI cost controls

Company-funded model calls use the deployment's Cloudflare AI Gateway. Budget
rules belong to the Cloudflare account, separate from Worker deployments.
Production and dev/preview already use separate accounts; no extra OpenAI
projects are needed for Iterate project attribution.

## Budgets as code

`apps/os/scripts/ai-gateway-budget-rules.ts` exports `productionRules()` and
`developmentRules()`, typed against the pinned Cloudflare SDK.

| Scope                                        | Production | Dev/preview  |
| -------------------------------------------- | ---------- | ------------ |
| Whole gateway, rolling 24 hours              | $30        | $10 combined |
| Environment + project, rolling 24 hours      | $10        | $10          |
| Environment + project + stream, rolling hour | $3         | $3           |

The windows passed to Cloudflare are **seconds**. The account-wide
`.depot/workflows/ai-gateway-budgets.yml` serializes reconciliation. Normal
Worker deploys never write budgets. The command prints a diff, preserves other
gateway settings, rejects unfamiliar rule IDs, skips unchanged configurations,
and verifies the saved rules by reading them back.

```sh
# Inspect; no writes by default.
pnpm --dir apps/os ai-gateway-budgets --env preview_1
pnpm --dir apps/os ai-gateway-budgets --env prd

# Apply an already-adopted rule set.
pnpm --dir apps/os ai-gateway-budgets --env preview_1 --apply true
```

First adoption requires explicitly listing existing dashboard rule IDs with
`--replace-rule-ids <id>`. Inspect their current values before doing so. At the
2026-09-07 audit, default had `7f9ed078` ($1,500/day) in dev/preview and
`33344dff` ($200/day) in production. Those live settings have not been replaced
by this implementation's tests.

**Changing a rule resets its counter.** In the isolated live test, lowering a
one-hour limit with the same rule ID allowed a new request within 21 seconds
of the original paid request. An identical PUT retained the exhausted state.
Review limit changes as changes to the current remaining allowance too.

Cloudflare prices completed requests and enforces eventually consistent
counters: concurrent or in-flight work can overshoot a configured amount.
Unknown-priced models may not be covered. Keep the OpenAI organization hard
limit ($1,000/month in the approved design) as the provider backstop.
[Cloudflare spend-limit behavior](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)

## Trusted attribution

Every company request carries `environment`, stable `projectId`, and
`projectSlug`. Scoped calls also carry `streamPath`. The host supplies these;
caller gateway IDs and metadata cannot change billing identity. Company OpenAI
chat-completion streams force `stream_options.include_usage: true`, even when
the caller disables it, so the gateway receives usage totals for pricing. Slugs come
from the project directory, cached for at most a minute. Renaming a project
never changes its budget bucket.

`eventOffset` is implemented but disabled by default
(`cloudflareAiGateway.includeEventOffset`). Cloudflare accepts five metadata
entries, and the live test preserved numeric offset zero. Its documentation
has no explicit high-cardinality guarantee, so this field stays off until
that is confirmed. The fifth field is not needed for enforcement.
[Metadata limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)

When enabled, the offset identifies the direct operation: the first LLM
request event, the compaction's usage report, or the direct script-run request.
Automatic retries retain that offset. A new operation or explicit Retry gets
a new one. Calls with no event context omit it. This is attribution, **not a
billing deduplication key**: future customer billing needs a per-attempt ledger
and reconciliation against provider usage.

## Budget and rate-limit outcomes

A confirmed budget block becomes `status: "budget-exhausted"`, separate from
ordinary `status: "rate-limited"`. Cloudflare's recorded code is 2041;
OpenAI's documented organization/project spend-limit codes are also recognized.
An ambiguous quota error is not guessed to be a budget stop.
[OpenAI billing error codes](https://help.openai.com/en/articles/6614457)

An agent settles its open request once and pauses durably. Reloads, eviction,
new messages, and stale Retry clicks cannot restart it. The feed shows
**Budget exhausted** with **Retry**. That command names the exact pause offset.
Rate limits instead use the existing finite retry policy, with Retry-After
bounded to a minute. Neither expected outcome emits a generic stream error.

Compaction records `agent/compaction-stopped` before releasing the triggering
usage report. A budget stop and its pause commit atomically. Redelivery checks
that record before contacting the provider again.

`itx.ai.run<T>()` returns `T | AiCallStop`; callers must handle expected stops
before using their model-specific result. Gateway IDs and billing metadata in
its options are replaced by the host. Cache preferences remain available.

## Credentials and transport coverage

- Agent turns and compaction use company credentials through the gateway.
- Project JSON OpenAI calls opt into company funding with no Authorization or
  `Authorization: Bearer iterate-platform`; never copy the company key into
  sandbox environment variables.
- A current company-key copy in a Secret DO is recognized after substitution
  and routed internally to the same gateway, preserving trusted stream context.
  Resolved material is never passed back to the caller's egress interceptor.
- Other credentials remain customer-funded, going to their pinned provider
  outside company budgets. They are never replaced with the company key.
- Unsupported company transports (including direct Realtime WebSockets and
  multipart uploads) return `company_ai_transport_unsupported`, without a
  direct-provider fallback. Customer transports retain their existing behavior.
- Voice bootstrap now accepts `OPENAI_CUSTOMER_API_KEY`, preventing new company
  key copies. Company-funded Realtime needs a separately validated gateway
  adapter before enabling it.
- Firmware sound generation requires an authenticated company gateway URL and
  attribution instead of calling OpenAI directly.

## Review and rollout

The branch prepares code and rules for review; preview validation does not
rotate production credentials or replace live default-gateway rules.

1. Review the transport changes, especially company-funded voice restrictions.
2. Create a company-owned OpenAI service account in the existing project.
3. Inventory company key copies and direct consumers, then move those callers
   to the supported gateway paths. Clear old stored copies before retiring the
   old key; after rotation an unidentified legacy key must not remain usable.
4. Update the canonical Doppler key (including inherited dev/preview configs),
   deploy atomic secrets, and verify the gateway logs on preview and production.
5. Adopt the reviewed account rules, verify their readback, and confirm the
   OpenAI organization hard limit in the company-owned account.
6. Revoke Rahul's old key only after the covered routes succeed.

## Validation

`intercepted/gateway/*` exercises production request preparation and response
decoding using `ai.intercept` HTTP fixtures. Authorization is stripped before
the handler runs. Real model names cannot use this interceptor.

`specs/agent-budget.spec.ts` exercises the actual feed, reload, another message,
and Retry on preview. Unit coverage includes eviction, stale retries, bounded
rate-limit retries, compaction redelivery, and raw-response streaming deadlines.

The opt-in `AI_COST_LIVE_PROOF=1` e2e test performs tiny gpt-4.1-nano and Workers AI calls
through a company secret and checks customer credentials and fail-closed
transports. The default CI test matrix does not make those paid calls. The proof consumes
the full customer error body and company SSE response, not just their status.
Secret dispatch uses the existing native fetch context carrier: changing that
hop to ordinary RPC disconnected customer response bodies in the live test.
[Cloudflare RPC lifetime](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)

Isolated live gateways verified independent environment/project/stream buckets,
rename resistance, code 2041, five metadata fields, rolling-window recovery,
and counter behavior on updates. Every temporary gateway was deleted afterward.

Final preview proof (2026-09-07, Worker `d650f6a7-b4fb-4317-9882-48a5c35ee702`):
the caller disabled usage reporting, but the full OpenAI stream included totals
and Cloudflare recorded $0.0000174. Customer JSON and Workers AI JSON/SSE also
completed. The bounded all-dataset error query for `os-preview-9` returned no
events. Production adoption and key rotation remain outstanding.
