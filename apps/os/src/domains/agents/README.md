# Agents Domain

Agents is the core OS agent runtime: the `AgentDurableObject`, the stream
processors it hosts, and the subscription wiring that attaches those processors
to agent streams. For now, default agent setup lives in the platform
`ProjectProcessor`: it watches root-stream `stream/child-stream-created` facts
and appends setup/subscription facts to matching `/agents/...` streams.

## Files

- `durable-objects/agent-durable-object.ts` — `AgentDurableObject`, named
  `{ projectId, agentPath }`. Hosts the agent processors via
  `createStreamProcessorHost`, owns the agent-local itx context for the stream,
  and registers agent capabilities (`itx.slack` or `itx.chat`, `itx.debug`,
  `itx.ai`, `itx.gmail`, `itx.agents`, `itx.workspace`). Project defaults such
  as `itx.repos` are provided by the platform project context.
- `stream-processors/` — the processor contracts + implementations:
  - `agent/` — the agent core: chat ingress, inputs, outputs, script
    enqueue/completion rendering, and LLM request lifecycle.
  - `openai-ws/` / `cloudflare-ai/` — the two LLM providers; one is selected
    per agent via `events.iterate.com/os-agent/llm-provider-selected`
    (default `openai-ws`).
  - `jsonata-reactor/` — rule-driven event reactions.
- `agent-stream-subscriptions.ts` — structured DO name, default processor
  slugs per LLM provider, and the `stream/subscription-configured` events that
  attach the processors to an agent stream.
- `entrypoints/agent-capability.ts` — small itx capability exposing
  `itx.agents.create()`, which returns an RpcTarget handle for sending
  messages to a Durable Object-backed subagent.
