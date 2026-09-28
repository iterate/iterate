# Docs

A project's docs: markdown files in the project's `/repos/docs`, written in the browser. Served
like [Notes](../notes/README.md): a project's config worker ([config-worker.ts](config-worker.ts))
serves the `docs` routing slug, so `docs--<project>.iterate.app` under subdomains and
`<platform>/projects/<project>/docs/` under paths, and fetches through to this Worker
(`docsEnvs` in the root `envs.ts`). The page signs in on its host's `/.auth/*` and talks to its
host's `/api`, both the platform's; Docs has no OAuth client, no secrets and no state of its own.
The base path handling is Notes', shared in
[packages/ui/src/apps/base-path.ts](../../packages/ui/src/apps/base-path.ts).

- `/projects/<slug>` lists every `.md` in `/repos/docs` (creating the repo on first visit) and
  starts new docs.
- `/projects/<slug>/<path>` edits one: CodeMirror over the file's markdown with Atomic's live
  preview (`@atomic-editor/editor`), a formatting bar, Cmd/Ctrl-B, -I, -E, -K and -Shift-X, and a
  Rich / Markdown switch that turns the preview off. Frontmatter shows as page properties in Rich
  mode.
- Autosave: 1.5 s after the last keystroke, a commit with the doc's last-synced commit as its
  parent. When someone else committed first, the repo refuses it; the page reads their version,
  merges it in like git (where both changed the same lines, the person typing wins), and saves
  again ([src/editor/doc-session.ts](src/editor/doc-session.ts)).

What's next (co-editing, comments, docs.iterate.com): [tasks/docs-app.md](../../tasks/docs-app.md).

Local dev is Notes': `pnpm dev`, reached through a project behind `iterate tunnel`
([Notes' README](../notes/README.md)). The browser proof is [specs/docs](../../specs/docs).

Deploy: `pnpm --dir apps/docs run deploy --env prd` (the `docs` Doppler project's `prd` config).
