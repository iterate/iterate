# Slack preview OAuth clients

Use this file to create the remaining preview Slack apps by hand. For each
section:

1. Open <https://api.slack.com/apps?new_app=1>.
2. Choose **From a manifest**.
3. Select the iterate Slack workspace used for preview testing.
4. Copy the JSON manifest under the preview heading.
5. Create the app.
6. Open **Basic Information** and paste the secrets into the plain text form
   directly below that manifest.

Do not commit a filled copy of this file. Paste the filled forms back to the
agent instead. After that, the agent can upload
`APP_CONFIG_INTEGRATIONS__SLACK` to the matching Doppler `os/preview_N` configs
and redeploy the slots.

These are bootstrap manifests. They intentionally omit Events API and
interactivity request URLs, App Home, and Agent View so Slack does not need to
verify the webhook before the preview worker has the app's signing secret.
After Doppler upload and deploy, save the full manifest from
[apps/os/docs/slack-preview-app-manifest.md](../apps/os/docs/slack-preview-app-manifest.md)
to enable event subscriptions and interactivity.

If Slack validation mentions Agent View requiring `message.im` or
`app_home_opened`, the manifest being pasted is not the bootstrap manifest.
Use the JSON under the preview heading first, then save the full manifest after
the deployed worker can verify the request URL.

`preview_2` already has a Slack app. The repo's preview deployment docs
currently describe active preview slots `preview_1` through `preview_9`.

## preview_1

```json
{
  "display_information": {
    "name": "iterate (preview-1)",
    "description": "iterate Slack agent for preview-1 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-1",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-1.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_1:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```

## preview_3

```json
{
  "display_information": {
    "name": "iterate (preview-3)",
    "description": "iterate Slack agent for preview-3 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-3",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-3.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_3:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```

## preview_4

```json
{
  "display_information": {
    "name": "iterate (preview-4)",
    "description": "iterate Slack agent for preview-4 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-4",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-4.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_4:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```

## preview_5

```json
{
  "display_information": {
    "name": "iterate (preview-5)",
    "description": "iterate Slack agent for preview-5 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-5",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-5.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_5:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```

## preview_6

```json
{
  "display_information": {
    "name": "iterate (preview-6)",
    "description": "iterate Slack agent for preview-6 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-6",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-6.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_6:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```

## preview_7

```json
{
  "display_information": {
    "name": "iterate (preview-7)",
    "description": "iterate Slack agent for preview-7 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-7",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-7.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_7:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```

## preview_8

```json
{
  "display_information": {
    "name": "iterate (preview-8)",
    "description": "iterate Slack agent for preview-8 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-8",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-8.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_8:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```

## preview_9

```json
{
  "display_information": {
    "name": "iterate (preview-9)",
    "description": "iterate Slack agent for preview-9 testing only",
    "background_color": "#111827"
  },
  "features": {
    "bot_user": {
      "display_name": "iterate-preview-9",
      "always_online": true
    }
  },
  "oauth_config": {
    "redirect_urls": ["https://os.iterate-preview-9.com/api/integrations/slack/callback"],
    "scopes": {
      "bot": [
        "channels:history",
        "channels:join",
        "channels:manage",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users.profile:read",
        "users:read",
        "users:read.email",
        "assistant:write",
        "conversations.connect:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

```text
preview_9:
  app_id:
  client_id:
  client_secret:
  signing_secret:
  team_id:
  app_dashboard_url:
```
