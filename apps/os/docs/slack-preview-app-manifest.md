# Slack app for preview testing

A dedicated Slack app whose Events API points at a preview slot, so a real
Slack conversation can be verified against a preview deployment without
touching the production Slack app. Create it at
<https://api.slack.com/apps?new_app=1> → "From a manifest" → paste the YAML
below (workspace: the iterate test workspace), then:

1. Copy the app's **Client ID**, **Client Secret**, and **Signing Secret**
   into the slot's Doppler config:
   `APP_CONFIG_INTEGRATIONS__SLACK={"oauthClientId":"…","oauthClientSecret":"…","webhookSigningSecret":"…"}`
   (project `os`, config `preview_2`).
2. Redeploy the slot so the config bakes in.
3. Slack requires the events URL to answer the `url_verification` challenge
   before it enables events — do this after the integrations domain is
   deployed to the slot.
4. Install the app to the workspace through the OS connect flow (project
   settings → integrations) so the workspace is claimed by a project.

```yaml
display_information:
  name: Iterate (preview-2)
  description: Iterate agents — preview-2 slot (testing only)
  background_color: "#1a1a2e"
features:
  bot_user:
    display_name: iterate-preview-2
    always_online: true
oauth_config:
  redirect_urls:
    - https://os.iterate-preview-2.com/api/integrations/slack/callback
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
    request_url: https://os.iterate-preview-2.com/api/integrations/slack/webhook
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
    request_url: https://os.iterate-preview-2.com/api/integrations/slack/interactivity-webhook
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

For other slots, replace `preview-2` throughout. The synthetic-webhook e2e
does not need any of this (it signs with the slot's own
`webhookSigningSecret`); this manifest is only for a REAL Slack round-trip
with human eyes on it.
