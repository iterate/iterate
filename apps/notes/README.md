# Notes

A small, separately deployed app. The project's config worker runs
`this.auth.require(request)` before proxying these files. The browser connects
to its own host's `/api`, using the same OAuth adapter as dash. The note
is a FILE in the project's config repo — `/repos/config/notes/log.md` — edited
through the workspace `/workspaces/notes`: the page brings the repo and the
workspace into being through their collections
(`itx.invoke(["itx", "repos", ["create", "/repos/config"]])`,
`itx.invoke(["itx", "workspaces", ["create", "/workspaces/notes"]])`, both idempotent), reads the
file through the workspace, and "Save" writes the workspace's overlay and lands
ONE commit on the repo's `main` (`gitCommit({ scope: "/repos/config" })`). The
app holds no OAuth credentials and no state of its own. It frames itself in
packages/ui's `AppShell` — the sidebar, the project switcher and the account menu
every OS app shares — with the note as its one page.

Publish [config-worker.ts](config-worker.ts) as the project's config worker
(`itx/ingress-configured` with `["itx", "workers", ["get", { source }]]`): every host of the
project reaches its `fetch`, and it serves only the `notes` routing slug (`x-iterate-routing-slug`),
so `notes--<project>.iterate.app` reaches Notes (see
[specs/notes/sessions.spec.ts](../../specs/notes/sessions.spec.ts)). Under paths ingress (every
preview) it is `<platform>/projects/<project>/notes/`: the edge strips that base path and says it in
`x-iterate-base-path`, and Notes puts it back on every path the browser addresses — links, assets,
server functions — while the router drops it ([src/base-path.ts](src/base-path.ts)). The page's
`/.auth/*` and `/api` stay root paths: they are its host's, the platform's own under paths.

The project host stamps `x-itx-principal` only for a project member, so the guard is one check.
Signed out, `auth.require` answers `401` with the platform's challenge, and the edge turns a page
load into the sign-in (or, for someone signed in without this project, into "sign in again"), then
back to the page. A hand-written private route does the same:

```js
if (!request.headers.get("x-itx-principal"))
  return new Response("Sign in\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
  });
```

Local dev: `pnpm dev` (Vite, with the Cloudflare plugin's local workerd). It talks to
`https://os.iterate.com` by default; to use a local OS (`pnpm --dir ../os dev -- --port 8788`)
put `APP_CONFIG_URLS__OS=http://localhost:8788` in a gitignored `.dev.vars` here.

Dev server behind a tunnel, hot module reloading included: under paths ingress (a preview) a
tunnel's URL is `<platform>/projects/<project>/<name>/`, so the dev server starts under that base
path, then the tunnel lends it to the project
([packages/cli](../../packages/cli/README.md#tunnel)):

```sh
pnpm dev --port 5173 --base /projects/my-project/notes-dev/
iterate tunnel 5173 --project my-project --name notes-dev
```

Vite puts its module URLs and its HMR socket under the base path, and Notes swaps the page's base
path in for the build's ([src/base-path.ts](src/base-path.ts)). The page runs on the platform's
sign-in, as the proxied Notes does. Under subdomains the tunnel's host is an origin of its own, and
plain `pnpm dev` serves it. The local OS's `pnpm dev` does not forward the HMR socket: its
Cloudflare Vite plugin drops every `vite-*` WebSocket it does not serve itself
([pinned](../os/scripts/dev-tunnelled-hmr.test.ts) until upstream fixes it). A deployed or built OS
does.

Deploy: `pnpm --dir apps/notes run deploy --env prd` — after the platform it talks to
(`os.iterate.com`, which follows `main`) carries `itx.repos` and
`itx.workspaces`. Deployment configuration lives in `notesEnvs` in the root `envs.ts`; the
deployed browser proof is [specs/notes](../../specs/notes).
