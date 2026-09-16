# Notes

A small, separately deployed app. The project's config worker runs
`this.auth.require(request)` before proxying these files. The browser connects
to its own host's `/api`, using the same OAuth adapter as the console. The note
is a FILE in the project's config repo — `/repos/config/notes/log.md` — edited
through the workspace `/workspaces/notes`: the page brings the repo and the
workspace into being (`itx.repos.get("/repos/config").create()`,
`itx.workspaces.get("/workspaces/notes").create()`, both idempotent), reads the
file through the workspace, and "Save and commit" writes the workspace's overlay
and lands ONE commit on the repo's `main` (`gitCommit({ scope: "/repos/config" })`).
The app holds no OAuth credentials and no state of its own.

Install [config-worker.ts](config-worker.ts) as the project's `itx.worker` to
serve it on `<project>.iterate2.app`. It can also be installed as `itx.apps.notes`
to serve `notes--<project>.iterate2.app`.

Deploy: `pnpm run deploy --env prd` — after the platform it talks to
(`os.iterate2.com`, which follows `main`) carries `itx.repos` and
`itx.workspaces`. See the root environment map and the os-next's unified-auth
build notes for the deployed E2E proof.
