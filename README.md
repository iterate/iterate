# iterate

## get started

```bash
pnpm install
brew install doppler
doppler login
doppler setup # choose project `os` and config `dev_personal`
pnpm docker:up # requires docker compose - get docker desktop or orbstack first
pnpm db:migrate
brew install --cask ngrok # needed for receiving webhooks
open https://dashboard.ngrok.com/get-started/your-authtoken # use npc ngrok account from 1password\
# copy auth token to clipboard then:
ngrok config add-authtoken $(pbpaste)
pnpm dev
# go to the local web ui and click "Connect to Slack". See below for details.
```

### Dev cheat sheet

All paths relative to repo root.

```bash

# Run os app and ngrok without loading any specific iterate config
# This means the bot will behave like a "repo-less" estate in production
pnpm dev

# Use a specific iterate config
# This is the template users start with - it contains the tutorial instructions
pnpm dev -- -c estates/template

# This is iterate's own iterate estate - so the bot will behave like the production bot in the iterate slack
pnpm dev -- -c estates/template

# Reset everything in development
pnpm super-reset

```

### Using slack in development

You need to create a slack app at https://api.slack.com/apps with a manifest that looks like this (replace `{ITERATE_USER}` with your username):

```json
{
  "display_information": {
    "name": "({ITERATE_USER} local) Iterate"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "(jonas local) Iterate",
      "always_online": true
    },
    "assistant_view": {
      "assistant_description": "T",
      "suggested_prompts": []
    }
  },
  "oauth_config": {
    "redirect_urls": [
      "https://iterateproxy.com/oauth/slack",
      "https://{ITERATE_USER}.dev.iterate.com/api/integrations/slack/oauth",
      "https://dev.iterateproxy.com/api/integrations/slack/oauth",
      "http://localhost:5173/api/auth/integrations/callback/slack-bot"
    ],
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "chat:write.public",
        "chat:write",
        "channels:join",
        "channels:read",
        "reactions:read",
        "files:read",
        "assistant:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://{ITERATE_USER}.dev.iterate.com/api/integrations/slack/webhook",
      "bot_events": [
        "file_shared",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed"
      ]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

You'll also need to set the following env vars in your `dev_personal` config in our doppler project:

```
SLACK_CLIENT_ID
SLACK_CLIENT_SECRET
SLACK_SIGNING_SECRET
```

You can get them from the slack app settings page.
