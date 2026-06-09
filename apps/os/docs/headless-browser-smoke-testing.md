# Headless-browser smoke testing OS (no human in the loop)

How to drive a deployed OS environment (preview/dev) end to end with a headless
browser — log in, create a project, talk to an agent — without any interactive
permission prompts (e.g. while the human is asleep). First verified 2026-06-10
against a PR preview deployment.

## Logging in without an OAuth provider

Email/password **sign-up** is disabled on the auth worker
(`apps/auth/src/server/auth.ts`: `emailAndPassword.disableSignUp: true`, plus a
`SIGNUP_ALLOWLIST`), and Google OAuth is not headless-friendly. Two working
paths:

### Path A — bootstrap superadmin (simplest)

The auth worker provisions a bootstrap superadmin whose email/password sign-in
always works:

- email: `superadmin@nustom.com` (`BOOTSTRAP_SUPERADMIN_EMAIL` in
  `apps/auth/src/server/bootstrap-superadmin.ts`)
- password: the auth worker's service token —
  `doppler secrets get SERVICE_AUTH_TOKEN --project auth --config prd --plain`

Previews authenticate against **prod** auth (`auth.iterate.com`), so this works
for preview environments too.

### Path B — dedicated test user via the auth internal API

For a fresh user, call the service-token-gated internal oRPC API on the auth
worker (`apps/auth/src/server/orpc/routers/internal.ts`):
`internal.user.upsertVerifiedEmail` creates a verified user;
`internal.organization.createForUser` gives it an org. Authenticate these calls
with `SERVICE_AUTH_TOKEN` as a bearer. Note upserted users have no password —
pair this with one-time-token sign-in or stick with Path A.

## Driving the browser

Use `agent-browser` (the skill in this repo's environment) — it runs headless
and needs no CDP permission prompts. The flow that works:

1. `open https://os.iterate-preview-N.com/` → follows the 307 to `/sign-in`,
   which redirects to the auth worker's hosted login page.
2. Snapshot, fill the email + password fields with the Path A credentials,
   submit.
3. The OAuth callback lands back on OS authenticated. Snapshot to confirm the
   sidebar rendered.
4. Create a project: navigate to `/new-project`, fill the slug field
   (lowercase kebab-case), submit; you land on `/projects/<slug>`.
5. Agent conversation: from the project, go to `/projects/<slug>/agents`,
   create/open an agent and send a message; wait for the reply to stream in.

## Verifying without a browser

API-level checks that don't need auth UI (used by `e2e/vitest/preview-smoke`):

```bash
curl https://<host>/api/__internal/health          # {"ok":true,"app":"os",...}
curl https://<host>/api/__internal/public-config   # public config only
# Admin-authenticated oRPC (uses the env's admin API secret):
doppler run --config preview_N -- pnpm cli rpc projects.list
```

## Gotchas

- Preview OAuth client secrets can drift from prod auth — symptom is
  "OAuth callback exchange failed". Fix per
  `docs/devops-cloudflare-doppler-alchemy-setup.md` and the sync script:
  `apps/os/scripts/sync-auth-clients.ts`.
- The worker bakes `APP_CONFIG` at deploy time; changing Doppler values
  requires a redeploy to take effect.
