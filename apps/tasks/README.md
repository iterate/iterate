# iterate tasks

A Kanban board over the `tasks/` folder of any iterate project's config repo —
deployed as a **stateless vessel** at `tasks.iterate.workers.dev` (deployed
manually with `pnpm run deploy` from this directory; not part of the envs.ts
fleet, no routes of its own). Imported from the standalone
[iterate/tasks](https://github.com/iterate/tasks) repo. It never
holds project secrets or user sessions of its own. Every useful request
arrives through a reverse proxy in the project's `/repos/config` worker on a
host like `tasks--<slug>.iterate.app`.

Per connection the vessel:

1. Reads the trusted `x-itx-project-id` header and the platform's
   `iterate-project-auth` cookie (forwarded by the proxy).
2. Opens a Cap'n Web WebSocket to `os.iterate.com/api` and authenticates with
   `{ type: "project-app-session", token }`.
3. Reads/writes `tasks/` markdown in `/repos/config` via `listTaskFiles` /
   `commitFiles` — the git history of the config repo *is* the board's
   history, attributed to the connected user.

The board is a **collaborative checkout**: loading `/` creates one and
redirects to its shareable `/c/<checkout-id>` URL. A checkout is a
[y-partyserver](https://github.com/cloudflare/partykit) `YServer` Durable
Object (named `<projectId>:<checkoutId>`) holding an in-DO working copy of
the repo's task files as one Yjs doc — a `files` map of path → `Y.Text`
plus a `meta` map with the base commit it was seeded from at first join.
Everyone on the link edits the same doc over the stock y-protocols
WebSocket wire (`/api/checkout/<id>`): drags, adds, deletes, and each
keystroke in the CodeMirror task editor sync live, with presence chips and
named, colored remote cursors (y-codemirror.next + awareness). The doc
persists as one update blob in DO storage (debounced `onSave`), so a
checkout survives eviction.

Changed cards wear an A/M mark against the base commit, pending deletions
stay visible (and reversible) in a strip above the board, and the Commit
button — or a 60s idle autosave — POSTs to the DO, which flushes the doc's
diff against base as ONE `commitFiles` batch attributed to the poster:
typed message, AI-generated one (`/generate-message` via `ai.run`), or a
deterministic summary. The new base syncs back through the doc, clearing
everyone's marks. External commits to the repo are ignored while a checkout
lives — start a fresh checkout to pick up a new HEAD.

There is no pairing form, no OIDC client, and no capability door. The only
DO state is the Yjs blob; auth is per-join and per-op (the token is
verified by using it against the platform).

## Using it

Add a `tasks` app branch to the project's config `worker.ts` that gates on
project membership and reverse-proxies this vessel:

```ts
// tasks app — reverse-proxy the vessel at tasks.iterate.workers.dev
export class TasksApp extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
    using itx = await this.env.ITX.get();

    // (a) project-member auth gate — return its response when non-null
    const auth = await itx.auth.get({ policy: "project-member" }).fetch(req);
    if (auth) return auth;

    // (b) transparent proxy: pages, assets, and WebSocket upgrades.
    // The kv knob points the proxy at a dev tunnel instead of the deployed
    // vessel (see "Developing against a live project" in
    // apps/tasks/README.md); absent knob means production behavior.
    const description = await itx.__describe();
    const url = new URL(req.url);
    url.protocol = "https:";
    url.host = (await itx.kv.get("tasks-app-origin")) ?? "tasks.iterate.workers.dev";
    const headers = new Headers(req.headers);
    headers.set("x-itx-project-id", description.projectId);
    return fetch(new Request(url, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    }));
  }
}
```

Wire that class into the project's app router the same way as the seeded
`HelloApp` / `InternalApp` examples. Then open
`https://tasks--<slug>.iterate.app/` — sign-in is the platform's project-
member gate; the board UI is this app at `/`.

Drag cards, add tasks, click a card to edit its markdown together —
everyone on the checkout link sees the same board, each other's chips, and
each other's cursors in the editor. Commit from the Commit button (the ▾
panel reviews the change set, writes an AI commit message, or discards
everything), or let the 60s idle autosave commit with a generated summary.
A checkout is pinned to the base commit it was seeded from; `/` always
starts a fresh one from HEAD.

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
`scripts/probe-board-authed.mjs`).

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
  -e 'await itx.kv.set("tasks-app-origin", "me-tasks.tunnels.iterate.com")'
```

Then open `https://tasks--<slug>.iterate.app` in a normal browser. Flip back
with `itx.kv.delete("tasks-app-origin")` — absent knob means the deployed
vessel, byte-identical to production.

Know before you dogfood:

- **Prefer the per-user variant** (in the guide): the project-wide knob
  routes *every* member's traffic — including their session cookies — to
  your laptop while it is set. Per-user routing sends only your own sessions
  to the tunnel; everyone else stays on the deployed vessel.
- **Commits are real.** The board's 60s idle autosave turns test drags into
  actual commits on the project's config repo, attributed to you. Revertable
  via git, but be conscious of it on a production project.
- **Live agents orphan local edits.** The board re-reads HEAD every 30s; a
  HEAD moved by an agent or another member discards your uncommitted
  working-tree edits (by design — see above).
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
