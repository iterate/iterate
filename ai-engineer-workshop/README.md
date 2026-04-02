# AI engineer workshop

This directory is the publishable workshop package.

It intentionally does not contain workshop scripts anymore.

- `sdk.ts` re-exports the shared events SDK from `apps/events-contract/src/sdk.ts`
- `contract.ts` re-exports the shared contract from `apps/events-contract/src/index.ts`
- `cli.ts` runs workshop scripts from the current working directory

Local development:

```bash
cd ai-engineer-workshop
pnpm install
pnpm w --help
pnpm build
```

Published preview packages are built directly from this folder via `pkg.pr.new`.

The separate scripts repo lives at:

`/Users/jonastemplestein/src/github.com/iterate/ai-engineer-workshop`

That repo can either:

- depend on a `pkg.pr.new` preview of this package
- or override `ai-engineer-workshop` to a local link pointing at this folder during development
