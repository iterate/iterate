# Slack testing

Use this when testing real Slack flows against OS local dev, preview, or
production environments.

## Start here

- Preview Slack app creation and manifest:
  [apps/os/docs/slack-preview-app-manifest.md](../apps/os/docs/slack-preview-app-manifest.md)
- Bulk-create remaining preview Slack OAuth clients:
  [slack-preview-oauth-clients.md](slack-preview-oauth-clients.md)
- Slack bot token migration and portal links:
  [slack-bot-token-migration.md](slack-bot-token-migration.md)
- Public local URLs for Slack callbacks:
  [dev-environments.md#tunnels-and-webhooks](dev-environments.md#tunnels-and-webhooks)
- Older manual production smoke notes:
  [slack-smoke-testing.md](slack-smoke-testing.md)

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
  secret. It also contains `botToken`, the deployment-level outbound fallback
  for that same Slack app.
- The OS **Connect Slack** flow stores the workspace bot token for a project at
  `/secrets/integrations/slack/bot-token` and claims the Slack team in the
  deployment's `/integrations/slack-team-directory` stream.
- Slack Web API calls use the project workspace token first. If the project has
  no connected Slack token, OS falls back to
  `APP_CONFIG_INTEGRATIONS__SLACK.botToken`, then temporarily to the legacy
  top-level `APP_CONFIG_SLACK_BOT_TOKEN` while the migration is being finished.
- `APP_CONFIG_SLACK_BOT_TOKEN` is legacy. When diagnosing duplicate replies,
  check whether it exists in the environment without printing the token.

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
processor. `Niterate (CI bot)` is only an internal legacy CI/smoke actor; it is
not the production `iterate` app and should not be the normal preview trigger.

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
- The current OS Slack processor routes normal Slack `message.*` events. It
  does not require the mentioned user ID to match the deployment's bot user
  before starting the agent.
- The app scope `chat:write.public` lets a Slack app post into public channels,
  so a bot user not appearing as a channel member does not rule out its app
  posting a reply.
- If production has either `APP_CONFIG_INTEGRATIONS__SLACK.botToken` or the
  legacy `APP_CONFIG_SLACK_BOT_TOKEN`, it can use that fallback token for
  outbound Slack Web API calls when no project token is available.

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
