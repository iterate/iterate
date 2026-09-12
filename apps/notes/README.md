# Notes

A small, separately deployed app. The project's config worker runs
`this.auth.require(request)` before proxying these files. The browser connects
to its own host's `/api`, using the same OAuth adapter as the console, and stores
the note under `itx.kv["notes.document"]`. The app holds no OAuth credentials.

Install [config-worker.ts](config-worker.ts) as the project's `itx.worker` to
serve it on `<project>.iterate2.app`. It can also be installed as `itx.apps.notes`
to serve `notes--<project>.iterate2.app`.

Deploy: `pnpm run deploy --env prd`. See the root environment map and the
project-worker's unified-auth build notes for the deployed E2E proof.
