---
status: in-progress
size: medium
---

# Preview one-click login

## Status summary

Spec fleshed out, implementation not started. Core pieces: auth `/test-login`
endpoint, CI seed-by-visiting-the-link, PR comment link upgrade, docs.

## Ask (as prompted)

> what if we just pre-minted stuff (user + project) (only for preview envs and
> `*+test@nustom.com` emails) and provided mobile app js bundles with a token
> baked in, and an os.iterate-\*.com link with a query param with the actual
> ready-to-go token or something. [...] that way I could just click/tap/scan a
> link and it would just... sign me in as a user and with a project that
> already exists (gets made as part of preview deployment CI)

## Design decision (assumption, delineated)

**No baked tokens.** Pre-minted forged tokens have two structural problems:

1. **Frozen claims** — a forged token minted at deploy time for a fresh user
   carries no org/project claims and dead-ends on `/project-access`
   (docs/dev-environments.md documents this for `pnpm auth:mint`).
2. **TTL** — a token baked into a PR comment or an EAS bundle outlives its
   expiry (1h default). The link rots; the bundle rots.

Instead: an **evergreen auto-login endpoint** on the auth app, gated exactly
like the fixed test OTP. Since `424242` already works for any
`*+test@nustom.com` address wherever `fixedTestOtpEnabled` is on (preview +
dev only, build-time flag from `envs.ts`, fails closed), server-side
auto-completion of that same flow grants **nothing the fixed code doesn't
already grant** — it just removes the typing. Sessions are real better-auth
sessions: refreshable, live claims, no frozen-claims problem, no expiry on the
link itself.

Zero-click is possible because OS requests only
`openid profile email offline_access` (apps/auth/src/lib/server.ts `SCOPES`) —
`postLogin.shouldRedirect` (auth-plugins.ts) only interrupts with
`/project-access` when the user has **zero orgs**. Seed the org+project and
the OAuth roundtrip completes with no interaction.

## How it works

New Hono route on the auth worker (apps/auth/src/server/worker.ts, next to
`/logout`):

```
GET /test-login?email=pr123+test@nustom.com&project=pr123&return_to=<url>
```

1. 404 unless `config.fixedTestOtpEnabled` AND
   `shouldUseTestOtp({email, fixedTestOtpEnabled})` (double gate; prod fails
   closed at build time).
2. Server-side OTP dance via `auth.api`: `sendVerificationOTP` (no-op email,
   fixed code) then `signInEmailOTP` — creates the user if missing, capture
   `Set-Cookie`.
3. Get-or-create org + project (reuse the same server-side paths the oRPC
   `organization.create` / `project.create` handlers use). `project` param is
   slug-validated; defaults to a slug derived from the email local part.
4. 302 to `return_to` with the session cookies attached. `return_to` is
   validated against an allowlist: same-origin paths + the deployment's known
   app origins (`config.publicUrl` etc.).

The one-click link for PR comments then is:

```
https://auth.iterate-preview-N.com/test-login?email=prNNN+test@nustom.com&project=prNNN&return_to=https://os.iterate-preview-N.com/api/iterate-auth/login
```

→ auth session minted + org/project ensured → OS RP login → authorize (signed
in, has orgs, trusted client) → callback → OS session → dashboard. Zero
clicks after the link.

**CI seeding = visiting the link.** The preview deploy step curls the
test-login endpoint once after readiness: that request alone creates
user+org+project (step 3 happens before the redirect), doubles as a smoke
test of the one-click path, and means the PR-comment link lands on a
pre-warmed, already-existing project.

**Mobile:** no token in the bundle (keeps the deliberate "hint, never
credential" posture of `expected-backend.ts`). The stamped
`MOBILE_TEST_LOGIN_EMAIL` hint flow already works; with the project now
seeded at deploy time, sign-in no longer detours through project-access.
Optional stretch (separate PR if at all): have mobile open
`/test-login?...&return_to=<authorize-url>` inside its AuthSession browser
for a zero-tap flow.

## Security notes

- Gate is the same double gate as the fixed OTP: build-time
  `fixedTestOtpEnabled` (never true in prd, `z.boolean().default(false)`
  fails closed) + `*+test@nustom.com` shape check.
- Login CSRF (a link can sign a visitor into an attacker-named test account):
  accepted for preview envs — identical exposure to the existing fixed OTP,
  which anyone can drive by hand today. Throwaway environments by design.
- `return_to` open-redirect: validated against allowlisted origins.
- No tokens in URLs, PR comments, or bundles anywhere in this design.

## Checklist

- [ ] `shouldAllowTestLogin` pure helper + unit tests (gating, email shape, return_to allowlist)
- [ ] `GET /test-login` route on auth worker: OTP dance via `auth.api`, get-or-create org+project, redirect with cookies
- [ ] preview.ts: `previewLoginUrl` → one-click test-login URL in the PR comment
- [ ] preview.ts: post-deploy seed step (single GET to the endpoint, assert redirect)
- [ ] e2e coverage: fresh email → endpoint → follow redirects → OS session established (existing auth e2e lane)
- [ ] docs/dev-environments.md: document the one-click link; adjust "template login links" section
- [ ] verify mobile hint flow benefits (project seeded ⇒ no project-access detour) — no bundle changes

## Implementation log

(append as work happens)
