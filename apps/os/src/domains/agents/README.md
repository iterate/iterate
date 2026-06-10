# Agents Domain

Agents is the core OS agent runtime: the `AgentDurableObject`, the stream
processors it hosts, agent setup presets, and the subscription wiring that
attaches those processors to agent streams. The Slack flow (and every other
agent surface) runs through this domain.

## Files

- `durable-objects/agent-durable-object.ts` — `AgentDurableObject`, named
  `{ projectId, agentPath }`. Hosts the agent processors via
  `createStreamProcessorHost`, owns the codemode session for the stream, and
  registers tool providers (`ctx.slack`, `ctx.repos`, `ctx.gmail`, ...).
- `stream-processors/` — the processor contracts + implementations:
  - `agent/` — the agent core: inputs, outputs, LLM request lifecycle.
  - `agent-chat/` — chat ingress (web/tui channels) rendered into
    `agent/input-added` rows.
  - `agent-host/` — consumes `"*"`; OS-owned host side effects (waking the
    agent DO, child-agent init, codemode bridging).
  - `openai-ws/` / `cloudflare-ai/` — the two LLM providers; one is selected
    per agent via `events.iterate.com/os-agent/llm-provider-selected`
    (default `openai-ws`).
  - `jsonata-reactor/` — rule-driven event reactions.
- `agent-presets.ts` — default system prompt, agent setup events, path-prefix
  presets (e.g. Slack-specific prompts for `/agents/slack/...` paths).
- `agent-stream-subscriptions.ts` — structured DO name, default processor
  slugs per LLM provider, and the `stream/subscription-configured` events that
  attach the processors to an agent stream.
- `entrypoints/agent-capability.ts` — small codemode capability exposing
  `ctx.agents.create()`, which returns an RpcTarget handle for sending
  messages to a Durable Object-backed subagent.
