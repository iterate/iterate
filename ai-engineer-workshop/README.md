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

Demonstrates a tiny event-driven LLM loop with [TanStack AI](https://tanstack.com/ai): one subscriber watches a stream for `https://events.iterate.com/agent/input-item-added`, runs `chat()`, appends each streamed chunk back as `https://events.iterate.com/agent/output-item-added`, and then appends the completed assistant reply as another `input-item-added` event.

**Prerequisites**

- `pnpm install` from the repo root
- Doppler project `ai-engineer-workshop` set up (see repo `doppler.yaml`) with `OPENAI_API_KEY` (copied from the `os` project or your own)
- From `ai-engineer-workshop/`: `doppler setup --project ai-engineer-workshop --config dev_jonas` (or your personal dev config)

**Run the subscriber** (needs network + API key):

Use cwd `ai-engineer-workshop/jonas` (not the monorepo root, and not inside `02-basic-llm-loop/`). That directory is still under the `ai-engineer-workshop/` path in repo `doppler.yaml`, so Doppler resolves the `ai-engineer-workshop` project the same way as if you had `cd`’d from the repo root.

```bash
cd ai-engineer-workshop/jonas
doppler run --project ai-engineer-workshop --config dev_jonas -- pnpm tsx 02-basic-llm-loop/run-llm-subscriber.ts
```

That script prints:

- the exact browser URL to open
- a JSON event you can paste into the stream page input

If `STREAM_PATH` is not set in the **process environment**, it generates a fresh stream path like `/jonas/02/a1b2c3d4` for that run. (A value exported in your shell still counts — `printenv STREAM_PATH`. The `ai-engineer-workshop` Doppler config does not set it.)

So the whole demo can be:

1. Start the subscriber in one terminal.
2. Open the URL printed by the script in your browser.
3. Paste an event like this into the input at the bottom of the page:

```json
{
  "path": "/jonas/02/<random-short-string>",
  "type": "https://events.iterate.com/agent/input-item-added",
  "payload": {
    "item": {
      "role": "user",
      "content": "Say hello in one short sentence."
    }
  }
}
```

4. Submit it and literally watch it happen in the stream feed: the input event lands, the subscriber sees it, the LLM appends raw output chunk events back into the same stream, and then it appends one finalized assistant message event.
5. Keep posting more `input-item-added` events into that same stream if you want a back-and-forth conversation. The subscriber rebuilds history from those finalized message events and only uses the raw chunk events for live rendering/debugging.

Optional env: `BASE_URL`, `STREAM_PATH` (otherwise defaults to `/jonas/02/<random-hex>`), `OPENAI_MODEL` (must be a supported OpenAI chat model name; default `gpt-4o-mini`).
