# Intercepted models

`intercepted/*` models are never dialed to a real provider. They are served by
a live handler — a function in YOUR process, installed with
`itx.ai.intercept(handler)` and reached back over your itx connection. Free,
deterministic, identical in every environment: the whole agent loop runs for
real (debounce, journaled llm-request events, chunk streaming, codemode, chat
reply); only the model is scripted. Non-fake models are never interceptable —
a journaled `openai/*` turn is always the real provider.

## Quick start

```ts
import { connectItxReady } from "iterate/node";

using session = await connectItxReady({
  auth: { type: "admin-secret", secret: ADMIN_SECRET },
  baseUrl: BASE_URL,
});
using project = session.projects.get("my-project");

// Serve every intercepted/* call with your function. Last writer wins.
using interception = await project.ai.intercept(async (call) => {
  if (call.source === "ai-run") return { echo: call.body }; // returned verbatim
  // call.source === "agent-turn": call.body.messages is the chat projection.
  // Return assistant text — or { text, usage } to also script token usage
  // (inflate the numbers to drive compaction deterministically).
  return "scripted reply";
});

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

Handler input is
`{ source: "agent-turn" | "ai-run", model, body }`
([model-interception.ts](../apps/os/src/lib/model-interception.ts) has the
exact types; they're also exported from `iterate/node` as
`ProjectAiInterceptor` / `ProjectAiInterceptorInput`). A malformed agent-turn
result fails the attempt loudly; omitted usage gets a text-length estimate.

## The lifetime contract

Interception is live and session-bound, with the same **mount invariant**
live capability mounts have: while your session socket is open, your
interceptor is installed. The registration rides an internal liveness
WebSocket whose lifetime is the Project Durable Object incarnation's
([interceptor-liveness.ts](../apps/os/src/domains/projects/interceptor-liveness.ts)),
so every way of losing it is accounted for:

- **Platform churn** (DO restart — deploys, eviction; routine on cold preview
  deployments): your session is closed with code **4901**, reason
  `project AI interceptor lost … reconnect and intercept() again`. Never
  silent.
- **Your session dies** (isolate churn, network): the platform releases the
  registration; intercepted calls fail loudly with
  `No AI interceptor installed` instead of hanging on a broken stub.
- **You release**, or a newer `intercept()` supersedes yours (last writer
  wins): deliberate, silent — no 4901, your session stays up.

So the client obligation is one loop: **reconnect on close, `intercept()`
again**. An in-flight agent turn survives the gap on its own retries
(3 attempts, 10s/20s backoff) as long as you re-install within ~30s.

## Recovery recipes

**Playwright specs** — use the fixture; it owns the loop on a connection
dedicated to the interception:

```ts
await using fixture = await helpers.createFixture("my-spec");
await using interception = await fixture.interceptAi(async (call) => "reply");
```

(`fixture.interceptAi` wraps
[installResilientAiInterceptor](../specs/test-support/resilient-ai-interceptor.ts);
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
