# Docs

Docs is a direct workspace-document viewer, review surface, and Markdown/HTML
source editor. It is a normal Cloudflare TanStack Start app styled with
Tailwind and the shared Iterate UI package.

There is deliberately no file browser and no task or commit workflow. A URL
addresses one existing workspace and one existing file:

```text
https://docs--<project>.iterate.app/?workspace=/workspaces/agents/<agent>&path=/reviews/plan.md
```

The default project worker exposes the Docs connector as
`itx.worker.docs`. Agents should ask that RpcTarget for the environment-correct
production, preview, or localhost link instead of assembling a hostname:

```ts
const url = await itx.worker.docs.link({
  workspace: "/workspaces/agents/reviewer",
  path: "/reviews/plan.md",
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

## Development

```bash
pnpm install
doppler setup --project docs --config dev_jonas --no-interactive
pnpm --dir apps/docs dev
```

The app's worker serves `/healthz` and the Cap'n Web `/api`; all document pages
are rendered through TanStack Start routes.
