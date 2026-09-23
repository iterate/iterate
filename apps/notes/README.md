# Notes

A small, separately deployed app. The project's config worker runs
`this.auth.require(request)` before proxying these files. The browser connects
to its own host's `/api`, using the same OAuth adapter as the console. The note
is a FILE in the project's config repo — `/repos/config/notes/log.md` — edited
through the workspace `/workspaces/notes`: the page brings the repo and the
workspace into being (`itx.repos.get("/repos/config").create()`,
`itx.workspaces.get("/workspaces/notes").create()`, both idempotent), reads the
file through the workspace, and "Save" writes the workspace's overlay and lands
ONE commit on the repo's `main` (`gitCommit({ scope: "/repos/config" })`). The
app holds no OAuth credentials and no state of its own. It frames itself in
packages/ui's `AppShell` — the sidebar, the project switcher and the account menu
every OS app shares — with the note as its one page.

Install [config-worker.ts](config-worker.ts) as the project's `itx.worker` to
serve it on `<project>.iterate.app`. It can also be installed as `itx.apps.notes`
to serve `notes--<project>.iterate.app`.

Local dev: `pnpm dev` (Vite, with the Cloudflare plugin's local workerd). It talks to
`https://os.iterate.com` by default; to use a local OS (`pnpm --dir ../os dev -- --port 8788`)
put `ITERATE_ORIGIN=http://localhost:8788` in a gitignored `.dev.vars` here.

Deploy: `pnpm run deploy --env prd` — after the platform it talks to
(`os.iterate.com`, which follows `main`) carries `itx.repos` and
`itx.workspaces`. See the root environment map and the os-next's unified-auth
build notes for the deployed E2E proof.
