# opencode project configuration

Proof of concept: [opencode v2](https://opencode.ai/v2/docs/build/sdk/cloudflare/)
running inside one of this project's userland Durable Objects, with no
platform changes.

- `apps/opencode/opencode.ts` — the object. Boots `OpenCodeWorkerd.create`
  on its own SQLite storage; exposes `prompt`, `sessions`, `messages`,
  `health` over RPC and a small chat page over HTTP.
- `worker.ts` — names the object, mounts it as `itx.worker.opencode`, and
  routes the `opencode` app host to it (project members only).
- `vendor/opencode-workerd.js` — `@opencode/sdk/workerd` prebundled with the
  `workerd` condition (see `vendor/README.md` for why and how).

## Use

Open the `opencode` app host from the project worker's root page. The first
visit links to the platform's secret-collection page for an OpenAI API
key; the key lands in `/secrets/openai-api-key`, pinned to
`https://api.openai.com`, and opencode references it as
`getSecret("/secrets/openai-api-key")` — the project egress door does the
substitution, so no code in this repo ever holds it.

From any itx runtime (agent scripts, the CLI, the browser REPL):

```ts
const { sessionID, reply } = await itx.worker.opencode.prompt({ text: "hello" });
await itx.worker.opencode.prompt({ sessionID, text: "and again" });
```

## Known limits

- No tools: opencode's workerd profile has no filesystem or shell, so it is a
  chat model with opencode's session/compaction machinery around it. Backing
  its tools with itx (a workspace, `itx.run`) is the obvious next step.
- `prompt` waits for the whole turn; nothing streams yet.
