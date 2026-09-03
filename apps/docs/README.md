# Docs

Docs is a direct workspace-document viewer, review surface, and Markdown/HTML
source editor. It is a normal Cloudflare TanStack Start app styled with
Tailwind and the shared Iterate UI package.

There is deliberately no file browser and no task or commit workflow. A URL
addresses one existing workspace and one existing file. A relative `path`
resolves against the workspace's own stream path; an absolute `path` must be a
fully qualified stream path (e.g. `/repos/config/docs/plan.md`):

```text
https://docs--<project>.iterate.app/?workspace=/workspaces/agents/<agent>&path=review.md
```

The default project worker exposes the Docs connector as
`itx.worker.docs`. Agents should ask that RpcTarget for the environment-correct
production, preview, or localhost link instead of assembling a hostname:

```ts
const url = await itx.worker.docs.link({
  workspace: "/workspaces/agents/reviewer",
  path: "review.md",
});
await itx.chat.sendMessage(`[Review the plan](${url})`);
```

Supported file extensions are `.md`, `.markdown`, `.html`, and `.htm`. Docs
reads and edits the workspace overlay directly through the OS workspace
collaboration capability. It does not create a checkout or invoke a git
commit.

## Review model

- The default Preview tab renders Markdown or workspace-authored HTML.
- Source opens the shared CodeMirror collaborative editor.
- The comments rail always ends with **Comment on the whole document**.
- Selecting rendered Markdown text creates a passage-anchored thread.
- Threads and replies are stored in the file's neutral
  `iterate-annotations:v1` EOF annotation store.

The document editor, Markdown annotation surface, comments rail, collaboration
client, redlines, cursors, attribution, identity, and server dial are shared
with Tasks through `@iterate-com/workspace-documents`. Tasks adds its board and
task model around that common document backbone; Docs does not.

## Notes view

The third view, `/notes?repo=/repos/config`, is the repo's `notes/` folder:
a list of its Markdown files on the left, one plain editor (the shared
collaborative CodeMirror editor) on the right, nothing rendered. The
long-running log, `notes/log.md`, opens by default and is Reflect's daily
notes minus everything but the dates: opening it appends today's
`## YYYY-MM-DD` heading at the tail and puts the caret under it. "New note"
creates `notes/<slug>.md` and opens it. Edits are workspace writes into the
app's one notes workspace for that repo (`/workspaces/notes/…`, shared by
every member so nobody's pending edits get clobbered); after 30s of quiet
everything dirty under `notes/` commits to the repo's main as
`Notes: <today>`. Same-day edits amend that commit instead of stacking —
unless someone else committed in between, in which case the platform lands
an ordinary commit on top (the workspace commit's `amendIfHead`).

### References, pills, and the `+` menu

A note can point at things as plain text — `@/agents/researcher`,
`[[notes/ideas.md]]`, `[[tasks/launch.md]]` — and the editor draws those as
pills over the text (a decoration, like peer carets; the bytes never change).
`@` completes the project's agents and `[[` completes notes and tasks; a pill
opens its target (the agent in OS, the note here, the task on the board). The
kinds live in one registry (`@iterate-com/workspace-documents/references`)
shared by every editor in the app. The header's `+` menu inserts those at the
caret (plus today's heading and a new note) and, under Enable, lets an agent
watch the note by writing `agent:` into its frontmatter. Reactions are the
config worker's: on every config-repo commit it reads the changed notes and
messages each mentioned or watching agent with a link to the note (see
`configs/default/worker.ts`).

## Development

```bash
pnpm install
doppler setup --project docs --config dev_jonas --no-interactive
pnpm --dir apps/docs dev
```

That serves the vessel alone. To use it from a project on a local OS, run it
through a captun tunnel and point the project's `docs-app-origin` KV key at
it — the step-by-step loop is in
[docs/remote-apps.md](../../docs/remote-apps.md#developing-your-app-against-a-live-project).

The app's worker serves `/healthz` and the Cap'n Web `/api`; all document pages
are rendered through TanStack Start routes.
