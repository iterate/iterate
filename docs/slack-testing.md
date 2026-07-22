# Slack testing

Use this when testing real Slack flows against OS local dev, preview, or
production environments.

**Agents: start here if you need to post a Slack message that wakes `iterate`
(or a preview bot).** The short path is:

1. Trigger actor token: Doppler **`SLACK_CI_BOT_TOKEN`** (not the product bot).
2. Product bot **must be in the channel** (join via project `itx.integrations.slack`).
3. Post into **`#slack-agent-e2e-test`** (`C096Q1M4Y86`) with ambient vs `@mention`.

Details below under [Trigger actor for smoke tests](#trigger-actor-for-smoke-tests)
and [Production mention-gate smoke](#production-mention-gate-smoke).

## Start here

- **Scripted production / preview smokes (this page):** CI actor token, channel
  membership, ambient vs mention checks
- Preview Slack app creation and manifest:
  [apps/os/docs/slack-preview-app-manifest.md](../apps/os/docs/slack-preview-app-manifest.md)
- Bulk-create remaining preview Slack OAuth clients:
  [slack-preview-oauth-clients.md](slack-preview-oauth-clients.md) for the
  API-first bulk workflow
- Slack bot token migration and portal links:
  [slack-bot-token-migration.md](slack-bot-token-migration.md)
- Public local URLs for Slack callbacks:
  [dev-environments.md#tunnels-and-webhooks](dev-environments.md#tunnels-and-webhooks)
- Older manual production smoke notes (pre-itx-v4; historical only):
  [slack-smoke-testing.md](slack-smoke-testing.md)
- Code that loads the CI actor token:
  [`scripts/ci/slack.ts`](../scripts/ci/slack.ts) (`getSlackBotToken()`)

## Environment model

Every public OS environment needs its own Slack app and callback URLs.

| OS environment | Slack app                             | Request URL                                                         |
| -------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `prd`          | `iterate`                             | `https://os.iterate.com/api/integrations/slack/webhook`             |
| `preview_N`    | `iterate-preview-N`                   | `https://os.iterate-preview-N.com/api/integrations/slack/webhook`   |
| local dev      | personal/dev Slack app or preview app | `https://<name>.tunnels.iterate.com/api/integrations/slack/webhook` |

The Doppler secrets are split by purpose:

- `APP_CONFIG_INTEGRATIONS__SLACK` contains the Slack app credentials for the
  OS deployment: OAuth client ID, OAuth client secret, and webhook signing
  secret. It may also contain `botToken`, an optional app-level outbound
  fallback for that same Slack app. Presence in Doppler is not proof that the
  token is live.
- The OS **Connect Slack** flow stores the workspace bot token for a project at
  `/secrets/integrations/slack/<connection>/bot-token` and claims the Slack
  team in the deployment's `/integrations/_directory` stream.
- Slack Web API calls use the connected project's workspace token first. If
  Slack rejects that token, OS uses `auth.test` to prove that
  `APP_CONFIG_INTEGRATIONS__SLACK.botToken` belongs to the connection's
  journaled team before retrying. A typo'd or disconnected connection never
  gets the fallback. The fallback is not a substitute for **Connect Slack** and
  must never be used to reconstruct a project's connection.

## Trigger actor for smoke tests

Use a real human Slack message for the cleanest end-to-end smoke test. If a
script needs to create the inbound Slack message, use a second actor token that
is not the Slack bot under test.

For example, when testing `iterate-preview-2`, the bot under test replies with
the connected project token or the `preview_2` fallback token from
`APP_CONFIG_INTEGRATIONS__SLACK.botToken`. The inbound trigger should be a
human user, a separate test bot, or a synthetic signed webhook whose Slack
identity is not `iterate-preview-2`.

Do not use the same app's Bot User OAuth Token to pretend to be the user that
wakes that same app. That creates self-wake ambiguity and can be ignored by the
processor.

### `SLACK_CI_BOT_TOKEN` — the scripted trigger actor

Doppler has a second bot used only as a **message sender** for automated
smokes (CI notifications and agent smoke posts). It is **not** the product bot:

|          | Product bot under test                                                                                                                           | Trigger actor                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Identity | production `iterate`, or `iterate-preview-N`                                                                                                     | `Niterate` / `iterate_ci_preview_bo`                                 |
| Doppler  | project secret `/secrets/integrations/slack/<connection>/bot-token` (Connect Slack); optional fallback `APP_CONFIG_INTEGRATIONS__SLACK.botToken` | **`SLACK_CI_BOT_TOKEN`** in `_shared/prd`                            |
| Used for | receiving events, 👀, replies                                                                                                                    | `chat.postMessage` only                                              |
| Code     | outbound Web API via OS / `itx.integrations.slack`                                                                                               | [`scripts/ci/slack.ts`](../scripts/ci/slack.ts) `getSlackBotToken()` |

```bash
# Confirm the canonical CI actor exists without printing it.
doppler secrets get SLACK_CI_BOT_TOKEN --project _shared --config prd --plain >/dev/null
```

`scripts/ci/slack.ts` uses an explicitly injected `SLACK_CI_BOT_TOKEN`, or uses
`DOPPLER_TOKEN` to read this canonical secret. Preview configs do not need a
copy. Prove the selected trigger token with `auth.test` before posting. Check
for a missing environment variable before constructing the Authorization
header: `Bearer undefined` also returns `invalid_auth`, but says nothing about
the stored token.

### Channel membership (common failure mode)

**The product bot must be a member of the channel** or Slack will not deliver
`message.channels` events to it. A bare @mention does nothing useful if the app
is not in the channel — you will see silence and wrongly conclude the agent is
broken.

| Channel                 | ID            | Purpose                      |
| ----------------------- | ------------- | ---------------------------- |
| `#slack-agent-e2e-test` | `C096Q1M4Y86` | Production / agent e2e smoke |

If `@iterate` is missing, **do not** expect the CI actor to invite it
(`conversations.invite` usually fails with `missing_scope`). Join with the
**project's Slack connection** after **Connect Slack**:

```bash
# from apps/os
# 1) resolve the production "iterate" project id (do not hard-code)
doppler run --config prd -- pnpm cli itx run -e '
  const rows = await itx.projects.list();
  return rows.filter((p) => p.slug === "iterate").map((p) => ({ id: p.id, slug: p.slug }));
'

# 2) join the e2e channel as that install
doppler run --config prd -- pnpm cli itx run \
  --context <projectId-from-above> \
  -e 'return await itx.integrations.slack.get().conversations.join({ channel: "C096Q1M4Y86" })'
```

`APP_CONFIG_INTEGRATIONS__SLACK.botToken` is only an optional outbound fallback
for the deployment's Slack app and may be `invalid_auth`. Prefer the project
secret behind `itx.integrations.slack.get()` for join / real outbound API calls.

### Production mention-gate smoke

After membership is fixed, post as the CI actor. Expected behaviour of the
current **slack-agent** mention gate:

| Message                                              | Expected                                        |
| ---------------------------------------------------- | ----------------------------------------------- |
| Ambient channel text (no `@bot`)                     | No LLM wake; no product-bot reply               |
| `<@iterateUserId> …` or Slack `app_mention`          | Product bot wakes and can reply (👀 may appear) |
| Follow-up in a thread already activated by a mention | Still wakes (no re-mention required)            |
| `!debug` / bang-commands                             | Still run without a mention                     |

Slack's `assistant.threads.setTitle` and `assistant.threads.setStatus` methods
belong only to the app's Assistant direct-message surface. The routed webhook's
`event.channel_type` is the authority: `im` (normally a `D…` conversation) may
use Assistant thread UI; ordinary `channel`/`group`/`mpim` threads must not.
Channel mentions still use the 👀 acknowledgement and normal `chat.postMessage`
reply. Removing an already-absent 👀 returns Slack's `no_reaction`, which is an
idempotent success and must not appear in error telemetry. In production traces
for a `C…` or `G…` channel thread, any `assistant.threads.*` call is a defect.

```bash
doppler run --project _shared --config prd -- python3 - <<'PY'
import json, os, urllib.request
token, ch = os.environ.get("SLACK_CI_BOT_TOKEN"), "C096Q1M4Y86"
if not token:
    raise RuntimeError("SLACK_CI_BOT_TOKEN is missing from _shared/prd")

# production iterate user id in the Iterate workspace (confirm via users.list)
iterate_uid = "U08NQR1GCRE"

def slack(method, payload):
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req).read())

auth = slack("auth.test", {})
if not auth.get("ok"):
    raise RuntimeError(f"canonical Slack CI actor failed auth.test: {auth.get('error')}")

print(slack("chat.postMessage", {"channel": ch, "text": "ambient smoke — should not wake"}))
print(slack("chat.postMessage", {"channel": ch, "text": f"<@{iterate_uid}> mention smoke — should reply"}))
PY
```

Archive links look like
`https://iterate-com.slack.com/archives/C096Q1M4Y86/p<ts-without-dot>`.

To confirm membership / reactions from the CI actor:

```bash
# auth.test who the CI token is
# conversations.members?channel=C096Q1M4Y86  → product bot user id must be listed
# reactions.get / conversations.replies on the message ts
```

### Post-recreation proof

Recreate the association with the normal **Connect Slack** OAuth flow. Never
hand-create the connection secret or append `slack/connected` / directory-claim
events: OAuth completion validates and stores the fresh workspace token, creates
the router and subscription, records the lifecycle fact, and claims webhook
ingress as one owning operation.

Do not use `APP_CONFIG_INTEGRATIONS__SLACK.botToken` as restoration material.
Before sending any smoke message, prove the project token and directory claim
with the recreation verifier (run without `--context` so it can read the global
directory):

```bash
# from apps/os
doppler run --config prd -- pnpm cli itx run \
  --file ../../.agents/skills/recreate-production/scripts/verify-slack-connection.itx.js \
  --vars '{"projectId":"<iterate-project-id>","connection":"t0675psn873","expectedTeamId":"T0675PSN873"}'
```

Require `ok: true`, the expected team ID, a bot user ID, and a directory claim
offset. If `auth.test` reports `invalid_auth`, OAuth has not established a live
connection—do not append claims around it.

Only after that barrier, send a **new** real-human or CI-actor `@iterate`
mention and retain its permalink. Slack webhooks received before the directory
claim exists are validly ACKed and ignored; Slack does not replay them after a
later association. A product-bot reply in the same thread proves signed webhook
ingress, the global workspace-to-project claim, the live project connection
and bot token, agent routing, and outbound Slack delivery.

Read the thread back through the live project connection as a second check.
Convert the permalink's final `p...` value back to Slack's dotted timestamp and
use the recorded connection explicitly:

```bash
# from apps/os; do not print any token
doppler run --config prd -- pnpm cli itx run \
  --context <iterate-project-id> \
  --vars '{"connection":"t0675psn873","channel":"C...","ts":"178...123456"}' \
  -e 'return await itx.integrations.slack.get(vars.connection).conversations.replies({ channel: vars.channel, ts: vars.ts })'
```

Require `ok: true`, the human root message, and a reply whose user is the
recorded product-bot user. Save the verifier result, permalink, timestamps, and
reply text in the cutover evidence. A pre-cutover or pre-claim thread is only a
baseline; repeat the message after reconnecting.

## Manual preview smoke test

1. Create or repair the preview Slack app with the preview manifest.
2. Deploy the preview after updating Doppler. Slack URL verification reads the
   deployed signing secret, not just the Doppler value.
3. Open the preview dashboard and run **Connect Slack** for the project that
   should receive events.
4. In Slack, use a private or dedicated test channel and invite the preview bot:

   ```text
   /invite @iterate-preview-N
   ```

5. Send `!debug` in the channel or in a thread. A working round trip should add
   the routing reaction and post a reply in the same thread.
6. In OS, inspect the project stream
   `/projects/<projectSlug>/streams/integrations/slack`. A real webhook path
   includes `events.iterate.com/slack/webhook-received`; routable messages also
   include `events.iterate.com/slack/thread-route-configured`.

## Duplicate replies in Iterate Slack

The Iterate Slack workspace is a special case because it can have the
production `iterate` app, the legacy `Niterate (CI bot)` actor, and one or more
preview Slack apps installed at the same time. Customer workspaces normally
only install one Iterate app, so they should not see this specific
preview-vs-production duplication.

If a preview bot and another Iterate-owned bot both reply to the same Slack
message, treat it as an internal workspace isolation issue until proven
otherwise:

- Our preview and production manifests subscribe to broad `message.channels`
  events. Slack's docs describe `message.channels` as the public-channel message
  event with `channels:history` as the required scope; they recommend
  `app_mention` when an app should receive only messages sent to that app.
- The OS Slack **router** still forwards normal Slack `message.*` events onto
  the thread agent stream (so history is complete). The **slack-agent**
  processor mention-gates LLM wakes: it only triggers a model turn when the
  message @mentions the authorized bot user (`<@U…>`), when Slack delivers
  `app_mention`, or on later messages in a thread that was already activated
  by a mention. Ambient channel traffic is transcribed as
  `dont-trigger-request` history and never spends model tokens by itself.
- The app scope `chat:write.public` lets a Slack app post into public channels,
  so a bot user not appearing as a channel member does not rule out its app
  posting a reply.
- If production has `APP_CONFIG_INTEGRATIONS__SLACK.botToken`, it can retry an
  outbound Slack Web API call after a missing, expired, or revoked connection
  token, but only after verifying the connection's Slack team.

For a precise diagnosis, inspect the Slack event wrapper and traces:

- `api_app_id` tells which Slack app Slack delivered the event to.
- `event_id`, `event.channel`, and `event.ts` identify the exact Slack event.
- `authorizations` shows the installation Slack considered able to see the
  event.
- Cloudflare traces around the Slack timestamp show which OS deployment called
  `chat.postMessage`.

Avoid duplicate internal replies by testing previews in a private channel that
only contains the preview app, or in a Slack workspace that does not also have
the production `iterate` app installed. Public channels in the Iterate
workspace can still be visible to production while broad public-channel event
subscriptions and `chat:write.public` are enabled.
