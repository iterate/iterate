# AI engineer workshop

This directory is the publishable workshop package.

It intentionally does not contain the main workshop script collection anymore.
The real scripts live in the separate workshop repo, while this package keeps a
few tiny local examples and a scratch `script.ts` for experimentation.

- `sdk.ts` re-exports the shared events SDK from `apps/events-contract/src/sdk.ts`
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

That works because this directory is itself the `ai-engineer-workshop` package root, so package self-reference resolves correctly from files inside it.

Examples are discoverable via:

```bash
cd ai-engineer-workshop
pnpm w --help
pnpm w run --script examples/01-hello-world/append-hello-world.ts
```

Published preview packages are built directly from this folder via `pkg.pr.new`.

The separate scripts repo lives at:

`/Users/jonastemplestein/src/github.com/iterate/ai-engineer-workshop`

That repo can either:

- depend on a `pkg.pr.new` preview of this package
- or override `ai-engineer-workshop` to a local link pointing at this folder during development
