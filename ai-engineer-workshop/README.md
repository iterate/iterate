# AI engineer workshop

I was thinking the contents of this folder could maybe become a repo everyone plays in where

- each student (and each of us) have our own folder
- each student folder (or their subfolders) are npm packages
- they can import a lightweight sdk that is exported from apps/events directly. it includes
  - orpc client
  - shared components to make nice web UI renderers
  - any helper libraries e.g. to help people create a "stream processor" or to "discover all streams that start with /jonas/ and subscribe to them"

Something like that anyway :D The stuff in 01-hello-world is mostly vibe-slop

I think it might actually maybe be nice to structure the workshop "exercises" or "demos" or whatever using a trpc-cli based cli after all. You could have `pnpm cli` list out the available demonstrations to run and collect inputs etc - not sure it's worth the effort, though

With what we have here, we should already be able to make a basic codemode agent, for example

With the caveat that the stream processors are all _pulling_ from the streams. Tomorrow I'll make it possible for the streams to also _push_ to the processors that are deployed as serverless workers and then things really get interesting

## 02 — Basic LLM loop (`jonas/02-basic-llm-loop`)

Demonstrates URL-style event types on the events API, a live subscriber, and [TanStack AI](https://tanstack.com/ai) streaming: each chunk from `chat()` is appended back as `https://events.iterate.com/agent/output-item-added`.

**Prerequisites**

- `pnpm install` from the repo root
- Doppler project `ai-engineer-workshop` set up (see repo `doppler.yaml`) with `OPENAI_API_KEY` (copied from the `os` project or your own)
- From `ai-engineer-workshop/`: `doppler setup --project ai-engineer-workshop --config dev_jonas` (or your personal dev config)

**Run the subscriber** (needs network + API key):

```bash
cd ai-engineer-workshop/jonas
doppler run --project ai-engineer-workshop --config dev_jonas -- node 02-basic-llm-loop/run-llm-subscriber.ts
```

**In another terminal**, append a user message to the stream:

```bash
cd ai-engineer-workshop/jonas
node 02-basic-llm-loop/append-input-item.ts Your prompt here
```

Optional env: `BASE_URL`, `STREAM_PATH` (default `/jonas/basic-llm-loop`), `OPENAI_MODEL` (must be a supported OpenAI chat model name; default `gpt-4o-mini`).
