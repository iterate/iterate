---
name: debug-os-worker
description: Debug OS production and preview failures with Cloudflare traces plus operation-wide logs. Use when diagnosing ITX calls, agent conversations, scheduler alarms, dynamic workers, Durable Objects, or a reported OS correlation ID.
---

# Debug OS Worker

Read [../cloudflare-traces/SKILL.md](../cloudflare-traces/SKILL.md) first. Use
the general Cloudflare API MCP server and its Workers Observability endpoints.

## Scope

- Production service: `os-prd`; derive account IDs and preview service names
  from `envs.ts` rather than guessing.
- Current trace/custom-span dataset: `otel`.
- Current wide-log/invocation dataset: `cloudflare-workers`.
- Wide-log schema: `iterate.wide-log.v1`.

## Fast path

1. Capture UTC time, environment, operation, and any `log_`, trace, session,
   request, execution, or Ray ID from the report.
2. Search `datasets: []` for a known ID. For a Cap'n Web `itxCallId`, normally
   expect one `cloudflare-workers` log and one `otel` span; retention, quota,
   or invocation log truncation can remove one side.
3. Query the exact `traceId` in `otel` and the exact `log.id` in
   `cloudflare-workers`.
4. Walk `log.parentId` to the WebSocket handshake operation. Search
   `itx.sessionId` to reconstruct other calls on the same connection.
5. Give a trace deep link and name the next source path to inspect.

## ITX and agents

- Semantic spans are named `itx <Target>.<method>`; use `rpc.method`,
  `itx.call.id`, `itx.session.id`, `itx.transport`, and `itx.outcome`.
- Logs use stable message `itx_rpc` with `itx.method`, `itx.callId`, and the
  same session ID.
- For a real agent turn, find `itx Agent.ask`, then inspect descendant
  `dynamic_worker.project_config.call` and native DO/RPC spans.
- Do not expect prompts, scripts, arguments, results, raw errors, or trusted
  project identity in telemetry; the privacy contract intentionally omits them.

Observed on 2026-07-13, Cloudflare rendered a failing custom span's metadata
message with an `OK` suffix. Treat the suffix as presentation metadata;
`source.itx.outcome` is the semantic result and the correlated error-level wide
log corroborates it.

## Scheduler and alarms

- Search `iterate.scheduler.execution_id` or `scheduler action invocation`.
- The action invocation span's contract is the dynamic call itself: expect it
  to contain `dynamic_worker.scheduler_action.call` and inspect
  `iterate.scheduler.action_outcome`.
- A cold-alarm proof must: set a one-shot schedule, explicitly kill the
  Scheduler DO before due time, observe the durable result after due time, and
  validate the resulting trace tree.
- OpenTelemetry permits a child to outlive its parent. Reject a timing tree only
  when it violates the named span's intended scope or known code ordering.

## Error triage

- Filter `cloudflare-workers` on `$metadata.level == "error"`, then group by
  stable `message`; do not group by user-controlled text.
- An invoked Cap'n Web ITX target failure is normalized to a caller-visible
  Error with an authoritative `itxCallId`; use it as the direct lookup key.
  Dispatch/protocol failures before the target hook may not have one.
- Do not expect arbitrary Error properties to survive native Workers RPC or
  Durable Object RPC; [that transport preserves a different error shape](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/).
- Check `$workers.truncated`; a truncated long-lived WebSocket invocation is
  incomplete evidence.

## Report

Return the user-visible symptom, product outcome, trace deep link, script
version, semantic chain and timings, log correlation, span-contract audit,
privacy limitations, root cause, and a proved remediation or next experiment.
