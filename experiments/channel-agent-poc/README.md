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
- `nested-facets/base-template/apps/agents` contains the thin agent host, the
  event stream mini UI, the copied agent loop processor, and the codemode
  processor.
- `nested-facets/base-template/apps/slack`, `github`, `linear`, and `discord`
  contain disposable channel adapter examples.
- `nested-facets/base-template/apps/tanstack-app` keeps the embedded TanStack
  app copy that the nested facets base template can load.

The old `apps/events/poc` directory has been removed.

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
