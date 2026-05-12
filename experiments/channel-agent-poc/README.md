# Channel Agent POC

This directory parks the dynamic channel-agent proof of concept that was built
while exploring event streams, channel webhooks, agent processors, codemode, and
SDK-backed tool providers.

This is intentionally not product code. It is a reference implementation of the
shape:

1. A channel app receives a raw platform event.
2. The channel app appends the raw event to a global channel stream.
3. The channel app cross-posts that raw event into an agent thread stream.
4. The agent processor rewrites the raw event into `agent-input-added`.
5. The LLM emits a JavaScript codemode block.
6. Codemode calls the relevant channel provider.
7. The result is appended back to the same event stream.

## Contents

- `nested-facets/` is the self-contained Cloudflare Worker package formerly at
  `apps/events/poc/nested-facets`.
- `nested-facets/base-template/apps/agent-host` contains the thin agent host, the
  event stream mini UI, the copied agent loop processor, and the codemode
  processor.
- `nested-facets/base-template/apps/slack`, `github`, `linear`, and `discord`
  contain disposable channel adapter examples.
- `nested-facets/base-template/apps/tanstack-app` keeps the embedded TanStack
  app copy that the nested facets base template can load.

The old `apps/events/poc` directory has been removed.

## Start Here

- [ARCHITECTURE.md](./ARCHITECTURE.md): big ideas, event flow, app boundaries,
  stream paths, and known POC tradeoffs.
- [DEPLOYMENT.md](./DEPLOYMENT.md): Doppler setup, deploy commands, app install
  commands, webhook URLs, and useful live URLs.
- [TESTING.md](./TESTING.md): smoke checks and exact Slack/GitHub/Linear/Discord
  test commands.
- [ARCHITECTURE-REVIEW.md](./ARCHITECTURE-REVIEW.md): self-review and cleanup
  backlog.

## Doppler

The POC has its own Doppler project: `channel-agent-poc`.

Use `dev_jonas` for the live Jonas dev setup:

```bash
cd experiments/channel-agent-poc/nested-facets
doppler setup --project channel-agent-poc --config dev_jonas
doppler run -- ./scripts/deploy.sh --worker
```

Secrets that belong to this POC live there, not in `events` or `agents`:

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_TOKEN_DEV_JONAS`: Cloudflare account/API token for the disposable Artifacts + Worker account.
- `CHANNEL_AGENT_POC_PROJECT_HOST`, `CHANNEL_AGENT_POC_EVENTS_BASE_URL`: live test host defaults.
- `CHANNEL_TEST_SLACK_*`: Slack workspace, bot, channel, and CI posting token used to test on behalf of a non-agent user.
- `CHANNEL_TEST_GITHUB_*`: GitHub App, installation, repo, PR, and fallback token used for channel tests.
- `CHANNEL_TEST_LINEAR_*`: Linear OAuth client, installed actor token, webhook secret, team, and issue test state.
- `CHANNEL_TEST_DISCORD_*`: Discord bot token, guild, channel, bot user, and live app host.

The channel app runtime credentials are still installed into each live mini app
through its `/api/install` endpoint and stored in that app's local config table.
Doppler is the source of truth for the credentials and IDs used to recreate or
test those installs.

## What This Proves

- Raw channel event cross-posting into agent streams.
- Channel-specific event-to-agent-input rewriting.
- One agent thread per external conversation.
- No-wrapper codemode blocks.
- SDK-ish providers for Slack, GitHub/Octokit, Linear, and Discord.
- A minimal event stream UI with a fixed composer.

## What Is Not Clean Yet

- The Cloudflare `wrangler.jsonc` contains disposable Jonas dev route and
  migration settings.
- Channel app auth, webhook verification, deployment, and default events are
  POC-grade.
- The processors are intentionally copied into the experiment rather than shared
  as a real package.
- Existing remote streams may contain noisy historical events from earlier
  debugging.

Use this as a reference when designing the real dynamic app processor host, not
as the final implementation location.
