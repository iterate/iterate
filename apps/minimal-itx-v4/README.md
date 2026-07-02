# Minimal ITX v4

The public Cap'n Web endpoint exports one unauthenticated target:

```ts
using unauthenticatedItx = connectItx({ baseUrl });
using root = unauthenticatedItx.authenticate({
  type: "token",
  token: { type: "user", principal: "alice", projectScopes: ["prj_ref"] },
});
using project = root.projects.get("prj_ref");
```

`authenticate()` is the only way to get the real ITX capability. Its input is
also the shape used by platform-provided dynamic worker bindings:

```ts
type ItxAuthCredentials =
  | { type: "token"; token: ItxAuthToken }
  | { type: "from-server-cookie" }
  | { type: "trusted-internal"; token: string };
```

Authentication returns the root ITX catalog. From there, `root.projects.get(id)`
returns a project capability and `root.projects.create({ slug })` creates a
project. Project creation also creates and seeds the default repo at path `/`,
loads the seeded project worker from `worker.js`, and only then emits
`events.iterate.com/project/created`.

```ts
using project = root.projects.create({ slug: "demo" });

await project.repo.whoami(); // same repo as project.repos.get("/")
const response = await project.worker.fetch(new Request("https://example.com/probe"));
```

Browser-style auth can be simulated with a fake login endpoint:

```bash
curl -i -X POST http://127.0.0.1:8791/api/login --data alice-token
```

That writes an HttpOnly cookie. Browser callers then connect to `/api/itx` and
authenticate with:

```ts
using itx = unauthenticatedItx.authenticate({
  type: "from-server-cookie",
});
```

Dynamic workers receive an `env.ITX` binding whose props include a trusted
internal project/path scope. Inside loaded code:

```ts
const itx = await env.ITX.get();
```

Project and agent-scoped ITX also expose Workers AI through `itx.ai`. The
minimal app implements this as an `AiRpcTarget` that proxies the platform
`env.AI` binding directly:

```ts
const reply = await itx.ai.run("@cf/moonshotai/kimi-k2.7-code", {
  messages: [{ role: "user", content: "Say hello" }],
});
```

The wrapper keeps the Cloudflare binding shape visible: `run(model, body)`
forwards to `env.AI.run(...)`, `models()` forwards to `env.AI.models()`, and the
constructor can carry AI Gateway options that are passed as the third
`env.AI.run(...)` argument. The agent runtime should treat model names as
opaque. Cloudflare's AI binding can run Workers AI `@cf/...` models and AI
Gateway third-party model names through the same `run(...)` entry point, so the
agent core should not bake in a provider catalog.

External clients still connect to `/api/itx` and call `authenticate(...)`.
`connectItx` overloads are only client-side convenience:

```ts
using root = connectItx({ auth, baseUrl });
using project = connectItx({ auth, baseUrl, projectId: "prj_ref" });
using agent = connectItx({ agentPath: "/agents/demo", auth, baseUrl, projectId: "prj_ref" });
```

Run the local Miniflare-backed worker and test it:

```bash
pnpm verify:miniflare
```

Run the same suite against a deployed worker:

```bash
ITX_BASE=https://your-worker.workers.dev pnpm verify:deployed
```

The blind egress relay POC has a separate deployed Worker, playground, and test
recipe in [BLIND_RELAY_POC.md](./BLIND_RELAY_POC.md).

Open a Node REPL against a running local or deployed worker:

```bash
pnpm repl
ITX_BASE=https://your-worker.workers.dev pnpm repl
```

The REPL exposes `itx`, `root`, `RpcTarget`, `baseUrl`, `projectId`, and `token`.
Defaults are `http://127.0.0.1:8791`, project `prj_ref`, and the demo tokens
from `src/auth.ts`.

## Page Debugging Demo

This app includes a self-contained proof of concept for the in-page debugging
idea. The worker routes `/page-debugging/*` to `PageDebuggingDemoDurableObject`.
That Durable Object hosts the demo page, mints short-lived HMAC tokens, stores
the token claims in its own storage, and serves a tiny browser ESM client.

Run it locally:

```bash
pnpm --dir apps/minimal-itx-v4 dev
```

Open the local or deployed demo:

```text
http://127.0.0.1:8791/page-debugging
https://minimal-itx-v4.iterate-dev-preview.workers.dev/page-debugging
```

Live demo flow:

1. Open the demo page and copy the generated snippet.
2. Open any target page in the same browser and paste the snippet into that
   page's DevTools console. Paste into the host page, not a cross-origin iframe,
   if you want host-page screenshots.
3. The target page gets a small **ITERATE** widget in the bottom-right corner.
   Its menu says **Sharing with ITERATE** and includes **Share a screenshot**,
   **Enable screen capture**, **Copy page URL**, and **Stop sharing**. Stop
   sharing removes the widget and revokes that demo session's short-lived tokens.
4. Return to the demo page and click **Take Screenshot**. The screenshot is
   rendered back into the demo page.
5. Click **Snapshot**, **Click counter**, or **Fill message** to show that those
   calls also cross the worker and invoke the mounted `debugPage` capability in
   the target page.
6. For a no-DevTools demo, click **Run in this tab** instead; that mounts the
   same capability on the demo page itself.

The generated snippet imports only the worker-hosted client module:

