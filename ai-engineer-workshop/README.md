# AI engineer workshop

This directory is the publishable workshop package.

It intentionally does not contain the main workshop script collection anymore.
The real scripts live in the separate workshop repo, while this package keeps a
few tiny local examples and a scratch `script.ts` for experimentation.

- `sdk.ts` re-exports the shared runtime/client SDK from `apps/events-contract/src/sdk.ts`
- `sdk.ts` also re-exports the exact `defineProcessor()` helper from `apps/events/src/durable-objects/define-processor.ts`
- `contract.ts` re-exports the shared contract from `apps/events-contract/src/index.ts`
- `cli.ts` runs workshop scripts from the current working directory
- `examples/` contains a few tiny runnable scripts for local messing around inside this repo

Local development:

```bash
cd ai-engineer-workshop
pnpm install
pnpm w --help
pnpm build
```

If you want to experiment from inside this repo, put scripts in:

- `ai-engineer-workshop/script.ts` for a single scratch file
- `ai-engineer-workshop/examples/...` for a few longer-lived examples

Those example files can import exactly the same way as the separate workshop repo:

```ts
import { createEventsClient, normalizePathPrefix, runWorkshopMain } from "ai-engineer-workshop";
```

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
```

Pattern-processor example:

- [examples/03-pattern-processor/jonas-ping-pong-processor.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/03-pattern-processor/jonas-ping-pong-processor.ts) watches `"/jonas/**/*"` and replies to every `ping` with a `pong`.
- [examples/03-pattern-processor/prove-jonas-ping-pong.ts](/Users/jonastemplestein/.superset/worktrees/iterate/wary-ermine/ai-engineer-workshop/examples/03-pattern-processor/prove-jonas-ping-pong.ts) runs against a real local `apps/events` worker and asserts only matching `/jonas/...` streams get a derived `pong`.

Published preview packages are built directly from this folder via `pkg.pr.new`.

The separate scripts repo lives at:

`/Users/jonastemplestein/src/github.com/iterate/ai-engineer-workshop`

That repo can either:

- depend on a `pkg.pr.new` preview of this package
- or override `ai-engineer-workshop` to a local link pointing at this folder during development
