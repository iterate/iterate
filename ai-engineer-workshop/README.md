# AI engineer workshop

This directory is the publishable workshop package.

It intentionally does not contain the main workshop script collection anymore.
The real scripts live in the separate workshop repo, while this package keeps a
few tiny local examples and a scratch `script.ts` for experimentation.

- `sdk.ts` re-exports the shared runtime/client SDK from `apps/events-contract/src/sdk.ts`
- `sdk.ts` also re-exports the exact `defineProcessor()` helper from `apps/events/src/durable-objects/define-processor.ts`
- `sdk.ts` also exports lightweight network test helpers for workshop e2e tests
- `contract.ts` re-exports the shared contract from `apps/events-contract/src/index.ts`
- `cli.ts` runs workshop scripts from the current working directory
- `examples/` contains a few tiny runnable scripts for local messing around inside this repo

Local development:

```bash
cd ai-engineer-workshop
pnpm install
pnpm w --help
pnpm build
pnpm test:e2e
```

If you want to experiment from inside this repo, put scripts in:

- `ai-engineer-workshop/script.ts` for a single scratch file
- `ai-engineer-workshop/examples/...` for a few longer-lived examples

Those example files can import exactly the same way as the separate workshop repo:

```ts
import { createEventsClient, normalizePathPrefix, runWorkshopMain } from "ai-engineer-workshop";
```

For networked tests, the SDK also exports helpers that default to:

- `BASE_URL=https://events.iterate.com`
- `PROJECT_SLUG=public`

`createEventsClient()` now returns the raw oRPC client, so append calls use the
contract shape directly:

```ts
await client.append({
  path: streamPath,
  event: {
    type: "hello-world",
    payload: { message: "hello world" },
  },
});
```

Processors use the exact `defineProcessor()` helper from `apps/events`:

```ts
const processor = defineProcessor(() => ({
  slug: "hello-world",
  initialState: { seen: 0 },
  reduce: ({ event, state }) => (event.type === "hello-world" ? { seen: state.seen + 1 } : state),
  afterAppend: async ({ append, event, state }) => {
    if (event.type !== "hello-world" || state.seen !== 1) return;
    await append({ type: "hello-world-seen", payload: { sourceOffset: event.offset } });
  },
}));
```

For multi-stream workers, `PullSubscriptionPatternProcessorRuntime` watches `/`
for `child-stream-created` events, keeps discovery live, and spins up one
processor runtime per matching stream path, e.g. `/team/*` or `/team/**/*`.

That works because this directory is itself the `ai-engineer-workshop` package root, so package self-reference resolves correctly from files inside it.

Examples are discoverable via:

```bash
cd ai-engineer-workshop
pnpm w --help
pnpm w run --script examples/01-hello-world/append-hello-world.ts
pnpm w run --script examples/03-pattern-processor/prove-jonas-ping-pong.ts
pnpm w run --script examples/04-llm-codemode/run-llm-codemode-loop.ts
pnpm w run --script examples/05-slack-codemode/run-slack-codemode-loop.ts
```

Pattern-processor example:

- [examples/03-pattern-processor/jonas-ping-pong-processor.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/03-pattern-processor/jonas-ping-pong-processor.ts) watches `"/jonas/**/*"` and replies to every `ping` with a `pong`.
- [examples/03-pattern-processor/prove-jonas-ping-pong.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/03-pattern-processor/prove-jonas-ping-pong.ts) runs against a real local `apps/events` worker and asserts only matching `/jonas/...` streams get a derived `pong`.

LLM + codemode example:

- [examples/04-llm-codemode/coding-agent-system-prompt.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/04-llm-codemode/coding-agent-system-prompt.ts) builds the coding-agent prompt. It tells the model its agent path, gives a tiny explanation of the events system, and includes concrete `fetch()` examples for reading streams, appending events, and sending `llm-input-added` to another agent.
- [examples/04-llm-codemode/agent.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/04-llm-codemode/agent.ts) runs an OpenAI Responses API loop from `llm-input-added`, streams every OpenAI event back into the stream, cancels and restarts on newer input, and emits `codemode-block-added` when the assistant output contains `ts` blocks. Completion is recorded with `llm-request-completed`.
- [examples/04-llm-codemode/agent-types.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/04-llm-codemode/agent-types.ts) holds the agent event contracts and the event-to-prompt mirroring helpers.
- [examples/04-llm-codemode/codemode.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/04-llm-codemode/codemode.ts) is completely independent from the agent loop and only knows how to execute `codemode-block-added`. It writes `.codemode/<block-count>/code.ts`, compiles that file with `tsc`, runs the emitted JS, then appends `codemode-result-added`.
- [examples/04-llm-codemode/codemode-types.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/04-llm-codemode/codemode-types.ts) holds the codemode event contracts.
- [examples/04-llm-codemode/run-llm-codemode-loop.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/04-llm-codemode/run-llm-codemode-loop.ts) starts both processors against the same stream.
- [e2e/vitest/codemode-agent.test.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/e2e/vitest/codemode-agent.test.ts) is the proper Vitest network proof. It covers the cancel-and-restart loop and a second case where one agent sends `llm-input-added` to another agent over the events API.

Slack codemode example:

- [examples/05-slack-codemode/agent.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/05-slack-codemode/agent.ts) is the Slack-focused variant. It still uses the same LLM loop shape, but it mirrors `invalid-event-appended` into YAML prompt input and runs plain `gpt-5.4` with reasoning enabled.
- [examples/05-slack-codemode/coding-agent-system-prompt.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/05-slack-codemode/coding-agent-system-prompt.ts) tells the model to respond to Slack by emitting one `ts` block that POSTs to `response_url`.
- [examples/05-slack-codemode/codemode.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/05-slack-codemode/codemode.ts) keeps the codemode runner independent and writes artifacts under `.codemode/<stream-path>/<block-count>/`.
- [examples/05-slack-codemode/run-slack-codemode-loop.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/05-slack-codemode/run-slack-codemode-loop.ts) starts the Slack variant and prints a raw webhook example you can POST straight into the stream.
- [e2e/vitest/slack-codemode-agent.test.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/e2e/vitest/slack-codemode-agent.test.ts) proves the full flow against the deployed events service: raw Slack JSON becomes `invalid-event-appended`, the agent sees a YAML prompt, and two turns on the same stream produce a remembered Slack reply.

Published preview packages are built directly from this folder via `pkg.pr.new`.

The separate scripts repo lives at:

`/Users/jonastemplestein/src/github.com/iterate/ai-engineer-workshop`

That repo can either:

- depend on a `pkg.pr.new` preview of this package
- or override `ai-engineer-workshop` to a local link pointing at this folder during development
