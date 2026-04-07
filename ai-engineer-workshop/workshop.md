In this workshop we will build an AI agent entirely from scratch using only two ingredients:

1. An durable stream API that supports `.append({ path, event })` and `.subscribe({ path })`
2. Stream processors that implement the `.reduce` and `.afterAppend` methods

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

### Single turn

- Let's invent a new event type: `agent-input-added` with { content: string }
- Whenever that is appended, make an LLM request and append the response as a new event with type `agent-output-added` !

### With history

But problem:

- We don't send the history!
- So let's accumulate the history

But problem:

- When we don't rebuild a history when we first connect

### With history and catch up reads

- When we first connect, we can "catch up" to where we are in the stream

- If we're not careful, we will re-send LLM requests!

- So let's separate out the "building the history" from the side effect of "sending an LLM request"

## But how do we turn this into a proper agent?

-

# Workshop projects

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
