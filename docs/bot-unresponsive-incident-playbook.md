# Bot Unresponsive Incident Playbook

Use this when users report "bot is unresponsive" in production.

## Scope

- Slack-triggered bot flows
- Machines running on Daytona sandboxes
- Hop sequence: Slack -> OS backend -> machine daemon -> OpenCode -> Slack reply

## Required inputs

- Slack `event_id` (from webhook payload if available)
- Approx timestamp
- Project + machine (if known)

## 5-minute triage

1. **OS backend received webhook?**
   - Check Cloudflare logs for `[Slack Webhook] Received` in `apps/os/backend/integrations/slack/slack.ts`.
   - If missing: Slack delivery/signature/config issue, not sandbox.

2. **Forward to machine succeeded?**
   - Look for `[Slack Webhook] Forwarded to machine` vs `Forward failed` / `Forward error`.
   - `HTTP 400` from Daytona often means sandbox not started.
   - `HTTP 401` means auth/preview token issues.

3. **Sandbox healthy?**
   - In Daytona dashboard, check sandbox state + error reason.
   - In sandbox terminal:
     - `pidnap status`
     - `curl -s http://localhost:3000/api/health`
     - `tail -n 200 /var/log/pidnap/process/daemon-backend.log`
     - `tail -n 200 /var/log/pidnap/process/opencode.log`

4. **Daemon accepted event?**
   - Check daemon logs in `apps/daemon/server/routers/slack.ts` for same `requestId`.
   - Check daemon SQLite event row (`externalId == Slack event_id`).
   - If OS sees event but daemon does not: forwarding/proxy path issue.

5. **Agent processed turn + replied?**
   - Check daemon/opencode logs for session create/prompt failures.
   - Check Slack API send failures (`chat.postMessage` path).

## Correlation IDs (implemented)

OS backend now creates/propagates correlation metadata per webhook:

- `x-iterate-request-id`
- `traceparent` (uses incoming if valid, otherwise generated)
- `x-slack-event-id`

Forwarding path:

- OS backend injects headers in `forwardSlackWebhookToMachine`.
- Daemon reads/logs those headers in `/api/integrations/slack/webhook`.
- Response payloads include `requestId` for quick operator debugging.

## Observability endpoints

- Daemon: `GET /api/observability` (via machine port `3000` proxy)
- OS backend: `GET /api/observability`
- Includes whether OTEL export is configured and trace viewer info.

## Trace viewer (in sandbox)

- Viewer: Jaeger all-in-one (OSS)
- UI port: `16686`
- OTLP ingest: `4318` (HTTP), `4317` (gRPC)
- Default trace export endpoint: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces`

## Common root causes

- Daytona sandbox auto-stopped before webhook arrived.
- Daemon unhealthy/restarting in sandbox.
- OpenCode session create/prompt timing out.
- Slack token/env drift inside sandbox.

## OTEL rollout plan

### Phase 1 (done now)

- Correlation IDs across OS backend -> daemon hops.
- Structured logs include request id + traceparent.

### Phase 2 (next)

- Add OTEL spans in:
  - OS webhook handler (verify, dedup, machine lookup, forward, persist)
  - Daemon webhook handler (parse, store, route, append)
  - OpenCode harness (`createAgent`, `append`, readiness wait)
  - Slack send path (`chat.postMessage`)
- Propagate trace context through all outbound HTTP calls.

### Phase 3 (SLO + alerts)

- Metrics:
  - `webhook_to_daemon_accept_ms`
  - `daemon_accept_to_prompt_ms`
  - `prompt_to_first_reply_ms`
  - failure counts by stage (`forward_failed`, `opencode_not_ready`, `slack_send_failed`)
- Alert on elevated p95 latency + error rate by stage.

## References

- `apps/os/backend/integrations/slack/slack.ts`
- `apps/daemon/server/routers/slack.ts`
- `apps/daemon/server/agents/opencode.ts`
- `apps/os/backend/providers/daytona.ts`
