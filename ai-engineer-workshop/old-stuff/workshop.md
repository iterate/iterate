In this workshop we will build an AI agent entirely from scratch using only two ingredients:

1. A durable stream API that supports `.append({ path, event })` and `.subscribe({ path })`

2. Stream processors that implement the `.reduce({ event, state })` and `.afterAppend({ append, event, state })` methods

Our AI agent will be

- Purely event sourced (aka "Debuggable")
- Extensible with good composability
- On the edge / publicly routable
- Distributed

# Playing with streams

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

# You should see a new "hogwash-received" event appear in the stream

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

# You can even schedule messages!

# Schedule a recurring heartbeat every 5 seconds
curl --json '{
  "type": "https://events.iterate.com/events/stream/append-scheduled",
  "payload": {
    "slug": "heartbeat-every-5s",
    "append": {
      "type": "heartbeat"
    },
    "schedule": {
      "kind": "every",
      "intervalSeconds": 5
    }
  }
}' "${BASE_URL}/api/streams${STREAM_PATH}"

# Tail it and you should see heartbeat events keep showing up
curl -N "${BASE_URL}/api/streams${STREAM_PATH}"

# Look at the state of the stream again
curl "${BASE_URL}/api/streams/__state${STREAM_PATH}" | jq .

# Stop the recurring schedule again
curl --json '{
  "type": "https://events.iterate.com/events/stream/schedule/cancelled",
  "payload": {
    "slug": "heartbeat-every-5s"
  }
}' "${BASE_URL}/api/streams${STREAM_PATH}"


# Receive webhooks when new events occur

# Use this disposable webhook.site inbox for the demo
# UI: https://webhook.site/aa6bf8b4-39ff-4807-a400-c21b37ee8e63
# Matching future events on this stream will now be POSTed to that webhook.site URL
curl --json '{
  "type": "https://events.iterate.com/events/stream/subscription/configured",
  "payload": {
    "slug": "webhook-site",
    "callbackUrl": "https://webhook.site/aa6bf8b4-39ff-4807-a400-c21b37ee8e63",
    "type": "webhook",
    "jsonataFilter": "type = \"webhook-demo\"",
    "jsonataTransform": "{\"kind\":\"webhook-demo\",\"message\":payload.message,\"streamPath\":streamPath,\"offset\":offset}"
  }
}' "${BASE_URL}/api/streams${STREAM_PATH}"

# Append a matching event and the transformed payload gets delivered to webhook.site
curl --json '{
  "type": "webhook-demo",
  "payload": {
    "message": "hello from iterate streams"
  }
}' "${BASE_URL}/api/streams${STREAM_PATH}"

# Fetch the latest transformed request body back from webhook.site over curl too
curl "https://webhook.site/token/aa6bf8b4-39ff-4807-a400-c21b37ee8e63/request/latest/raw"

# Webhook inbox UI for this example: https://webhook.site/aa6bf8b4-39ff-4807-a400-c21b37ee8e63


```

## Hello world in script form

Let's make a typescript version of the hello world script!

## Ping-pong script

Let's make a very rudimentary script. Any time somebody appends an event of type "ping", we append a "pong" event!

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
- `PullProcessorRuntime` with `includeChildren: false` gives us catch-up reads automatically for a single stream
- This is the first version that uses `defineProcessor`
- Workshop version: `workshop/agent-processor.ts` + `workshop/05-nano-agent-with-llm-processor.ts`

### All paths and interruptions

- In `05-all-paths-with-interruptions.ts`, we switch to `PullProcessorRuntime` with `includeChildren: true` (default)
- It watches every descendant stream under the given path
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

# Sequence of iterations

- ping / pong
- non-processor llm loop w/o memory
- non-processor llm loop w/ memory
- processor loop with memory
- processor loop with memory and interruptions and queued messages

- let's add bashmode!

Problem: My computer isn't always on!

# Deployments

```bash

# Append a tiny dynamic worker that replies "pong" to every "ping"
export DYNAMIC_WORKER="$(cat <<'EOF'
export default {
  slug: "ping-pong",
  initialState: {},
  reduce({ state }) {
    return state;
  },
  async afterAppend({ append, event }) {
    if (event.type !== "ping") return;
    await append({ event: { type: "pong" } });
  },
};
EOF

)"

curl --json "$(jq -nc --arg script "$DYNAMIC_WORKER" '{
  type: "https://events.iterate.com/events/stream/dynamic-worker/configured",
  payload: {
    slug: "ping-pong",
    script: $script
  }
}')" "${BASE_URL}/api/streams${STREAM_PATH}"

# Now append ping and the stream suddenly ping-pongs
curl --json '{"type": "ping"}' \
  "${BASE_URL}/api/streams${STREAM_PATH}"

# Watch the stream and you'll see the derived pong event
curl -N "${BASE_URL}/api/streams${STREAM_PATH}"

```

# Fun things we can easily build now

- Add events for model and system prompt setting
- Debounce inputs so repeated inputs don't interrupt the LLM over and over
- Collect prompt context from "context providers" (e.g. RAG from knowledge bases) for some period of time before making each LLM request
- Image / attachment event types
- Opencode / pi bridge - we could have a processor that sits between an opencode agent and e.g. a pi or opencode session - so we could speak to all these agent harnesses using a single _input_ interface
- Different compaction strategies
- Multi LLM agent (via tanstack AI or vercel AI sdk for example)
- Allow agents to have multple multiple LLM requests in flight at the same time
  - ... for safety - run a prompt injection protector in parallel
  - ... or to allow "sidebar" conversations
- Proper codemode - add new tools via events!
