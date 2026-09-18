# Dash

The account UI: where a person manages their sessions and personal access
tokens, projects and organizations. It is an ordinary OAuth client of the
headless platform at `https://os.iterate2.com` (which serves only sign-in and
consent; everything else lives in apps like this one), asking for the `iterate`
and `account` scopes. The browser connects to its own host's `/api`, using the
same OAuth adapter as every other app. The app holds no OAuth credentials and no
state of its own — sessions, projects and organizations belong to the platform.

Local dev: `pnpm dev` (Vite, with the Cloudflare plugin's local workerd). It talks to
`https://os.iterate2.com` by default; to use a local os-next (`pnpm --dir ../os-next dev -- --port 8788`)
put `ITERATE_ORIGIN=http://localhost:8788` in a gitignored `.dev.vars` here.

Deploy: `pnpm run deploy --env prd` serves `https://dash.iterate2.com` (a route on the
`iterate2.com` zone; `pnpm ensure-resources --env prd` creates the proxied DNS record). See
the root environment map and the os-next's unified-auth build notes for the deployed E2E proof.
