# Slack bot token migration

Use this when collecting or rotating the per-app Slack Bot User OAuth Token for
OS Slack smoke testing.

## Goal

Each Slack app should own its complete runtime config in
`APP_CONFIG_INTEGRATIONS__SLACK`:

```json
{
  "oauthClientId": "...",
  "oauthClientSecret": "...",
  "webhookSigningSecret": "...",
  "botToken": "xoxb-..."
}
```

OS Slack Web API calls use the connected project workspace bot token first. If
a project has no connected Slack token, OS falls back to this environment's
`APP_CONFIG_INTEGRATIONS__SLACK.botToken`. The old top-level
`APP_CONFIG_SLACK_BOT_TOKEN` is a temporary legacy fallback only.

`Niterate (CI bot)` is not the production Slack app. The production Slack app
is `iterate`; `Niterate (CI bot)` is the visible identity associated with the
legacy shared CI/smoke token.

## Current status

As of July 2, 2026, Doppler has `botToken` embedded in
`APP_CONFIG_INTEGRATIONS__SLACK` for these `os` configs:

```text
dev
dev_jonas
dev_misha
dev_rahul
prd
preview_1
preview_2
preview_3
preview_5
preview_6
preview_7
preview_8
preview_9
```

Known gaps:

- `preview_4` has a Slack app, but the paste-back form did not include a bot
  token.
- `preview_10` has a Slack app ID, but `os/preview_10` does not currently
  exist in Doppler.
- Affected workers still need to be redeployed before they can use newly
  uploaded Doppler values.

## OAuth pages

Open the app's **OAuth & Permissions** page, then copy **Bot User OAuth
Token**. It should start with `xoxb-`.

| Config       | Slack app              | OAuth page                                     |
| ------------ | ---------------------- | ---------------------------------------------- |
| `prd`        | `iterate`              | <https://api.slack.com/apps/A08NDMDC2JV/oauth> |
| `dev`        | shared dev app         | <https://api.slack.com/apps/A0BELTE7H6X/oauth> |
| `dev_jonas`  | `iterate (dev-jonas)`  | <https://api.slack.com/apps/A08T45SFJF3/oauth> |
| `dev_misha`  | `iterate (dev-misha)`  | <https://api.slack.com/apps/A09A308RAT0/oauth> |
| `dev_rahul`  | `iterate (dev-rahul)`  | <https://api.slack.com/apps/A0A9CMH5DU4/oauth> |
| `preview_1`  | `iterate (preview-1)`  | <https://api.slack.com/apps/A0BESK0LJ7L/oauth> |
| `preview_2`  | `iterate (preview-2)`  | <https://api.slack.com/apps/A0BETEYFPCZ/oauth> |
| `preview_3`  | `iterate (preview-3)`  | <https://api.slack.com/apps/A0BFM413EMN/oauth> |
| `preview_4`  | `iterate (preview-4)`  | <https://api.slack.com/apps/A0BESQ2278S/oauth> |
| `preview_5`  | `iterate (preview-5)`  | <https://api.slack.com/apps/A0BEBDGA1TR/oauth> |
| `preview_6`  | `iterate (preview-6)`  | <https://api.slack.com/apps/A0BEPFZ8THT/oauth> |
| `preview_7`  | `iterate (preview-7)`  | <https://api.slack.com/apps/A0BELK8UL3V/oauth> |
| `preview_8`  | `iterate (preview-8)`  | <https://api.slack.com/apps/A0BEURK2AAV/oauth> |
| `preview_9`  | `iterate (preview-9)`  | <https://api.slack.com/apps/A0BEQUQ51F0/oauth> |
| `preview_10` | `iterate (preview-10)` | <https://api.slack.com/apps/A0BER06737Y/oauth> |

## Paste-back form

Do not commit a filled copy of this file. Paste filled values back to the
agent, or use a private temporary file outside the repo.

```text
SLACK_APP_BOT_TOKENS

preview_4:
  app_id: A0BESQ2278S
  bot_token:

preview_10:
  app_id: A0BER06737Y
  bot_token:
```

## Doppler update shape

Merge `botToken` into the existing JSON. Do not replace the OAuth client ID,
OAuth client secret, or webhook signing secret.

```bash
existing="$(
  doppler secrets get APP_CONFIG_INTEGRATIONS__SLACK \
    --project os \
    --config preview_N \
    --plain
)"

updated="$(
  jq -c --arg bot "$SLACK_BOT_TOKEN" '. + {botToken:$bot}' <<<"$existing"
)"

doppler secrets set APP_CONFIG_INTEGRATIONS__SLACK="$updated" \
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
  jq -e '.oauthClientId and .oauthClientSecret and .webhookSigningSecret and .botToken' >/dev/null
```
