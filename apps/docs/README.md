# Docs

Docs is a direct workspace-document viewer, review surface, and Markdown/HTML
source editor. It is a normal Cloudflare TanStack Start app styled with
Tailwind and the shared Iterate UI package.

A URL addresses one existing workspace and one existing file; beside the
editor sits the same file tree as the apps/os repo IDE, over the workspace's
config-repo documents: git-status badges for the workspace's uncommitted
changes, new/rename/delete/discard, and a Commit button that publishes the
mount's dirty set to the repo's main. A relative
`path` resolves against the workspace's own stream path; an absolute `path`
must be a fully qualified stream path (e.g. `/repos/config/docs/plan.md`):

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
- **Track changes** opens Source with author-colored insertions, deletion
  markers, and hover attribution. The control is available from Preview too.
- The comments rail always ends with **Comment on the whole document**.
- Selecting rendered Markdown text creates a passage-anchored thread.
- Threads and replies use Roughdraft Flavored Markdown (RFM): CriticMarkup
  passage anchors and YAML endmatter. Source is interoperable with Roughdraft.
- Suggestions render in the preview and can be accepted or rejected.
- Review writes are applied atomically against the source used to create them;
  conflicting edits preserve the comment draft for retry.
- The old Iterate annotation format is no longer interpreted; existing source
  files remain editable without a compatibility parser or automatic migration.

`@iterate-com/ui` provides format-independent `DocumentPreview`,
`DocumentComments`, and `ReviewComposer` components. `iterate/document-review`
reads and edits RFM; `useDocumentReview` in `@iterate-com/workspace-documents/review`
connects that source model to the UI. Docs and Tasks share this experience and
its collaborative Source editor. HTML document comments use an inert JSON
script containing RFM, separate from the HTML body.

## Jam

`/jam` mints a fresh scratch workspace on the config repo, seeds one document
under `jams/`, and opens it with the file tree beside the editor. The URL you
land on IS the jam: share it, and everyone on it edits the same live files.
**Invite AI** in the tree column births an agent at `/agents/jams/<id>` and
briefs it with the workspace path. Its edits show up in the open editor as
they land, and it reads your keystrokes through the same workspace. Nothing
commits by itself unless you switch on auto-commit in the Commit popover: the
workspace holds the jam until someone presses Commit.

## Install into a project

Docs runs behind your project's config worker, which authenticates project
members and proxies to the app. The default template already installs it. If
a project lacks it, hand this to the project's iterate agent (or commit it
yourself to `worker.ts` in `/repos/config`); these lines are the whole
integration:

```ts
import { DocsApp } from "@iterate-com/docs";

const docsApp = DocsApp.create(this.env, {
  auth: { policy: "project-member" },
  proxy: {
    origin: "https://docs.iterate.workers.dev",
    originOverrideKvKey: "docs-app-origin",
  },
});

if (app === "docs") return docsApp.fetch(request);
```

`https://docs--<project>.iterate.app` then works, `/jam` included. More in
[Remote apps](../../docs/remote-apps.md).

## Development

```bash
pnpm install
doppler setup --project docs --config dev_jonas --no-interactive
pnpm --dir apps/docs dev
```

The app's worker serves `/healthz` and the Cap'n Web `/api`; all document pages
are rendered through TanStack Start routes.
