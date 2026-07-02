# Slack testing

Use this when testing real Slack flows against OS local dev, preview, or
production environments.

## Start here

- Preview Slack app creation and manifest:
  [apps/os/docs/slack-preview-app-manifest.md](../apps/os/docs/slack-preview-app-manifest.md)
- Bulk-create remaining preview Slack OAuth clients:
  [slack-preview-oauth-clients.md](slack-preview-oauth-clients.md)
- Public local URLs for Slack callbacks:
  [dev-environments.md#tunnels-and-webhooks](dev-environments.md#tunnels-and-webhooks)
- Older manual production smoke notes:
  [slack-smoke-testing.md](slack-smoke-testing.md)

## Environment model

Every public OS environment needs its own Slack app and callback URLs.

| OS environment | Slack app                             | Request URL                                                         |
| -------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `prd`          | `Niterate Bot`                        | `https://os.iterate.com/api/integrations/slack/webhook`             |
| `preview_N`    | `iterate-preview-N`                   | `https://os.iterate-preview-N.com/api/integrations/slack/webhook`   |
| local dev      | personal/dev Slack app or preview app | `https://<name>.tunnels.iterate.com/api/integrations/slack/webhook` |

The Doppler secrets are split by purpose:

- `APP_CONFIG_INTEGRATIONS__SLACK` contains the Slack app credentials for the
  OS deployment: OAuth client ID, OAuth client secret, and webhook signing
  secret.
- The OS **Connect Slack** flow stores the workspace bot token for a project at
  `/secrets/integrations/slack/bot-token` and claims the Slack team in the
  deployment's `/integrations/slack-team-directory` stream.
- `APP_CONFIG_SLACK_BOT_TOKEN` is a deployment-level outbound fallback for
  Slack Web API calls when a project bot token is unavailable. When diagnosing
  duplicate replies, check whether this exists in the environment without
  printing the token.

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

The Iterate Slack workspace is a special case because it can have both the
production `Niterate Bot` app and one or more preview Slack apps installed at
the same time. Customer workspaces normally only install one Iterate app, so
they should not see this specific preview-vs-production duplication.

If a preview bot and `Niterate Bot` both reply to the same Slack message, treat
it as an internal workspace isolation issue until proven otherwise:

- Our preview and production manifests subscribe to broad `message.channels`
  events. Slack's docs describe `message.channels` as the public-channel message
  event with `channels:history` as the required scope; they recommend
  `app_mention` when an app should receive only messages sent to that app.
- The current OS Slack processor routes normal Slack `message.*` events. It
  does not require the mentioned user ID to match the deployment's bot user
  before starting the agent.
- The app scope `chat:write.public` lets a Slack app post into public channels.
  So `Niterate Bot` not appearing as a channel member does not rule out
  production posting a reply.
- If `APP_CONFIG_SLACK_BOT_TOKEN` exists in `os/prd`, production can use that
  fallback token for outbound Slack Web API calls when no project token is
  available.

For a precise diagnosis, inspect the Slack event wrapper and traces:

- `api_app_id` tells which Slack app Slack delivered the event to.
- `event_id`, `event.channel`, and `event.ts` identify the exact Slack event.
- `authorizations` shows the installation Slack considered able to see the
  event.
- Cloudflare traces around the Slack timestamp show which OS deployment called
  `chat.postMessage`.

Avoid duplicate internal replies by testing previews in a private channel that
only contains the preview app, or in a Slack workspace that does not also have
the production `Niterate Bot` installed. Public channels in the Iterate
workspace can still be visible to production while broad public-channel event
subscriptions and `chat:write.public` are enabled.
