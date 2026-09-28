# Admin

The platform's admin app, at https://admin.iterate.com: every project and person on the platform
and the raw context explorer over any of their contexts. To use an app as one of those people,
sign in to that app again (its account menu's Switch account…) and pick them at the issuer's
consent: [acting as users and admins](../../docs/dev-environments.md#acting-as-users-and-admins). An ordinary OAuth client of the platform, like the
dash (`appAuth`, `createIterateClient`), with no secrets and no state of its own; it frames itself
in packages/ui's `AppShell`.

Local dev: `pnpm dev` (Vite, with the Cloudflare plugin's local workerd). It talks to
`https://os.iterate.com` by default; to use a local OS (`pnpm --dir ../os dev -- --port 8788`)
put `APP_CONFIG_URLS__OS=http://localhost:8788` in a gitignored `.dev.vars` here.

Deploy: `pnpm --dir apps/admin run deploy --env prd` (`.depot/workflows/deploy-admin.yml` on every
merge to main). Deployment configuration lives in `adminEnvs` in the root `envs.ts`.
