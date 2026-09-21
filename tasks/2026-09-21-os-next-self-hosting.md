---
state: draft
priority: high
size: large
tags: [os-next, self-hosting, app-config, login, ingress, dash, packaging]
---

# os-next self-hosting: one Worker, `wrangler deploy`, sign in, use it

Goal: a person (or their agent) deploys os-next into their own Cloudflare account with
`wrangler deploy` plus one secret, and is using it within minutes: `/mcp` for an MCP client,
our hosted dash pointed at their install, project apps under paths on workers.dev. No domain,
no second Worker, no dashboard clicking. Our own deployment (os.iterate2.com) keeps Google
and mailed codes and changes only through explicit config.

Assessed 2026-09-21 in conversation; nothing below is built yet. Research (Executor, Cloudflare
OS, VibeSDK, Cloudflare's button/claim/Access mechanics) is summarised at the end.

## Decisions

1. ONE Worker is the self-host: issuer, OAuth server, `/api`, `/mcp`, the DOs. No shim Worker.
2. No domain required. Path ingress on workers.dev: `https://<os>/projects/<project>/<app>/...`.
   A zone enables subdomain ingress from the same Worker. Both parse into `{ project, app, basePath }`.
3. Path-routed app documents are served with a CSP `sandbox` header the edge adds, so apps
   run in an opaque origin and cannot spend the issuer cookie (every request carries `Origin: null`,
   which our existing Origin gates already refuse). Apps in path mode authenticate in-band.
4. ONE app config: the `APP_CONFIG` JSON blob (the shared parser already merges it), nested as
   below. Any key can also be set alone as `APP_CONFIG_<PATH>__<KEY>`. Schema strict.
5. Secrets are Worker secrets, script-minted, declared in wrangler `secrets.required`.
   ONE key (`secrets.key`) from which session signing and at-rest encryption derive (HKDF,
   distinct labels); `previousKey` only mid-rotation. `secrets.adminBearer` optional.
6. Sign-in is a list of mechanisms, each on iff its block is present, at least one required:
   `password` (a global password: anyone who knows it signs in as the email they type — this
   REPLACES the 424242 test code, which is a global password with a public value, on today),
   `emailCode` (needs Email Sending on that domain), `google`. The admin `POST /login` sign-in
   route is retired: the specs and e2e sign in with the deployment's password instead.
7. `urls.os` blank ⇒ each request's own origin. Directory schema applied at boot (idempotent).
8. Our hosted dash (and agents/notes/voice, same adapter) can be pointed at any issuer, but
   only through a same-origin POST page on the dash that shows the issuer host (see controls).
   The self-hosted landing page links to that page.
9. `environmentName`, `aiGatewayId`, `recentEphemeralsBudgetChars`, the Artifacts account id
   and namespace leave the config: constants live beside their consumers; `/version` prints
   the deploy id and `urls.os`; the Artifacts binding's `repo.info().remote` is the git URL.
10. Packaging: a published prebuilt bundle (`@iterate-com/os`: worker + public/) and a small
    template repo (wrangler.jsonc with no ids, one-line entry re-export, `.dev.vars.example`,
    a `deploy` script). The template's `deploy` script is the installer for the Deploy button
    (Workers Builds supplies `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` — VibeSDK relies on
    this, undocumented), for agent instructions, and for a human.
11. Cloudflare Access is NOT part of the install (not scriptable from `wrangler login`; needs
    Zero Trust onboarding with a payment method and a separate API token). A later upgrade.

13. **The platform origin's paths are exactly:** `/projects/<slug>/<app>` (path ingress), `/api`, `/mcp`,
    `/.well-known/*`, `/login`, `/authorize`, `/oauth/*`, the issuer pages' own files (one logo), and
    `/version` (the deploy smoke waits on it — Jonas did not list it; keep or fold, his call). Deleted
    2026-09-21: `/internal/rpc` (the bearer-less operator door; every user moved to `/api` with the
    admin bearer on the upgrade), `/client-icon` and `/brands/*` (the consent hero shows initials).

## The config

```js
{
  urls: {
    os: "https://os.iterate2.com",       // the issuer; unset ⇒ each request's own origin
    mcp: "https://mcp.iterate2.com",     // unset ⇒ /mcp on urls.os
    dash: "https://dash.iterate2.com",   // the landing page's "Launch dash"; unset ⇒ no link
    ingressRouting: { type: "subdomains", hostname: "iterate2.app" },   // or { type: "paths" }; unset ⇒ none
    // TEMPORARY: hostnames that are a project's apex. Belongs in the project's own runtime config.
    temporaryCustomHostnames: { "iterate2.com": "iterate" },
  },
  login: {                                              // each on iff present; none ⇒ refuse to boot
    password: "…",                                      // secret
    emailCode: { from: "iterate <login@iterate2.com>" },
    google: { clientId: "…", clientSecret: "…" },
  },
  secrets: {
    key: "…",            // session signing + project secrets at rest derive from it
    previousKey: "…",    // only mid-rotation
    adminBearer: "…",    // optional: every project, run on /mcp, the specs/CI
  },
}
```

A self-host holds two secret strings: `secrets.key` (its own Worker secret so it can rotate with
`previousKey` beside it) and `login.password` (inside the `APP_CONFIG` blob or alone). Prd adds
`adminBearer`, Google, the mail sender. Projects live under `/projects/` in path mode, so
the platform's own paths need no reserved list.

## Slices, in order (each its own PR; platform before apps)

| # | Slice | Touches | Size | Needs |
|---|-------|---------|------|-------|
| 1 | Config nesting + renames, blob-first, strict schema; drop the five dead fields; `/version`; Artifacts remote from the binding | app-config.ts, every reader, generate-wrangler-config.ts, envs.ts OsNextEnv, dev.ts, test configs, e2e support, deploy.ts, Doppler (one blob) | ~250 LOC mechanical | — |
| 2 | Secrets: one key + HKDF derivations + previousKey; adminBearer optional; `secrets.required` | secret-at-rest.ts, issuer-session/control-plane signing, file-urls.ts, deploy.ts, wrangler.base | ~120 | 1 |
| 3 | Login mechanisms: `login.password` replaces test code + admin sign-in route; login page password step; specs/e2e use the password; rate limit | control-plane.ts, login-code.ts, public/login.js, e2e/support/principal.ts, specs | ~150 | 1 |
| 4 | Boot self-setup: schema at boot; `urls.os` blank ⇒ request origin | worker.ts, app-config.ts | ~60 | 1 |
| 5 | Ingress module: `projectIngressOf` / `projectAddressOf` / `projectUrlOf` in the SDK, table-tested; `session.info()` carries the parsed value; worker.ts, consent.ts, file-urls.ts, dash `_auth.tsx` call it; `itx.apps.<label>.url()` + `itx.url()` | packages/iterate/src/next/project-ingress.ts (new), hosts.ts (deleted), callers | ~200 | 1 |
| 6 | Path ingress: parse + strip + base path handed to the app; sandbox header on path-mode responses; SDK no-cookie (in-band bearer) mode; `<base href>` from the archetype | worker.ts, SDK app-server/app.ts, SPA archetype | ~300 | 5 |
| 7 | Hosted dash → any issuer, with the controls below; the POST interstitial page; issuer badge in the shell | SDK app-server.ts, app-session.ts, apps/dash (+ agents/notes/voice inherit) | ~250 | 3 (password lands first so the demo works) |
| 8 | Packaging: build the bundle, publish `@iterate-com/os`; template repo with `deploy` script; Deploy button; setup prompt at a URL; agent instructions | new repo, scripts/build.ts | ~200 + a repo | 1–4 |
| 9 | Later: `wrangler deploy --temporary` try tier (which bindings survive?), in-app update check (npm dist-tags), Access via the new `cf` CLI scopes, passkeys | | | 8 |

Everything in 1–4 is prd-visible through Doppler only; the template ships after 4.

## Controls for slice 7 (security review 2026-09-21; 80/20 = all but the last)

- Issuer normalized to `URL.origin`, https only, no IP literal or localhost, not one of our zones
  (project hosts are userspace and could serve a look-alike issuer); the discovery document's
  `issuer` must equal it; `/authorize`, `/oauth/token`, `/api` stay hand-built from the origin;
  `authorization_response_iss_parameter_supported: true` stays hard-coded (the mix-up defence).
- A non-default issuer is accepted ONLY from a same-origin POST page that shows the host; `issuer`
  is stripped from every `next` (today the Sign-in-again form would carry `?issuer=evil` through
  logout — a one-click forced login).
- The session record is the sole source of `{ issuer, resource }` for the probe, the proxy,
  `grantSummary` and logout.
- The insecure-request opt-out keys on the APP's origin being local, never the issuer's.
- The Sign-in-again page loads no foreign issuer's stylesheet; CSP on the page.
- The dash parses `platformOrigin`/`mcpOrigin` with `new URL()` and requires http(s) before
  putting them in an `href` or a shell command (`_auth.tsx` `projectHostUrl`, the MCP page).
- Skipped for now: discovery cache + rate limit on the POST (the POST already makes drive-bys free).

## To verify before building on it

- The Deploy button's config reader accepts our binding set (Worker Loader, Browser Run, Email
  Sending, Artifacts, version metadata, `exports` DO declarations, `limits`, the experimental
  compatibility flag) — one-hour experiment on a scratch account + public template repo.
