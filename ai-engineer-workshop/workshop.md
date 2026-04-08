NOTE TO AI AGENTS: We're working on this file together - please don't change anything unless I explicitly ask you to. But please do propose improvements and changes and flag with me where things could be homogenized.

For context: This is the outline of an interactive workshop I'm giving at the AI Engineer Conference. I will walk people through this step by step and will try to write the code from scratch

-- snip --

WIP thoughts
High level outline

- What I'm about to tell you
- Introduction to streams
-

In this workshop we will build an AI agent entirely from scratch using only two ingredients:

1. A durable stream API that supports `.append({ path, event })` and `.subscribe({ path })`
2. Stream processors that implement the `.reduce` and `.afterAppend` methods

This is all very prototype level code, but I hope the _ideas_ come across. We're all just reducing over event streams!

## 1. Playing with streams

We made a simple durable streams server at https://events.iterate.com for this workshop. Let's [look at the docs](https://events.iterate.com/api/docs)!

**WARNING: There is no authentication on this server, so please don't stick any secrets in your streams.**

Here's how you use them:

```bash

# Like files, a "stream" is identified by a "path" that starts with a slash
# Let's give ourselves a unique path prefix so we don't collide with other people
# My prefix will be /jonastemplestein
export PATH_PREFIX="/$(id -un)"
export BASE_URL="https://events.iterate.com"
export STREAM_PATH="${PATH_PREFIX}/hello-world"

# Let's create our first event
curl --json '{"type": "hello-world"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# Let's see if it's there
curl -N "${BASE_URL}/api/streams${STREAM_PATH}"

# Look, streams are created implicitly and stream creation events propagate up
curl -N "${BASE_URL}/api/streams/


# We can also live tail the stream with pretty printing (start this in a new tab)
curl -sN "${BASE_URL}/api/streams${STREAM_PATH}?live=true" | sed -nu 's/^data: //p' | jq .

# Can also append hogwash!
curl --json '{"hogwash": "yes!"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# Use an idempotency key to prevent duplicate appends - run this twice!
curl --json '{"type": "hello-world", "idempotencyKey": "boop"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# You can get the "reduced state" of a stream
curl "${BASE_URL}/api/streams/__state${STREAM_PATH}" | jq .


# It can also do weird things!

# Configure a JSONata transformer: any event with hogwash in it
# gets transformed into a "hogwash-received" event
curl --json '{
  "type": "https://events.iterate.com/events/stream/jsonata-transformer-configured",
  "payload": {
    "slug": "hogwash-transformer",
    "matcher": "payload.rawInput.hogwash",
    "transform": "{\"type\": \"hogwash-received\"}"
  }
}' "${BASE_URL}/api/streams${STREAM_PATH}"

# Now try appending hogwash again!
curl --json '{"hogwash": "yes!e"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"


# You should see a new "hogwash-received" event appear in the stream



# It can do some weird things  (maybe)

# You can pause a stream!
curl -s --json '{"type":"https://events.iterate.com/events/stream/paused"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}" | jq .

# check the state - it should show paused: true
curl -s "${BASE_URL}/api/streams/__state${STREAM_PATH}" | jq .

# try to append something - you'll get an error!
curl --json '{"type": "hello-world"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# unpause
curl --json '{"type":"https://events.iterate.com/events/stream/resumed"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# now appending works again
curl --json '{"type": "hello-world"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# - send filtered and transformed webhooks to arbitrary endpoints

# - schedule messages

```

Some notes / observations:

- Paths start with a slash!
- Events are JSON objects with a `type` and optional `payload` property
- Use `idempotencyKey` to ensure you don't append the same event twice
- Server assigns monotonically increasing `offset` and `createdAt` to each event
- There's a web UI at https://events.iterate.com/

## Hello world in script form

- Let's make a typescript version of the hello world script!

## Ping-pong script

Let's make a very rudimentary script. Any time somebody appends an event of type "ping", we append a "pong" event!

## A simple LLM loop

See `examples/simple-openai-loop/`

- `01-single-path-script.ts`
- `02-single-path-with-history.ts`
- `03-single-path-with-catch-up.ts`
- `04-single-stream-runtime.ts`
- `05-all-paths-with-interruptions.ts`
- Live-coding versions: `workshop/02-nano-agent.ts`, `workshop/03-nano-agent-with-history.ts`, `workshop/04-nano-agent-with-persistent-history.ts`, `workshop/05-nano-agent-with-llm-processor.ts`
- Structure these workshop versions so `updateHistoryFromEvent()` feels like the obvious precursor to a reducer

### Single turn

- We define an `agent-input-added` event with `{ content: string }`
- Whenever one is appended, we call the OpenAI Responses API and append each assistant output item as `openai-output-item-added`
- Start with `01-single-path-script.ts`
- It is just a script on one path
- No `defineProcessor`
- No runtime

### With history

Problem:

- We don't send the history!

Solution:

- In `02-single-path-with-history.ts`, we make a `history[]` variable and add to it over time
- In the workshop version, `updateHistoryFromEvent()` is a tiny reducer-shaped helper over `agent-input-added` and `openai-output-item-added`

### With history from start

Problem:

- When we connect, we don't catch up the history

Solution:

- In `03-single-path-with-catch-up.ts`, we first read the full stream history and then switch to `live: true`

