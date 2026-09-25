# Config repository templates

Project creation copies a template's files into a new `/repos/config` repository. The project owns
that copy: later template changes never overwrite it. The public GitHub reference parser and
downloader live in `packages/shared/src/config-repo-template`.

- `default/` — minimal homepage and instructions; no agent runtime or subscriptions.
- `with-agents/` — homepage plus the optional agents app, installed on `project/created`.

A template must contain `worker.ts`, the main module. It and the files it imports may be TypeScript
or JavaScript, and import packages by name as listed in `package.json` (`iterate/*` and `zod` come
from the platform). The worker extends `ConfigWorker` from `iterate/sdk` and reaches the project
through `this.withItx((itx) => …)`, which releases everything the call reached; lint refuses a raw
`env.ITX.get()` (`iterate/no-raw-itx-get`). Optional `iterate.json` declares an `events` array; the
platform subscribes the config worker's `processEventBatch(events, range)` before emitting
`project/created`, and `ConfigWorker` hands each event to `processEvent({ event, itx })`.
Templates without that manifest have no lifecycle subscription.

Templates are type-checkable as they stand: `package.json` lists only devDependencies — the SDK's
types from `https://pkg.pr.new/iterate/iterate/iterate@main`, `@cloudflare/workers-types` and
`typescript` — so `npm install && npx tsc` checks a project's checkout, while the loader links the
running platform's SDK (an `iterate` absent from `dependencies` is the platform's). In this repo,
`pnpm typecheck:configs` checks both templates against the workspace SDK.

`session.projects.templates()` lists presets. `projects.create({ project, configRepoTemplate })`
also accepts custom references such as `github:owner/repo#main&path:templates/example`. The API
resolves the ref to a commit before persisting the creation request. Omit it for the minimal seed.

The build generates preset references using the repository commit.
That commit must be available on GitHub and contain these folders before preset cloning can work.
The minimal seed is embedded in the platform build and needs no GitHub request.
