# AI Engineer Workshop

Build an AI agent from two primitives:

1. Durable streams
2. Stream processors

---

# What it feels like

```bash
export PATH_PREFIX="/$(id -un)"
export BASE_URL="https://events.iterate.com"
export STREAM_PATH="${PATH_PREFIX}/hello-world"

curl --json '{"type":"hello-world"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

curl -N "${BASE_URL}/api/streams${STREAM_PATH}"
```

---

# The thesis

- A stream is just an append-only event log at a path like `"/jonas/agent-1"`.
- A processor is just code that reacts to events on a stream.
- Agents do not need a giant framework if these two pieces are solid.

---

# Agenda

1. Play with streams directly
2. Build tiny scripts
3. Add memory
4. Introduce a runtime
5. Handle interruptions
6. Add bashmode
7. Deploy processors

---

# Streams first

- Append JSON events
- Subscribe to history or live updates
- Read reduced state
- Keep everything path-addressable

```bash
curl --json '{"type":"hello-world"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"
```

---

# Nice stream features

- `idempotencyKey` prevents duplicate appends
- Pause and resume a stream
- JSONata transformers can derive new events
- Schedules can append future events
- Parent paths observe child-stream creation

---

# Hello world in script form

- Start with one stream
- One process
- One event type
- No runtime yet

The goal is to get comfortable with the raw API shape first.

---

# Ping pong

- Watch a stream
- If an event is `ping`, append `pong`
- This is the first "derived event" processor shape

That tiny loop is enough to explain the whole architecture.

---

# Simple LLM loop

- Introduce `agent-input-added`
- Call the OpenAI Responses API
- Mirror assistant output back into the stream
- Keep the stream as the source of truth

---

# Version 1: single turn

- One input event goes in
- One OpenAI request runs
- Output items come back as events
- No memory
- No catch-up

---

# Version 2: add history

- Keep a `history[]`
- Fold events into that history over time
- Turn "what should I send to the model?" into a reducer-shaped problem

This is the step where agent state starts feeling natural.

---

# Version 3: catch up from the start

- Read the full stream first
- Rebuild history from old events
- Then switch to `live: true`

This separates pure state reconstruction from side effects.

---

# Version 4: use a runtime

- Move state building into `reduce`
- Move OpenAI calls into `afterAppend`
- Use `defineProcessor(...)`
- Let `PullSubscriptionProcessorRuntime` handle catch-up

Now the code starts looking like a real durable agent.

---

# Version 5: interruptions

- Watch many paths, not just one
- Cancel in-flight requests when new input arrives
- Emit `llm-request-started`
- Emit `llm-request-completed`
- Emit `llm-request-canceled`

Interruptibility is where the agent stops feeling toy-like.

---

# Tests matter

- Non-deterministic tests are evals
- The interesting thing is behavior over time
- Streams make that behavior observable
- State + emitted events are both testable outputs

---

# Model selection and prompts

- Model choice can be an event
- System prompt can be an event
- Agents become configurable by appending data instead of editing code

That keeps configuration inside the same durable system.

---

# Bashmode

Add two events:

- `bashmode-block-added`
- `bashmode-result-added`

Flow:

1. Write shell to `.bashmode/...`
2. Run it with `bash`
3. Append the result back into the stream

---

# Why make bashmode separate?

- The agent processor should stay focused on LLM orchestration
- Bashmode is experimental and side-effect-heavy
- Let bashmode know how to feed results back into the agent

This keeps the system composable instead of monolithic.

---

# Agent to agent workflows

- Agents can append to each other's streams
- One agent can gather context
- Another can write code
- Another can run tools

The "single agent" is really a network of processors.

---

# Deployment

- Your laptop being on is not a deployment strategy
- Streams and processors can run in a deployed worker
- Dynamic workers let you push tiny processors close to the event system

---

# Tiny deployed processor

```ts
export default {
  slug: "ping-pong",
  async afterAppend({ append, event }) {
    if (event.type !== "ping") return;
    await append({ event: { type: "pong" } });
  },
};
```

---

# Other ideas

- Debounced inputs
- Retrieval / async context gathering
- Compaction
- Voice agents
- Multi-LLM workflows
- Bridges to Codex / Claude / OpenCode / others

---

# Processor tips

- The only interface is "append an event"
- Prefer appending new events over mutating old ones
- Expect races and interruptions
- Be careful about loops
- Keep secrets out of the stream

---

# In closing

- All you need are streams and stream processors
- An agent can be distributed across many programs
- Durable events make debugging and evolution much easier