Problem:

- Need to refactor to split "history building" from "side effects" (sending LLM requests)

### Now with a runtime

- In `04-single-stream-runtime.ts`, we move history building into `reduce`
- We move the OpenAI call into `afterAppend`
- `PullSubscriptionProcessorRuntime` gives us catch-up reads automatically for a single stream
- This is the first version that uses `defineProcessor`
- Workshop version: `workshop/agent-processor.ts` + `workshop/05-nano-agent-with-llm-processor.ts`

### All paths and interruptions

- In `05-all-paths-with-interruptions.ts`, we switch to `PullSubscriptionPatternProcessorRuntime`
- It watches every stream under `${PATH_PREFIX}/**`
- We add `llm-request-started`, `llm-request-completed`, and `llm-request-canceled`
- When a new input arrives on a stream, we abort the previous request for that stream and start a new one
- This is the first version that handles interruptions

# Now let's add some tests! V important!

- Tests of non-deterministic code are called evals
-

# Now let's add model selection

- add an event type

# Now let's add system prompt setting

- add an event type

# Let's have some fun

- Can this thing already respond to slack messages? We can use the invalid event event to support arbitrary webhooks!

## bashmode

Let's make a new file called bashmode-processor.ts

Let's invent two new event types:

- `bashmode-block-added` with `{ content: string }`
- `bashmode-result-added` with `{ content: string }`

When codemode block added is encountered, write the contents to a file in `.bashmode/[block-count].sh`

Then run the code with `bash` and capture the output in `.bashmode/[block-count]-out.txt`

Now we want to show this to our LLM agent and need to decide does the agent processor know about bashmode or vice versa?

Since bashmode is more experimental, let's make it know about the agent processor.

In afterAppend, we'll say "if we have a bashmode-result-added event, let's create an agent-input-added event with the contents of the result!"

### Let's write some tests or evals for this!

- Agents should be able to message each other!
- Agents should be able to code, sort of!

Now we should be able to

- spawn sub-agents and send messages back and forth - let's try that - we can write a test for it
-

# Maybe: let's make the UI nice!

# Maybe: how do we deploy this?

Problem: My computer isn't always on!

# Maybe scheduled execution

# Workshop projects

### Add model selection to openai example

### Debouncing your inputs

### Asynchronous context gathering (e.g. RAG from knowledge bases)

Goal: Allow processors to contribute additional context before an LLM request

Implementation sketch:

- Debounce LLM requests by e.g. 200ms
- Any processor can now listen for "LLM request triggered" events or something like that

### "Inheritable event" processor

Add an event that says "I want this event to be inherited by all child streams when they are created"

This can be implemented as a lightweight processor + event with `{ type: "inheritable-event-added", payload: { ... event ... }}`

### Compaction

All manner of compaction strategies can be implemented as processors. You could e.g. do this:

In agents processor

- add `history-reset` event with payload `{ history: [ ... ] }` to agent processor with simple reducer that sets the history to whatever is in the payload

In new "my-compaction" processor:

- add `compaction-triggered` event to trigger a compaction (manually or when some condition is met)
- in `afterAppend` hook make an LLM request to summarize the history up to that point however you please

### Images

### Voice agent

The events API has a websocket endpoint specifically so we could use it as backend for openai or grok realtime voice agents!

### Multi-LLM agent

Use tanstack AI or vercel AI or whatever you like to

### Opencode / pi / claude / codex / whatever bridge

Build a processor that sits between opencode / pi / claude / codex / or whatever other coding agent you use. It

1. consumes input item events from the iterate stream and forwards on to agents
2. consumes events from other harness sessions and sticks them into iterate streams

You can then easily build a conductor-style UI on top.

### Queued messages and interruptions

Goal: Allow people to queue up messages before an LLM request is sent.

- Add "interruptionBehavior" property to LLM input event type. Could e.g. be "queue" or "interrupt"
- Add `queuedInputItems` array to state
- In reducer: when encountering an input event without "interrupt
-

### Workflow codemode!

###

# What is bad about this?

- Loop detection is a PITA

# Processor skill

Stream processors consist of

1. A slug - this is the unique, URL-safe slug that identifies the processor
2. (Optional) new event types
3. (Optional) an initial state and associated schema/type
4. (Optional) a synchronous `reducer`
5. (Optional) an asynchronous `afterAppend` hook

### Examples

### Tips

- The only way to interact with your processor is by appending an event!
- To make sure your processor survives crashes and restarts, you should
- Don't try to "transform" events - that is deliberately not possible. Instead, just append a new event.
- Embrace the distributed chaos. It's totally fine to say "I will wait up to 100ms before enacting my side effect to see if any other processor wants to stop me".
- Be mindful of loops. the downside of distributed chaos is that you can easily create loops between processors who are pooping back and forth endlessly forever.
- Be mindful of race conditions. Another downside of distributed chaos is that there are lots of race conditions.
- Secrets should never be stored in events. There is a _very_ rudimentary secrets system in the events API for that reason.

# TODO

- AGENTS.md file

# The end

Remember

- All you need are streams and stream processors
- Your agent can be distributed across many programs

Stuff I want to play with

- Can I prompt an agent to actually self-debug and self-improve?
- "Workflow codemode"
- What if you could charge for agent plugins?
-