- `wrangler deploy --secrets-file` satisfies `secrets.required` within the same deploy.
- Whether the button form lets a listed secret stay blank for the script to mint.
- A sandboxed top-level document: Lax cookies and WebSocket `Origin: null` behave as assumed.
- `--temporary` accounts: R2 and Workers AI are not listed as supported; Worker Loader, Browser
  Run, Email Sending, Artifacts unconfirmed.
- `ctx.access` / the `cf` CLI's `access:write` scope (only if Access is ever pursued).

## Research digest (2026-09-21)

- Executor (executor.sh): one script-minted secret (at-rest key → `wrangler secret put`,
  skip-if-present), Access = identity + allowlist, `ADMIN_EMAILS` var, derives its URL from the
  request, in-app update card. v2 DROPPED the Cloudflare self-host (Docker + vendor cloud only).
  Its "set up with your agent" is a prompt served at `executor.sh/setup-prompt.md`.
- Cloudflare OS: no session key (random bearer hashed in the user's DO); only secret = optional
  AI Gateway token; hosted wizard deploys into your account in ~1 min (Cloudflare-internal).
- VibeSDK: Deploy button; `deploy.ts` mints `JWT_SECRET`, `wrangler secret bulk`, reads
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` from the build env.
- Everyone who mints a secret stores it as a Worker secret; nobody mints into KV/DO/D1.
- Button: prompts secrets from `.dev.vars.example`, descriptions from `package.json`
  `cloudflare.bindings`; cannot mark optional or auto-generate; needs a self-contained repo;
  one Worker per button; requires GitHub/GitLab. Auto-provisions KV/D1/R2/DO/AI/Queues/…
- `wrangler deploy --temporary` (≥4.102.0): deploy before login, claim within 60 min.
- Worker-level one-click Access returns 403 on WebSockets (kills `/api`) and would front `/mcp`.
  Access is not scriptable from a `wrangler login` token (no Access scope); Zero Trust onboarding
  wants a payment method even on Free; "Cloudflare account members" login exists as an Access IdP.

## Doppler migration (project `project-worker`) — NOT run yet

The deploy now uploads two Worker secrets from Doppler: `APP_CONFIG` (the `login` and `secrets`
halves of the object; the `urls` half is generated from envs.ts) and `APP_CONFIG_SECRETS__KEY` (the
old `APP_CONFIG_SECRETS_KEY`, unchanged, so every at-rest record still opens). Run before the first
deploy of this branch, per config:

```bash
# prd — Google + mailed codes stay; the password is the specs' way in (replaces the 424242 test code)
doppler secrets set --project project-worker --config prd \
  APP_CONFIG="$(node -e 'console.log(JSON.stringify({
    login: {
      password: require("node:crypto").randomBytes(24).toString("base64url"),
      emailCode: { from: "iterate <login@iterate2.com>" },
      google: { clientId: process.env.GID, clientSecret: process.env.GSEC },
    },
    secrets: { adminBearer: process.env.ADMIN },
  }))' )" \
  APP_CONFIG_SECRETS__KEY="$(doppler secrets get --project project-worker --config prd APP_CONFIG_SECRETS_KEY --plain)"
# with GID/GSEC/ADMIN exported first from the old values:
#   export GID=$(doppler secrets get -p project-worker -c prd APP_CONFIG_GOOGLE_CLIENT_ID --plain) …

# preview_2 — no Google, no mailbox: the password and the bearer
doppler secrets set --project project-worker --config preview_2 \
  APP_CONFIG='{"login":{"password":"<new random>"},"secrets":{"adminBearer":"<old APP_CONFIG_ADMIN_API_SECRET>"}}' \
  APP_CONFIG_SECRETS__KEY="$(doppler secrets get --project project-worker --config preview_2 APP_CONFIG_SECRETS_KEY --plain)"
```

Afterwards: `APP_CONFIG_SESSION_SECRET` is unused (the signing secret now derives from the key; every
browser signs in once more), and `APP_CONFIG_ADMIN_API_SECRET`, `APP_CONFIG_SECRETS_KEY`,
`APP_CONFIG_GOOGLE_CLIENT_ID/_SECRET` are read by nothing. Delete them from Doppler and from the
live Worker (`wrangler secret delete`) AFTER the first green deploy of this branch — an unknown
`APP_CONFIG_*` var only warns at boot, never fails, so the order is safe either way.
