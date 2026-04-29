# Channel Agent POC Deployment

The live Jonas dev deployment uses the Doppler project `channel-agent-poc` and
the Cloudflare route `*.test.iterate-dev-jonas.app`.

## Prerequisites

From repo root:

```bash
pnpm install
```

Set up Doppler once:

```bash
cd experiments/channel-agent-poc/nested-facets
doppler setup --project channel-agent-poc --config dev_jonas
```

Required secrets are owned by `channel-agent-poc/dev_jonas`:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_API_TOKEN_DEV_JONAS`
- `CHANNEL_AGENT_POC_PROJECT_HOST`
- `CHANNEL_AGENT_POC_EVENTS_BASE_URL`
- `CHANNEL_TEST_SLACK_*`
- `CHANNEL_TEST_GITHUB_*`
- `CHANNEL_TEST_LINEAR_*`
- `CHANNEL_TEST_DISCORD_*`

Important actor-token aliases:

- `CHANNEL_TEST_SLACK_BOT_TOKEN`: Jonasland Slack app token installed into the
  Slack mini app.
- `CHANNEL_TEST_SLACK_NITERATE_BOT_TOKEN`: niterate Slack bot token used as a
  non-Jonasland Slack test actor.
- `CHANNEL_TEST_SLACK_CI_BOT_TOKEN` and `CHANNEL_TEST_SLACK_OS_CI_BOT_TOKEN`:
  CI/user-bot Slack test actors.
- `CHANNEL_TEST_GITHUB_USER_TOKEN`: GitHub token used to create test PR
  comments that mention the installed GitHub App.
- `CHANNEL_TEST_LINEAR_USER_API_KEY`: Linear API key used to create test issue
  comments that mention the Linear app actor.
- `CHANNEL_TEST_DISCORD_APP_BOT_TOKEN`: Discord app bot token used for REST and
  gateway smoke tests.

Do not put POC test credentials in `events`, `agents`, or `os`.

Do not copy browser cookies, localStorage, Slack web tokens, Discord web tokens,
or other interactive user-session material into Doppler. Browser-authenticated
manual proofs should use the user's open Chrome session through `agent-browser`.

## Normal Deploy

Use this after changing `base-template/apps/*`:

```bash
cd experiments/channel-agent-poc/nested-facets
doppler run -- ./scripts/deploy.sh
```

That script:

1. syncs `base-template/` into the Cloudflare Artifacts `base-template` repo,
2. rebases the live `test` project from that template,
3. builds `agents`, `slack`, `github`, `linear`, and `discord`.

Expected successful output:

```text
Base template synced successfully!
rebase: True
agents: True
slack: True
github: True
linear: True
discord: True
```

## Worker Deploy

Use this when changing files under `nested-facets/src`, `wrangler.jsonc`,
bindings, migrations, or routing:

```bash
cd experiments/channel-agent-poc/nested-facets
doppler run -- ./scripts/deploy.sh --worker
```

`--worker` runs `wrangler deploy` before rebasing/building the dynamic apps.

## Base Artifact Only

Use this to verify the Cloudflare Artifacts token and upload the template
without rebasing/building:

```bash
cd experiments/channel-agent-poc/nested-facets
doppler run -- npx tsx scripts/sync-base-artifact.ts ./base-template
```

The remote must be under the POC account:

```text
https://cc7f6f461fbe823c199da2b27f9e0ff3.artifacts.cloudflare.net/git/default/base-template.git
```

If it points at another account, the command is not running under
`channel-agent-poc/dev_jonas`.

## Install Live Apps

The deploy/build step updates code. Installation configures runtime credentials
inside each live mini app.

Run these from `experiments/channel-agent-poc/nested-facets`:

```bash
doppler run -- bash -lc '
set -euo pipefail
PROJECT_SLUG="${CHANNEL_TEST_PROJECT_SLUG:-test}"
EVENTS_BASE="${CHANNEL_TEST_EVENTS_BASE_URL:-https://test.events.iterate.com}"

curl -fsS "https://${CHANNEL_TEST_AGENTS_HOST}/api/install?projectSlug=${PROJECT_SLUG}&eventsBaseUrl=${EVENTS_BASE}" | jq .

curl -fsS -X POST "https://${CHANNEL_TEST_SLACK_HOST}/api/install" \
  -H "content-type: application/json" \
  -d "{\"projectSlug\":\"${PROJECT_SLUG}\",\"eventsBaseUrl\":\"${EVENTS_BASE}\",\"slackBotToken\":\"${CHANNEL_TEST_SLACK_BOT_TOKEN}\"}" | jq .

curl -fsS -X POST "https://${CHANNEL_TEST_GITHUB_HOST}/api/install" \
  -H "content-type: application/json" \
  -d "{\"projectSlug\":\"${PROJECT_SLUG}\",\"eventsBaseUrl\":\"${EVENTS_BASE}\",\"githubAppId\":\"${CHANNEL_TEST_GITHUB_APP_ID}\",\"githubAppPrivateKey\":\"${CHANNEL_TEST_GITHUB_APP_PRIVATE_KEY}\",\"githubAppInstallationId\":\"${CHANNEL_TEST_GITHUB_APP_INSTALLATION_ID}\",\"githubToken\":\"${CHANNEL_TEST_GITHUB_TOKEN}\",\"githubBotMentionNames\":\"${CHANNEL_TEST_GITHUB_APP_SLUG}\"}" | jq .

curl -fsS -X POST "https://${CHANNEL_TEST_LINEAR_HOST}/api/install" \
  -H "content-type: application/json" \
  -d "{\"projectSlug\":\"${PROJECT_SLUG}\",\"eventsBaseUrl\":\"${EVENTS_BASE}\",\"linearApiKey\":\"${CHANNEL_TEST_LINEAR_API_KEY}\",\"linearAccessToken\":\"${CHANNEL_TEST_LINEAR_ACCESS_TOKEN}\",\"linearAccessTokenExpiresAt\":\"${CHANNEL_TEST_LINEAR_ACCESS_TOKEN_EXPIRES_AT}\",\"linearRefreshToken\":\"${CHANNEL_TEST_LINEAR_REFRESH_TOKEN}\",\"linearOAuthClientId\":\"${CHANNEL_TEST_LINEAR_OAUTH_CLIENT_ID}\",\"linearOAuthClientSecret\":\"${CHANNEL_TEST_LINEAR_OAUTH_CLIENT_SECRET}\",\"linearBotMentionNames\":\"jonasland,iterate\"}" | jq .

curl -fsS -X POST "https://${CHANNEL_TEST_DISCORD_HOST}/api/install" \
  -H "content-type: application/json" \
  -d "{\"projectSlug\":\"${PROJECT_SLUG}\",\"eventsBaseUrl\":\"${EVENTS_BASE}\",\"discordBotToken\":\"${CHANNEL_TEST_DISCORD_BOT_TOKEN}\"}" | jq .
'
```

Each response should include `ok: true`. Slack/GitHub/Linear responses include
the webhook URL that must be configured in the platform app.

## Platform Webhook URLs

- Slack: `https://slack.test.iterate-dev-jonas.app/api/webhook`
- GitHub: `https://github.test.iterate-dev-jonas.app/api/webhook`
- Linear: `https://linear.test.iterate-dev-jonas.app/api/webhook`
- Discord: no public webhook; the app uses a Discord gateway connection.

## Useful URLs

- Project home: `https://test.iterate-dev-jonas.app/`
- Agents mini app: `https://agents.test.iterate-dev-jonas.app/`
- Slack mini app: `https://slack.test.iterate-dev-jonas.app/`
- GitHub mini app: `https://github.test.iterate-dev-jonas.app/`
- Linear mini app: `https://linear.test.iterate-dev-jonas.app/`
- Discord mini app: `https://discord.test.iterate-dev-jonas.app/`
- Events UI: `https://test.events.iterate.com/`
