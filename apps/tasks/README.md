# iterate tasks

A Kanban board over the `tasks/**/*.md` files of any repo in an iterate
project — deployed as a **stateless vessel** at `tasks.iterate.workers.dev`
(deployed manually with `pnpm run deploy` from this directory; not part of
the envs.ts fleet, no routes of its own). Originally imported from the
standalone [iterate/tasks](https://github.com/iterate/tasks) repo. It never
holds project secrets, user sessions, or data of its own. Every useful
request arrives through a reverse proxy in the project's `/repos/config`
worker on a host like `tasks--<slug>.iterate.app`.

Per connection the vessel:

1. Reads the trusted `x-itx-project-id` header and the platform's
   `iterate-project-auth` cookie (forwarded by the proxy).
2. Opens a Cap'n Web WebSocket to `os.iterate.com/api` and authenticates with
   `{ type: "project-app-session", token }`.
3. Forwards every read and write to a platform **workspace** — the project's
   one path namespace, privately overlaid: every repo is mounted at its own
   `/repos/**` path, and uncommitted board edits are that workspace's
   overlay. Commits land on the repo's main via `git.commit({ scope })`,
   attributed to the connected user.

The board is a **lens on a workspace**, addressed two ways:

- `/w/<board-id>?repo=/repos/<name>` — the app's own boards. The board id
  plus repo derive a workspace path under `/workspaces/tasks/`, lazily
  created on first use; everyone on the link shares it.
- `/w?workspace=/workspaces/…&repo=/repos/<name>` — a lens on an EXISTING
  workspace, plain `get` (nothing is created). This is the deep-link form
  agents mint with `itx.worker.tasks.link({ workspace, repo, task? })`.
  Outside the app's own `/workspaces/tasks/` naming the board is a
  **guest**: read, comment, and edit — never Commit or Discard all (a
  commit would publish the mount's entire dirty set, discard would wipe the
  owning agent's uncommitted work). Publishing stays the workspace owner's
  act.

Board reads seed from `glob` + batched `readFiles`; `git.status()` IS the
diff (changed cards wear A/M marks, pending deletions stay reversible in a
strip above the board); the detail editor is the platform's collaborative
session (rebase model, redlines), shared keystroke-for-keystroke with
agents editing the same workspace. The Commit button turns the mount's
dirty set into ONE commit on that repo's main. The sidebar and home page
list workspaces from the platform's stream catalog — board workspaces
parse back into their (board id, repo) address; agents' workspaces appear
as guest lenses.

There is no pairing form, no OIDC client, no capability door, and no
storage: the old Yjs checkout Durable Object and its index DO are
tombstoned in `wrangler.jsonc`. Auth is per-connection and per-op (the
token is verified by using it against the platform).

## Task comments

Tasks carry Linear-style discussion threads **inside the markdown file
itself**: an EOF store of paired `<!-- iterate-thread:v1 … -->` /
`<!-- iterate-comment:v1 … -->` HTML-comment sentinels, readable in any editor
and invisible in rendered markdown. Parsing and splice-based mutations live
in the standalone `iterate/annotated-markdown` codec
(`packages/iterate/src/annotated-markdown/README.md` is the grammar).
`tasks-model.ts` parses cards through the codec (comment counts on board
cards; strict-parse failures fall back to the legacy lenient split), the
sheet's Comments section (`components/task-comments.tsx`) renders and
mutates threads, and every mutation is an ordinary whole-file transform
through the live-editor/write lane — so comments commit, diff, and merge
like any other task edit.

The Preview tab is the annotation surface: the body renders through
`iterate/annotated-markdown/react` (a source-stamped mdast renderer),
anchored threads paint as CSS Custom Highlights in their author's color,
and selecting text opens a comment bubble whose thread lands in the file
with a W3C-style anchor (quote + context + position; no inline marker).
Clicking a highlight selects its thread in the Comments strip and vice
versa; drifted anchors surface as `needs_review`/`orphaned` badges rather
than painting the wrong text.

## Using it

Install `@iterate-com/tasks`, configure its project-side connector, and route
the `tasks` app branch to it:

```ts
import { TasksApp } from "@iterate-com/tasks";

const tasksApp = TasksApp.create(this.env, {
  auth: { policy: "project-member" },
  proxy: {
    origin: "https://tasks.iterate.workers.dev",
    originOverrideKvKey: "tasks-app-origin",
  },
});

if (app === "tasks") {
  return tasksApp.fetch(req);
}
```

The connector applies the member gate and transparently proxies HTTP,
redirects, request bodies, and WebSocket upgrades. Then open
`https://tasks--<slug>.iterate.app/` — sign-in is the platform's project-
member gate; the board UI is this app at `/`.

Drag cards, add tasks, click a card to edit its markdown together —
everyone on the board link sees the same board, each other's chips, and
each other's cursors in the editor. Commit from the Commit button (the ▾
panel reviews the change set, writes a commit message, or discards
everything), or opt into the 60s idle auto-commit. Reads float at each
repo's HEAD (the workspace overlay carries only your uncommitted changes);
Home starts a fresh board or opens any existing workspace.

Hitting `tasks.iterate.workers.dev` directly serves only a landing page with
the same proxy snippet — no project context, no board.

## Development

```bash
pnpm install   # at the monorepo root
cd apps/tasks
cp .dev.vars.example .dev.vars
pnpm dev
```

`.dev.vars.example` points `OS_BASE_URL` at `https://os.iterate.com` — the
develop-against-production loop below, which is the loop you usually want.
Point it at a local os dev server (`http://localhost:<port>`) to run fully
local instead. Either way the vessel does not mint sessions: requests need
the `x-itx-project-id` header and a valid `iterate-project-auth` cookie
stamped on them (a project's proxy does this; headless, use
`scripts/probe-board.mjs`).

## Developing against a live project

The vessel is stateless and auth rides with each connection (the proxy stamps
the project header and forwards the user's cookie; os verifies the token), so
"deployed vessel" vs "your laptop" is just a hostname swap in the project's
proxy. Run local dev behind a captun tunnel and flip the project's
`tasks-app-origin` kv knob at it — you get platform login as yourself, real
project data, every commit attributed to you, but the app code is your local
checkout with HMR. Full guide: the platform's remote-apps doc.

Prerequisite: the project's config worker reads the knob with the deployed
host as fallback, as in the proxy snippet above.

The daily loop, two commands:

```bash
# 1. in apps/tasks — local vite dev, publicly tunneled (HTTP + WebSocket):
CAPTUN_TUNNEL_NAME=me-tasks \
CAPTUN_TOKEN=$(doppler secrets get CAPTUN_TOKEN --plain --project _shared --config dev) \
pnpm dev

# 2. point the project at your tunnel (from apps/os):
doppler run --config prd -- pnpm cli itx run --context <project-id> \
  -e 'await itx.kv.set("tasks-app-origin", "https://me-tasks.tunnels.iterate.com")'
```

Then open `https://tasks--<slug>.iterate.app` in a normal browser. Flip back
with `itx.kv.delete("tasks-app-origin")` — absent knob means the deployed
vessel, byte-identical to production.

Know before you dogfood:

- **Prefer the per-user variant** (in the guide): the project-wide knob
  routes *every* member's traffic — including their session cookies — to
  your laptop while it is set. Per-user routing sends only your own sessions
  to the tunnel; everyone else stays on the deployed vessel.
- **Commits are real.** A board commit lands on the project's actual repo,
  attributed to you (and the 60s auto-commit, when you opt in, commits on
  its own). Revertable via git, but be conscious of it on a production
  project.
- **The tunnel exposes vite dev, not project data.** Direct hits on the
  tunnel get only the landing page, and a forged project header without a
  valid cookie dies at os. What is public is the dev server itself (this
  checkout's source, HMR endpoints) — fine here, but don't reuse the pattern
  for a repo with secrets in the checkout.
- `OS_BASE_URL` must be `https://os.iterate.com` (the committed default) —
  the forwarded production token means nothing to a local os.

Dev-mode through any proxy needs `server.allowedHosts` (set in
vite.config.ts) — without it, vite 403s proxied Hosts and hydration fails in
ways that look like framework bugs.

## Deployment

```bash
pnpm run deploy   # vite build && wrangler deploy
```

No secrets. The only var is `OS_BASE_URL` (defaults to `https://os.iterate.com`
in `wrangler.jsonc`).
