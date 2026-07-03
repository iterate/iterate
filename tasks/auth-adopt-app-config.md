---
state: todo
priority: medium
size: large
tags: [auth, config, alchemy, doppler, refactor]
---

# Port apps/auth onto the AppConfig system (parity with apps/os)

apps/os funnels all configuration through a typed `AppConfig` (`apps/os/src/config.ts`):
`APP_CONFIG_*` env vars → zod-validated (`parseAppConfigFromEnv`, prefix
`APP_CONFIG_`) → a single `APP_CONFIG` string binding on the worker →
`parseConfig(env)` at request time. Secrets are wrapped with `redacted()`,
browser-safe fields with `publicValue()`, and `getPublicConfig()` strips the
secrets for the client. Deploy wiring is `initAlchemy("os", AppConfig, env)` in
`apps/os/alchemy.run.ts` (`packages/shared/src/alchemy/init.ts`).

apps/auth does NOT use this. It reads ~11 flat Doppler secrets as individual
`alchemy.secret()` bindings and reads them raw across the codebase
(`env.BETTER_AUTH_SECRET`, `c.env.VITE_AUTH_APP_ORIGIN`, `env.SIGNUP_ALLOWLIST`,
…). Goal: make auth structurally match os.

## Scope (why this is `large`)

**1. New `apps/auth/src/config.ts`** — an `AppConfig` zod schema + `parseConfig(env)`:

| current flat var               | proposed config path  | wrap                                |
| ------------------------------ | --------------------- | ----------------------------------- |
| `VITE_AUTH_APP_ORIGIN`         | `authAppOrigin`       | `publicValue(z.url())`              |
| `VITE_PUBLIC_URL`              | `publicUrl`           | `publicValue(z.url()).optional()`   |
| `BETTER_AUTH_SECRET`           | `betterAuthSecret`    | `redacted`                          |
| `SERVICE_AUTH_TOKEN`           | `serviceAuthToken`    | `redacted`                          |
| `GOOGLE_CLIENT_ID`             | `google.clientId`     | `publicValue`                       |
| `GOOGLE_CLIENT_SECRET`         | `google.clientSecret` | `redacted`                          |
| `RESEND_BOT_DOMAIN`            | `resend.domain`       | `redacted?`                         |
| `RESEND_BOT_API_KEY`           | `resend.apiKey`       | `redacted?`                         |
| `SIGNUP_ALLOWLIST`             | `signupAllowlist`     | `redacted`                          |
| `ADMIN_ALLOWLIST`              | `adminAllowlist`      | `redacted` (default `*@nustom.com`) |
| `VITE_ENABLE_EMAIL_OTP_SIGNIN` | `emailOtpEnabled`     | `publicValue(z.boolean())`          |

**2. Rewrite `apps/auth/alchemy.run.ts`** — build the `APP_CONFIG_*` env dict and
call `initAlchemy("auth", AppConfig, env)`; bind the single `APP_CONFIG` string
(local: plain JSON; deployed: `alchemy.secret(...)`). `DB` stays a real binding.
Note the deploy-time consumers that still need flat values: `render-admin-seed`
Exec (`SERVICE_AUTH_TOKEN`, `ADMIN_ALLOWLIST`) and `seedOAuthClients`.

**3. Rewrite every server env read** to `parseConfig(env)`:
`server/auth.ts`, `server/auth-plugins.ts`, `server/worker.ts`,
`server/utils/hono.ts`, `server/db/index.ts` (DB stays a binding),
`server/orpc/routers/internal.ts`, `routes/login.tsx` server fn.

**4. Client/SSR boundary — the tricky part.** Two client reads use Vite's
build-time inlining, NOT the runtime binding:

- `apps/auth/src/utils/auth-client.ts` → `import.meta.env.VITE_AUTH_APP_ORIGIN`
- `apps/auth/src/utils/query.tsx` → `import.meta.env.SSR ? VITE_AUTH_APP_ORIGIN : window.location.origin`
  os solves this by serializing `getPublicConfig()` into the SSR payload / router
  context and reading it on the client. Auth must do the same (or switch the
  better-auth client `baseURL` to same-origin, since the auth UI is always served
  from its own origin — simpler, worth checking against the OAuth flows). This is
  the part that makes it more than a mechanical server swap.

**5. Build-time stage vars.** `auth-plugins.ts` derives `isProduction` from
`import.meta.env.VITE_APP_STAGE`; `alchemy.run.ts` sets `VITE_APP_STAGE ||= app.stage`.
Decide whether stage stays a build var or moves into config.

## Doppler migration (deploy contract change — do together with the code)

Every auth config must rename its flat keys to `APP_CONFIG_*`:
`BETTER_AUTH_SECRET` → `APP_CONFIG_BETTER_AUTH_SECRET`, `VITE_AUTH_APP_ORIGIN`
→ `APP_CONFIG_AUTH_APP_ORIGIN`, `GOOGLE_CLIENT_SECRET` →
`APP_CONFIG_GOOGLE__CLIENT_SECRET`, etc. Across: `auth/dev`, `auth/dev_<you>`,
`auth/preview` (root), `auth/preview_1..9`, `auth/prd`. No backcompat shim
(repo convention: clean breaks) — so code + Doppler must land together, and prd
needs a coordinated deploy. `scripts/preview/preview.ts`
`provision-auth-preview-configs` (which seeds the preview auth configs) must be
updated to write the new names too.

## Verification

- `pnpm --dir apps/auth build` + `typecheck` + `lint`.
- Deploy to a preview slot and run the auth-touching e2e (`signup.spec.ts`,
  `create-project.spec.ts`, `mcp-oauth.e2e.test.ts`) — these exercise the
  login/consent/email-OTP UI that depends on the client-origin read.

## Note

Deliberately kept OUT of PR #1594 (the auth routes/docs/MCP-fix PR): that PR is
a pure code deploy with zero Doppler changes, and this port reverses that (it
requires the secret migration above) and re-grows the diff. Land it on its own.
