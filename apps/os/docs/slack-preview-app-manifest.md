# Slack apps for preview environments

Use this runbook when a browser-using agent needs to create or repair the Slack
app for an OS preview slot.

For the end-to-end testing flow and the `Niterate (CI bot)` duplicate-reply
caveat in the Iterate Slack workspace, see
[`docs/slack-testing.md`](../../../docs/slack-testing.md).
For bulk creation of the remaining preview Slack apps and the secrets handoff
form, see
[`docs/slack-preview-oauth-clients.md`](../../../docs/slack-preview-oauth-clients.md).

Each preview slot gets its own Slack app:

| OS config   | Slack label         | Dashboard URL                      | Slack app name        |
| ----------- | ------------------- | ---------------------------------- | --------------------- |
| `preview_N` | `preview-N`         | `https://os.iterate-preview-N.com` | `iterate (preview-N)` |
| `preview_1` | `preview-1` example | `https://os.iterate-preview-1.com` | `iterate (preview-1)` |

Do not reuse the production Slack app for previews, and do not point one Slack
app at multiple preview slots. Slack has one active Events API Request URL per
app, while OS stores one signing secret per deployed config.

## Safety checklist

- Confirm the exact slot number and Slack workspace with a human before making
  changes. Use the Iterate test/development Slack workspace unless the human
  explicitly says otherwise.
- Confirm before changing Doppler. `APP_CONFIG_INTEGRATIONS__SLACK` changes
  deployed behavior for that preview slot without a git diff.
- Keep Slack client secrets and signing secrets out of chat, screenshots, logs,
  and git. Use the Slack **Signing Secret**, not the deprecated verification
  token.
- Install and claim the workspace through OS after the Slack app exists. The
  Slack dashboard's "Install App to Workspace" button is not a substitute for
  OS's connect flow because OS must store the bot token and claim the Slack
  team in its own streams.

## Manifest

Use this manifest for slot `N`. Replace every `N` placeholder before pasting.
Use hyphen form (`preview-N`) in Slack labels and hostnames, and underscore form
(`preview_N`) only for Doppler config names.

```yaml
display_information:
  name: iterate (preview-N)
  description: iterate Slack agent for preview-N testing only
  background_color: "#111827"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  agent_view:
    agent_description: Test iterate's preview-N Slack agent against the preview OS deployment.
    suggested_prompts:
      - title: Debug this thread
        message: "!debug"
  bot_user:
    display_name: iterate-preview-N
    always_online: true
oauth_config:
  redirect_urls:
    - https://os.iterate-preview-N.com/api/integrations/slack/callback
  scopes:
    bot:
      - channels:history
      - channels:join
      - channels:manage
      - channels:read
      - chat:write
      - chat:write.public
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users.profile:read
      - users:read
      - users:read.email
      - assistant:write
      - conversations.connect:write
settings:
  event_subscriptions:
    request_url: https://os.iterate-preview-N.com/api/integrations/slack/webhook
    bot_events:
      - app_home_opened
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
    request_url: https://os.iterate-preview-N.com/api/integrations/slack/interactivity-webhook
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The bot scopes intentionally match `DEFAULT_SLACK_BOT_SCOPES` in
`apps/os/src/config.ts`. If the runtime default changes, update this manifest
and reinstall any affected Slack apps through the OS connect flow.

`features.agent_view` is included because newly created Slack AI apps use the
Agent messaging experience. OS currently routes real conversation work from
Slack `message.*` events; `app_home_opened` is included for Slack's agent
surface and future diagnostics, but it is not the smoke-test signal by itself.

## Browser creation flow

1. Open `https://api.slack.com/apps?new_app=1`.
2. Choose **From a manifest**.
3. Select the Iterate test/development workspace.
4. Paste the filled manifest for the slot.
5. Review Slack's summary and create the app.

If Slack refuses the manifest because the Events API Request URL cannot be
verified yet, create the app with a bootstrap manifest first:

