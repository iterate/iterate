In this workshop we will build an AI agent entirely from scratch using only two ingredients:

1. An durable stream API that supports `.append({ path, event })` and `.subscribe({ path })`
2. Stream processors that implement the `.reduce` and `.afterAppend` methods

This is all very prototype level code, but I hope the _ideas_ come across. We're all just reducing over event streams!

## 1. Streams

We made a simple durable streams server at https://events.iterate.com for this workshop. Let's [look at the docs](https://events.iterate.com/api/docs)!

**WARNING: There is no authentication on this server, so please don't stick any secrets in your streams.**

Let's play with this together!

```bash

# Streams are structured into paths. Let's give ourselves a unique path prefix
# My prefix will be /jonastemplestein - paths start with a slash!
export PATH_PREFIX="/$(id -un)"
export BASE_URL="https://events.iterate.com"
export STREAM_PATH="${PATH_PREFIX}/hello-world"

# Let's create our first event
curl --json '{"type": "hello-world"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# Let's see if it's there
curl -N "${BASE_URL}/api/streams${STREAM_PATH}"

# We can also live tail the stream
# With pretty printing
curl -sN "${BASE_URL}/api/streams${STREAM_PATH}?live=true" | sed -nu 's/^data: //p' | jq .
```

Now let's in another tab append another event

```bash
curl --json '{"type": "hello-world"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# Can also append hogwash!
curl --json '{"hogwash": "yes!"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"


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

- Let's make a script where if anyone appends a `type: ping` event, we append a `type: pong` event!

## A simple LLM loop

See `examples/simple-openai-loop/`

- `01-single-path-script.ts`
- `02-single-path-with-history.ts`
- `03-single-path-with-catch-up.ts`
- `04-single-stream-runtime.ts`
- `05-all-paths-with-interruptions.ts`

### Single turn

- We define an `llm-input-added` event with `{ content: string }`
- Whenever one is appended, we call the OpenAI Responses API and append the response as `llm-output-added` with `{ content: string }`
- Start with `01-single-path-script.ts`
- It is just a script on one path
- No `defineProcessor`
- No runtime

### With history

Problem:

- We don't send the history!

Solution:

- In `02-single-path-with-history.ts`, we make a `history[]` variable and add to it over time

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

###

# What is bad about this?

- Loop detection is a PITA

# Workshop CLI should

1. Take script and "path pattern" to hook up to as input
2.
