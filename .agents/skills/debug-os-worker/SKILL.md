---
name: debug-os-worker
description: Diagnose an apps/os failure on production or a PR preview from Workers Logs and the context's own durable log. Use when prd pages #error-pulse, a preview misbehaves, a request 5xxs, or someone asks "what happened on os at <time>".
---

# Debug the OS worker

The platform (`apps/os`) is one Worker. Its evidence comes from two places:

- **Workers Logs**: every invocation and every structured `console.*` line.
- **The context's durable log**: what actually happened to a project's state.

Read both. A log line explains a symptom, and the durable log shows whether the product
outcome held.

## Names come from `envs.ts`

Never type a worker or account name from memory, because workers get renamed. Print them:

```sh
pnpm exec tsx -e 'import("./envs.ts").then((m) => console.log(m.osEnvs.prd.workerName, m.PRD_ACCOUNT_ID, m.osEnvs.preview.workerName, m.PREVIEW_AND_DEV_ACCOUNT_ID))'
```

| Target    | `$metadata.service` in Workers Logs                                               | Credentials (`doppler run --project os --config …`) |
| --------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| prd       | `osEnvs.prd.workerName`                                                           | `prd`                                               |
| a preview | `osEnvs.preview.workerName`, plus `$workers.preview.slug` = `pr<n>-<branch slug>` | `preview`                                           |

A preview's name is `resolvePreviewName` in `apps/os/scripts/preview-config.ts`. The PR body
shows it. Hosted apps log under their own workers (`<app>Envs.*.workerName`).

Under those Doppler configs, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` read Workers
Logs. The dashboard is `https://dash.cloudflare.com/<account id>/workers-and-pages/observability`.

## Fast path: replay the fault alarm

`scripts/ci/prd-fault-alarm.ts` is the triage query for prd, and it pages #error-pulse every
15 minutes. Replay any half hour without posting:

```sh
doppler run --project os --config prd -- \
  pnpm tsx scripts/ci/prd-fault-alarm.ts run --dry-run --at 2026-09-23T07:30:00Z
```

It prints three grouped counts for the window, and each one is the next thing to open:

- **5xx responses**, by URL.
- **Platform-failure heals**: `console.warn({ event: "<area>.platform-failure-<action>" })`,
  grouped by `name`.
- **Errors**, by message. Expected outcomes are filtered out: `itx.abort()` resets, deploy
  resets, and workerd's unread-body line except on `/api`.

Its `readWindow` holds the exact filters. Copy them rather than rewriting them, so that your
drill-down excludes the same expected noise.

When the post-deploy check pages (`scripts/ci/prd-post-deploy-check.ts`, project hosts down right
after a deploy), its last line is the down hosts' most frequent failure in Workers Logs and whether
it began before the new version's upload; before the upload means the deploy only landed in it.
`readFailureCause` holds that query. A project host whose control-plane read failed logs
`control-plane.platform-failure-stale-project` (served from the data center's last-known copy) or
`control-plane.platform-failure-unavailable` (answered 503). Whether the copies are written at all:
each isolate logs `control-plane.last-known-copy` once, `readBack` true when its first copy read
back; a cache that failed logs `control-plane.last-known-copy-unwritten` or `-unread`.

## Drill down

Query `POST /accounts/<account>/workers/observability/telemetry/query` on the `cloudflare-workers`
dataset. OS emits no custom spans; the logs are the evidence.

```sh
now=$(date +%s000)
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d '{
    "queryId": "debug-os-worker", "view": "events", "limit": 50,
    "timeframe": { "from": '$((now - 3600000))', "to": '$now' },
    "parameters": { "datasets": ["cloudflare-workers"], "filters": [
      { "key": "$metadata.service", "operation": "eq", "type": "string", "value": "<worker>" },
      { "key": "$metadata.level", "operation": "eq", "type": "string", "value": "error" }
    ] }
  }' | jq '[.result.events.events[] | {t: .timestamp, message: ."$metadata".message, url: ."$workers".event.request.url,
          entrypoint: ."$workers".entrypoint, outcome: ."$workers".outcome, version: ."$workers".scriptVersion.id, source}]'
```

Run it under `doppler run --project os --config <prd|preview> -- bash -c '…'`.
Useful variations:

- **View**: `view: "calculations"` with `calculations: [{ operator: "count" }]` and
  `groupBys: [{ type: "string", value: "<key>" }]` gives counts. Group by `$metadata.message`,
  `$workers.event.request.url`, `event`, `name` or `$workers.preview.slug`.
- **Filter keys**: `$metadata.level`, `$metadata.message`, `$workers.event.response.status`
  (a number), `$workers.entrypoint` (`IterateContextDurableObject`, `ItxEntrypoint`, …),
  `$workers.eventType` (`fetch`, `alarm`, `jsrpc`), `$workers.durableObjectId`,
  `$workers.scriptVersion.id`, and a structured line's own top-level fields (`event`, `name`).
- **One project or context**: a context's Durable Object name is `<projectId>.iterate<path>`
  (`DurableObjectNameCodec`, `apps/os/src/context/paths.ts`), and context-level lines log it as
  `name`. Filter `{ "key": "name", "operation": "includes", "value": "prj_….iterate/agents/" }`.
- **Operators**: `eq`, `includes`, `not_includes`, `gte`, `regex`, `exists`. Start with a narrow
  time window and widen it before you add filters.

Check `$workers.truncated`. A long-lived WebSocket invocation can be cut short, and then its
lines are incomplete evidence.

## The durable side

- **Credentials**: a personal access token for the project, as `ITERATE_BEARER_TOKEN`. Ask the
  person for one, or mint your own if you are signed in
  (`pnpm exec iterate --config prd tokens create --name debugging --project <slug>`;
  [credentials](../../../apps/os/docs/credentials.md)). It covers only projects its person
  belongs to. For anyone else's project use the operator bearer on `/api` instead:
  `APP_CONFIG_ADMIN_API_SECRET` (the deployment's `secrets.adminBearer`) in place of
  `ITERATE_BEARER_TOKEN` below.
- **A context's log and processor rows**: `apps/os/scripts/inspect-context.ts`, with
  `WORKER_BASE_URL`, `ITERATE_BEARER_TOKEN`, `PROJECT` and `CTX_PATH`. The fix-stream skill
  shows the full-JSON dump.
- **Anything else a script can read**: run it at the project root with
  `ITERATE_BEARER_TOKEN=… pnpm exec iterate --config prd itx run --project <slug> --eval '…'`.
  The run is recorded on the project's root log under the key's person, and reading an idle
  context wakes it.
- **Local dev**: `pnpm dev` prints a Local Explorer. Its
  `POST /cdn-cgi/local/explorer/api/local/observability/query` runs SQL over the captured `logs`
  and `spans` tables. Use it to reproduce a line before you hunt for it on prd.

## Report

Include the symptom a person saw and whether the durable outcome held, the UTC window, the
worker and script version, the exact query behind each claim and its counts, the chain from
log lines to source files, the root cause, and a remediation you have proved or the next
experiment to run.
