# Intercepted models

`intercepted/*` models are never dialed to a real provider. They are served by
a live handler — a function in YOUR process, installed with
`itx.ai.intercept(handler)` and reached back over your itx connection. Free,
deterministic, identical in every environment: the whole agent loop runs for
real (debounce, journaled llm-request events, chunk streaming, codemode, chat
reply); only the model is scripted. Non-fake models are never interceptable —
a journaled `openai/*` turn is always the real provider.

When testing provider-specific preparation, name the provider/model explicitly, for example
`intercepted/openai/gpt-4.1-nano` or `intercepted/@cf/meta/llama-3.2-1b-instruct`.
The prefix is stripped before request preparation; the configured transport
still chooses BYOK versus Cloudflare billing. Interception does not choose the provider.
For provider-independent tests, synthetic names such as `intercepted/echo-args`
are sufficient; they use generic Workers AI preparation without calling a provider.

## Quick start

```ts
import { connectItxReady } from "iterate/node";

using session = await connectItxReady({
  auth: { type: "admin-secret", secret: ADMIN_SECRET },
  baseUrl: BASE_URL,
});
using project = session.projects.get("my-project");

// Replace only provider dispatch, after host request preparation.
using interception = await project.ai.intercept((call) =>
  Response.json(
    call.source === "ai-run"
      ? { echo: call.request.body }
      : { choices: [{ message: { content: "scripted reply" } }] },
  ),
);

// Direct invocation path:
await project.ai.run("intercepted/anything", { prompt: "hi" });

// Agent-turn path: point an agent at an intercepted/* model, then chat with it.
using agent = project.agents.get("/agents/scripted");
await agent.create();
await agent.append({
  type: "events.iterate.com/agent/configured",
  payload: { config: { llm: { model: "intercepted/scripted" } } },
});
await agent.ask({ message: "hello" });

await interception.release(); // or let `using` dispose it
```

Handlers receive `source` (`agent-turn` or `ai-run`), the original
`model`, and a completed `request` with one of two shapes:

- `kind: "openai-http"`: gateway ID, endpoint, body, and headers.
- `kind: "workers-ai"`: model, body, and binding options.

Agent calls also carry `agentPath`. Credentials are excluded from both shapes.
The sender does not change the prepared body or choose a provider from the model name.

Return a `Response`, synchronously or from a promise. Use `Response.json(value)`
for JSON, or `new Response(stream, { headers: { "content-type": "text/event-stream" } })`
for SSE. Streams carry bytes (`ReadableStream<Uint8Array>`); chunks flow through
the normal decoder as they arrive. Return an unused, unlocked body. Invalid
responses and stream failures fail the attempt. There is one intercepted namespace and
one request preparation path.

Tests can use `aiTextResponse(textOrUsage, call)` from
`@iterate-com/test-support`. Text/usage estimates live in that test
helper; production interception always consumes a provider-shaped response.

## The lifetime contract

`intercept(handler)` is sugar over the capability machinery: your handler
mounts as a LIVE capability at the project root's `aiInterceptor` path,
behind the shipped hibernating Capability Provider Pager — so interception
has exactly the lifecycle every live capability mount has, the **mount
invariant** included: while your session socket is open, your interceptor is
installed. Every way of losing it is accounted for:

- **Platform churn** (a Durable Object restart — deploys, eviction; routine
  on cold preview deployments): the mount's Pager dies with the platform's
  half, and your session is closed with code **4901** (the pager-lost close:
  "live mounts lost; reconnect and connect() again"). Never silent.
- **Your session dies** (isolate churn, network): the mount is retired;
  intercepted calls fail loudly with `No AI interceptor installed` instead of
  hanging on a broken stub.
- **You release**, or a newer `intercept()` supersedes yours (last writer
  wins — provide-at-same-path replaces): deliberate, silent — no 4901, your
  session stays up. Handles are offset-keyed, so releasing a superseded
  handle can never evict the newer interceptor.

Two consequences of being a real mount, on purpose: the interceptor shows up
in the root scope's `__describe` like any capability, and any capability
provider — a config worker included — can mount `aiInterceptor` and serve
intercepted/\* models durably, with no client session at all. That last one is
the growth path to custom model providers; the namespace rule is unchanged
either way (real-model names are never interceptable).

So the client obligation is one loop: **reconnect on close, `intercept()`
again**. An in-flight agent turn survives the gap on its own retries
(3 attempts, 10s/20s backoff) as long as you re-install within ~30s.

## Recovery recipes

**Playwright specs** — use the fixture; it owns the loop on a connection
dedicated to the interception:

```ts
await using fixture = await helpers.createFixture("my-spec");
await using interception = await fixture.interceptAi(async (call) => aiTextResponse("reply", call));
```

(`fixture.interceptAi` wraps
[installResilientAiInterceptor](../packages/shared/src/test-support/resilient-ai-interceptor.ts);
real usage: [agent-fake-model-chat.spec.ts](../specs/agent-fake-model-chat.spec.ts).)

**Plain node** — the node client is deliberately vanilla and never reconnects
itself; hang the loop off `onWebSocketClose`:

```ts
async function keepIntercepting(handler) {
  const session = await connectItxReady({
    auth,
    baseUrl,
    onWebSocketClose: () => setTimeout(() => keepIntercepting(handler), 500),
  });
  await session.projects.get(projectId).ai.intercept(handler);
}
```

**e2e-level API proof**:
[ai-intercept.itx.e2e.test.ts](../apps/os/e2e/vitest/ai-intercept.itx.e2e.test.ts)
exercises install, release, the 4901 close on a real DO restart, and
supersession.

## HTTP response fixtures

Use any `intercepted/*` model with an HTTP fixture. The same handler can return
streamed success or an HTTP failure. HTTP failures use the existing bounded agent failure policy.

Direct `ai.run` retains the Workers AI binding's decoding rules: exactly
`application/json` is decoded; other content types return a body stream.
`returnRawResponse: true` returns the response even for HTTP errors. Decoded
HTTP failures now throw an error with the status and response-body excerpt,
rather than the binding's private `InferenceUpstreamError` class.
