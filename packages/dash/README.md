# Dash

The account UI: where a person manages their sessions and personal access
tokens, projects and organizations, and a project's secrets (`/projects/<slug>/secrets`:
set, list, update and delete — the platform's `itx.secrets`, whose values never come back out; an
agent's collection link opens `/collect-secret/<slug>`, one card outside the shell, framed like the
issuer's sign-in and consent pages), and its integrations
(`/projects/<slug>/integrations`: connect Slack, Google and GitHub through iterate's app or your own,
listed from the project root's `integrations` state), and its repos (`/projects/<slug>/repos`: the
repos list, and `/projects/<slug>/repos/<name>`, the `RepoIde` of `@iterate-com/ui` — a file tree, an
editable CodeMirror buffer with a diff against the last commit, staging, commit and history, reusable
in any app, see `packages/ui/AGENTS.md`; the working tree is kept in the browser until it commits
through `itx.repos.get(path).commitFiles`, and the repo's reads and commits are text only). It is an ordinary OAuth client of the
headless platform at `https://os.iterate.com` (which serves only sign-in and
consent; everything else lives in apps like this one), asking for the `iterate`,
`account` and `organizations:write` scopes; the last two are optional and can be unticked at
consent. The browser connects to its own host's `/api`, using the
same OAuth adapter as every other app. The app holds no OAuth credentials and no
state of its own — sessions, projects and organizations belong to the platform.

Local dev: `pnpm dev` (Vite, with the Cloudflare plugin's local workerd). It talks to
`https://os.iterate.com` by default; to use a local OS (`pnpm --dir ../os dev -- --port 8788`)
put `APP_CONFIG_URLS__OS=http://localhost:8788` in a gitignored `.dev.vars` here. The sidebar's
directory of apps (`src/apps.ts`) links to the origins in the worker's `APP_CONFIG` `urls`
(`@iterate-com/shared/start-app-config`) — prd's from `envs.ts` by default, the same PR's app
previews in a preview; a local one takes, say, `APP_CONFIG_URLS__VOICE=http://localhost:5174` in
the same file.

Deploy: `pnpm --dir packages/dash run deploy --env prd` serves `https://dash.iterate.com` (a route on
the `iterate.com` zone; `pnpm ensure-resources --env prd` creates the proxied DNS record).
Deployment configuration lives in `dashEnvs` in the root `envs.ts`; previews and acting as a user
are in `docs/dev-environments.md`.