```yaml
display_information:
  name: iterate (preview-N)
  description: iterate Slack agent for preview-N testing only
  background_color: "#111827"
features:
  bot_user:
    display_name: iterate-preview-N
    always_online: true
oauth_config:
  redirect_urls:
    - https://os.iterate-preview-N.com/api/integrations/slack/callback
  scopes:
    bot:
      - channels:history
      - channels:join
      - channels:manage
      - channels:read
      - chat:write
      - chat:write.public
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users.profile:read
      - users:read
      - users:read.email
      - assistant:write
      - conversations.connect:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Then finish Doppler and deployment, return to **App Manifest**, paste the full
manifest, and save it. Slack URL verification will succeed only after the
preview worker has the matching signing secret and is deployed.

The bootstrap manifest intentionally omits `features.agent_view`, app-home
settings, Events API subscriptions, and interactivity. Slack validates Agent
View against `message.im`, `app_home_opened`, and a verifiable request URL, so
those fields belong in the full manifest only after the preview worker can
answer Slack's URL verification challenge.

## Copy Slack credentials

After Slack creates the app, open **Basic Information** and collect:

- **Client ID**
- **Client Secret**
- **Signing Secret**
- Optional fallback for smoke testing: **Bot User OAuth Token** from
  **OAuth & Permissions**
- Optional for inventory only: **App ID** and **Team ID**

Do not use the Verification Token.

## Write Doppler config

From repo root, set the OS preview config. Keep the values in shell variables
or an interactive prompt; do not paste them into this file.

```bash
export SLACK_CLIENT_ID='...'
export SLACK_CLIENT_SECRET='...'
export SLACK_SIGNING_SECRET='...'
export SLACK_BOT_TOKEN='' # optional xoxb- token from OAuth & Permissions

jq -nc \
  --arg id "$SLACK_CLIENT_ID" \
  --arg secret "$SLACK_CLIENT_SECRET" \
  --arg signing "$SLACK_SIGNING_SECRET" \
  --arg bot "$SLACK_BOT_TOKEN" \
  '{oauthClientId:$id,oauthClientSecret:$secret,webhookSigningSecret:$signing}
    + if $bot == "" then {} else {botToken:$bot} end' |
  doppler secrets set APP_CONFIG_INTEGRATIONS__SLACK \
    --project os \
    --config preview_N \
    --silent
```

Verify shape without printing secret material:

```bash
doppler secrets get APP_CONFIG_INTEGRATIONS__SLACK \
  --project os \
  --config preview_N \
  --plain |
  jq -e '.oauthClientId and .oauthClientSecret and .webhookSigningSecret' >/dev/null
```

Then redeploy OS so the runtime config is baked into the worker:

```bash
(cd apps/os && doppler run --project os --config preview_N -- pnpm run deploy)
```

For a brand-new preview stack, follow the preview creation flow in
`docs/dev-environments.md` instead of directly deploying an unleased slot.

## Enable and verify Slack delivery

1. Return to the Slack app in the browser.
2. Open **App Manifest** and save the full manifest from this document.
3. Open **Event Subscriptions** and confirm the Request URL is verified:
   `https://os.iterate-preview-N.com/api/integrations/slack/webhook`.
4. Open **Interactivity & Shortcuts** and confirm the request URL is:
   `https://os.iterate-preview-N.com/api/integrations/slack/interactivity-webhook`.
5. If Slack says event delivery has been disabled, re-enable it only after the
   Request URL verifies. A bad signing secret or stale deploy can otherwise
   push the app back over Slack's failure threshold.

OS verifies Slack signatures before answering `url_verification`, so a 401
during URL verification almost always means the Slack app's Signing Secret and
the deployed `APP_CONFIG_INTEGRATIONS__SLACK.webhookSigningSecret` do not
match, or OS was not redeployed after the Doppler update.

## Claim the workspace through OS

1. Open the preview dashboard:
   `https://os.iterate-preview-N.com`.