```js
const { connectPageTools } = await import("http://127.0.0.1:8791/page-debugging/client.mjs");
```

That client module imports `capnweb`, Testing Library DOM queries, and
`user-event` from esm.sh. It also exposes `screenshot()`: by default it silently
falls back to a host-DOM render, and if the user clicks the injected
**Enable Host Capture** button in the target page it uses the Screen Capture API
for true host-tab pixels. The WebSocket auth token rides in
`Sec-WebSocket-Protocol` as `itx-page-debugging.<token>` because browsers cannot
set `Authorization` headers on WebSocket upgrades. The server verifies the HMAC
and checks that the token id still exists in the Durable Object's storage before
vending the project ITX.

Each generated session creates a throwaway demo project and short-lived provider
and agent tokens, so concurrent demos do not fight over the same mounted
`debugPage` capability.

## Web Chat LLM Agent

The minimal LLM agent should mirror the real `apps/os` agent shape, but keep
only the web-chat channel. Slack-specific paths, prompts, and `itx.slack` tools
do not belong here.

The public entry is still an agent capability:

```ts
using agent = project.agents.get("/agents/demo");
await agent.sendMessage("What changed today?");
const reply = await agent.ask({ message: "Summarize the stream." });
```

`sendMessage` appends one channel event to the agent stream:

```ts
{
  type: "events.iterate.com/agents/user-message-received",
  payload: { origin: "web", content: message },
}
```

The agent core processor owns model-visible history and request scheduling. It
does not call a model directly:

1. Render web input into `events.iterate.com/agent/input-added`.
2. Apply the input policy: `after-current-request`, `interrupt-current-request`,
   or `dont-trigger-request`.
3. Debounce and append `events.iterate.com/agent/llm-request-requested` with
   `{ provider, model }`.
4. Re-render tool responses from `events.iterate.com/agents/web-message-sent`
   back into history with `dont-trigger-request`.
5. Extract the fenced JavaScript async arrow function from
   `events.iterate.com/agent/output-added` and enqueue ITX script execution.

The default web-chat prompt follows the OS agent contract: respond with exactly
one fenced JavaScript code block and no surrounding prose. The code block must
contain a single async arrow function:

```js
async (itx) => {
  await itx.chat.sendMessage({ message: "Done." });
};
```

LLM requests are request-by-reference. The `llm-request-requested` event carries
no prompt body; its offset is the `llmRequestId`. A subscribed provider
processor rebuilds the chat request by reducing committed agent history up to
that offset, then executes the provider call and appends:

```ts
{ type: "events.iterate.com/<provider>/llm-request-started", payload: { llmRequestId, model } }
{ type: "events.iterate.com/<provider>/llm-response-chunk", payload: { llmRequestId, sequence, chunk } }
{ type: "events.iterate.com/agent/output-added", payload: { llmRequestId, content } }
{ type: "events.iterate.com/agent/llm-request-completed", payload: { llmRequestId, provider, result } }
```

Provider support should stay behind one small binding boundary:

```ts
type AiLike = {
  run(model: string, body: unknown): Promise<unknown>;
};
```

The Cloudflare AI provider receives only this minimal `run(...)` shape and calls
`ai.run(model, { ...body, stream: true })`. The public `project.ai` capability
uses `AiRpcTarget` to proxy the Worker-global `env.AI` binding for direct
scripts. Response parsing should accept the shapes OS already supports: Workers
AI `{ response }`, OpenAI-compatible chat completions `{ choices }`, Anthropic
message blocks `{ content: [...] }`, and streaming SSE chunks from those
families. Other AI bindings can be mounted by providing the same `run(model,
body)` capability shape, while the agent protocol and history reduction stay
unchanged.

The only agent-local channel tool is web chat:

```ts
await itx.chat.sendMessage({ message: "Done." });
```

That tool appends `events.iterate.com/agents/web-message-sent`. The agent core
then records it as model-visible assistant context without triggering another
LLM request.

## Stream Processor Hosting

Stream processors receive a full public `Stream` capability. A processor-hosting
Durable Object creates a trusted internal `StreamRpcTarget` for its own stream
and passes it to `createStreamProcessorHost(...)`; processors do not receive raw
Durable Object stubs.

Outbound subscription handshakes are identity-only: the stream Durable Object
tells the processor host which `subscriptionKey` to open, and the host calls
`.subscribe(...)` on its own stable stream capability. No stream capability is
passed through the handshake.

The stream Durable Object's storage methods remain implementation details.
Append/read methods that touch SQLite/KV directly stay synchronous internally;
the public `Stream` interface remains async through `StreamRpcTarget`.

## Cloudflare Workers RPC Types

This app currently relies on `patches/@cloudflare__workers-types@4.20260621.1.patch`.
The patch is still needed for `@cloudflare/workers-types@4.20260621.1`: upstream
types return `never` when an RPC method returns a non-serializable nested object,
but v4 passes typed capability objects over Durable Object RPC. The patch changes
that fallback to `Promise<R & MaybeDisposable<R>>`, which keeps those capability
returns usable from generated stubs.

`pnpm-workspace.yaml` applies the patch through `patchedDependencies`, so run
`pnpm install` from the repository root after changing the patch or the
`@cloudflare/workers-types` version.
