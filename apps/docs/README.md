# Docs

A project's docs: the markdown files in its repos (`/repos/config` first), written in the browser. Served
like [Notes](../notes/README.md): a project routes its `docs` routing slug to this Worker
(`docsEnvs` in the root `envs.ts`) with a members-only fetch route, so it's
`docs--<project>.iterate.app` under subdomains and `<platform>/projects/<project>/docs/` under
paths (a PR preview's `pr<N>` gets that route from its seed, apps/os/scripts/preview-config.ts
`proxiedAppRoute`). The project installs Docs in its config repo, as it does agents: a `docs.ts`
re-exporting `@iterate-com/docs`'s processors and a pin in its root `package.json`
([packages/docs](../../packages/docs/README.md)); the page says so when a project hasn't. The page signs in on its host's `/.auth/*` and talks to its
host's `/api`, both the platform's; Docs has no OAuth client, no secrets and no state of its own.
The base path handling is Notes', shared in
[packages/ui/src/apps/base-path.ts](../../packages/ui/src/apps/base-path.ts).

- The sidebar picks one of the project's repos and shows every `.md` in it as a tree, following
  the repo's commits ([src/lib/doc-list.ts](src/lib/doc-list.ts)); ⌘K finds a doc by name.
  `/projects/<slug>/<repo>` lists them too and starts new ones (`folder/title` makes one in a
  folder); `/projects/<slug>` opens `config`.
- `/projects/<slug>/<repo>/<path>` edits one: CodeMirror over the file's markdown with Atomic's live
  preview (`@atomic-editor/editor`), a formatting bar, Cmd/Ctrl-B, -I, -E, -K and -Shift-X, and a
  Rich / Markdown switch that turns the preview off. Frontmatter shows as page properties in Rich
  mode.
- Co-editing: opening a doc installs its processor from
  [`@iterate-com/docs`](../../packages/docs/README.md) (`ensureDoc`, pinned to the package build of
  this app's commit). The editor is bound to the doc's shared Y.Text (y-codemirror.next); edits and
  cursors go to the other tabs as ephemeral events on the doc's context
  ([src/editor/collab.ts](src/editor/collab.ts)). The processor commits a minute after the first
  unsaved edit, or once the last tab has left, and merges in commits made elsewhere; the status
  line is its live state
  ([src/editor/doc-session.ts](src/editor/doc-session.ts)).

What's next (comments, docs.iterate.com): [tasks/docs-app.md](../../tasks/docs-app.md).

Local dev is Notes': `pnpm dev`, reached through a project behind `iterate tunnel`
([Notes' README](../notes/README.md)). The browser proof is [specs/docs](../../specs/docs).

Deploy: `pnpm --dir apps/docs run deploy --env prd`. Docs has no secrets, so it deploys from
`_shared`'s `prd` Doppler config (`dopplerProject` in [scripts/app.ts](scripts/app.ts)).