2. Sign in with a real browser session or an agent-authenticated session. See
   `apps/os/docs/preview-agent-browser-smoke.md` for the headless browser path.
3. Create or open the project that should receive Slack events.
4. Go to the project **Integrations** page and click **Connect Slack**.
5. Approve the Slack OAuth screen.
6. Confirm the Integrations page shows Slack connected to the expected
   workspace.

This writes the workspace bot token into the project secret
`/secrets/integrations/slack/bot-token`, appends
`events.iterate.com/slack/connected` on `/integrations/slack`, and claims the
Slack team in the preview deployment's `/integrations/slack-team-directory`
stream.

If OS returns `slack_team_already_claimed`, that workspace is already claimed
by a different project in the same preview deployment. Disconnect Slack from
the old project or use another workspace. The same Slack workspace may still be
claimed independently in a different preview slot because each slot is a
separate deployment.

## Smoke test

Use a private or dedicated Slack test channel; message events in channels where
the bot is present are real triggers. In the Iterate Slack workspace, avoid
shared public channels for preview testing unless duplicate replies from the
production `iterate` app or legacy `Niterate (CI bot)` actor are acceptable.

1. Invite the preview bot to the channel:

   ```text
   /invite @iterate-preview-N
   ```

2. Send a normal root message or thread reply. OS should add an eyes reaction
   after routing the webhook.
3. For a deterministic visible Web API call, send:

   ```text
   !debug
   ```

   The Slack processor compiles this into a call to
   `itx.slack.chat.postMessage` in the same thread.

4. In OS, inspect the project stream
   `/projects/<projectSlug>/streams/integrations/slack`. A successful real
   webhook path includes `events.iterate.com/slack/webhook-received` and, for
   routable messages, `events.iterate.com/slack/thread-route-configured`.

The synthetic signed-webhook e2e in
`apps/os/e2e/vitest/slack-agent.e2e.test.ts` only needs the preview signing
secret. This Slack app setup is required for a real Slack round trip with
Slack's Events API and OAuth.

## Troubleshooting

- **Slack cannot verify the Request URL**: confirm the full manifest URL uses
  the right `preview-N`, the deployed worker is reachable, the Doppler JSON has
  the current Signing Secret, and OS was redeployed after the Doppler change.
- **OAuth callback fails**: confirm the redirect URL in Slack is exactly
  `https://os.iterate-preview-N.com/api/integrations/slack/callback` and that
  Doppler has the matching Client ID and Client Secret.
- **Events verify but no project reacts**: the Slack workspace may not be
  claimed through OS. Run the OS **Connect Slack** flow for the intended
  project.
- **Preview and another Iterate-owned bot both reply**: this is usually an
  internal Iterate Slack workspace artifact. Production and preview apps can
  both be installed there with broad `message.channels` subscriptions, and
  `chat:write.public` means an app can post into public channels even when its
  bot user is not visibly in the channel. See
  [`docs/slack-testing.md`](../../../docs/slack-testing.md).
- **Channel messages do nothing**: invite the preview bot to the channel and
  verify the app has been reinstalled after any scope changes. Slack applies
  manifest subscription changes immediately, but events gated by new scopes do
  not fire for old installs until reinstall.
- **App delivery was auto-disabled**: fix the URL/signing secret first, then
  re-enable delivery in Slack. Slack temporarily disables event subscriptions
  when almost all deliveries fail over a rolling window.

## Slack references

- App creation from manifests:
  <https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/>
- App manifest fields:
  <https://docs.slack.dev/reference/app-manifest/>
- Agent messaging experience:
  <https://docs.slack.dev/ai/developing-agents/>
- URL verification:
  <https://docs.slack.dev/reference/events/url_verification/>
- Request signing:
  <https://docs.slack.dev/authentication/verifying-requests-from-slack/>
- Events API failure limits:
  <https://docs.slack.dev/apis/events-api/>
- App lifecycle and distribution:
  <https://docs.slack.dev/app-management/distribution/>
