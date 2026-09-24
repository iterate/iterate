# Config repository templates

Project creation copies a template's files into a new `/repos/config` repository. The project owns
that copy: later template changes never overwrite it. The public GitHub reference parser and
downloader live in `packages/shared/src/config-repo-template`.

- `default/` — minimal homepage and instructions; no agent runtime or subscriptions.
- `with-agents/` — homepage plus the optional agents app, installed on `project/created`.

A template must contain `worker.ts`, executable JavaScript despite its extension. Its sibling `.js`
files are available as worker modules. Optional `iterate.json` declares an `events` array; the
platform subscribes the config worker's `processEventBatch(events, range)` before emitting
`project/created`. Templates without that manifest have no lifecycle subscription.

`session.projects.templates()` lists presets. `projects.create({ project, configRepoTemplate })`
also accepts custom references such as `github:owner/repo#main&path:templates/example`. The API
resolves the ref to a commit before persisting the creation request. Omit it for the minimal seed.

The build generates preset references using the repository commit, or `ITERATE_TEMPLATE_SOURCE_REF`.
That commit must be available on GitHub and contain these folders before preset cloning can work.
The minimal seed is embedded in the platform build and needs no GitHub request.

Rebuild `with-agents/agents.js` using `pnpm --dir apps/agents runtime:build` after runtime changes.
This generated file belongs to the template, never the platform's executable bundle.
