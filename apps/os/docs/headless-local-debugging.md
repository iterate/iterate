# Headless local debugging (drive the full OS + Auth stack)

How to reproduce UI/auth bugs against a **local** OS + Auth stack with a
scripted headless browser: sign in via test OTP, create orgs/projects, drive
OAuth, and read server state directly. Complements
[preview-browser-smoke.md](./preview-browser-smoke.md), which drives
a deployed preview against that slot's auth worker.

## When to use which environment

- **Deployed preview** (`os.iterate-preview-N.com`): uses the matching
  `auth.iterate-preview-N.com` worker and isolated auth database. Fixed test
  OTP is enabled for preview test users. Best for final proof.
- **Normal OS local dev**: `pnpm dev` or `pnpm dev start --detach` runs OS
  on a random localhost port and uses shared dev auth at
  `auth.iterate-dev.com`.
- **Local OS + Auth stack** (this doc): `pnpm dev-all` runs Auth on
  `http://localhost:7101` and OS on a random localhost port, against local D1
  (miniflare) state you can read and write directly. Best for fast iteration
  and for bugs that need many synthetic events / fresh orgs.

## Bring up the local stack

```bash
pnpm dev-all   # monorepo root: starts apps/auth (localhost:7101) AND apps/os (localhost)
```

`pnpm dev-all` points OS at the local auth issuer through
`APP_CONFIG_ITERATE_AUTH__ISSUER`. OS writes its chosen base URL to
`apps/os/.dev-server/dev-server.json`; drive the browser against that localhost
URL.

Gotchas:

- The Doppler scope for `apps/auth` must resolve to a config that exists. If
  `pnpm dev-all` dies with `Could not find requested config 'dev_<you>'`, point it
  at the shared dev config: `doppler configure set config dev --scope apps/auth`.
- Local Auth and OS read the same `AUTH_FORGE_ES256_PRIVATE_JWK`. Auth signs with its
  private half and generated OS config derives the public JWKS, exactly like a
  deployment; no live JWKS fallback is involved.

## Headless browser without touching the user's Chrome

Use Playwriter headless so automation never attaches to the user's real Chrome:

```bash
playwriter browser install   # one-time: Chrome for Testing
SID=$(playwriter session new --browser headless 2>&1 | sed -n 's/^Session \([0-9][0-9]*\) created.*/\1/p')
BASE="$(node -p 'require("./apps/os/.dev-server/dev-server.json").baseUrl')"
playwriter -s "$SID" --timeout 60000 -e "$(cat <<EOF
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage());
await state.page.goto(${JSON.stringify('$BASE')}, { waitUntil: 'domcontentloaded' });
console.log(await snapshot({ page: state.page }));
EOF
)"
```

- Keep a single Playwriter session id for the whole debug loop so cookies and
  pages persist across `-e` calls.
- Prefer `snapshot()` after every navigation; locators go stale on re-render.
- Do not use the developer's real Chrome unless they explicitly authorize it
  for that task (extension path + multi-profile `--browser` key).

## Sign in with a test user (OTP)

Local/non-prod auth enables email OTP and a deterministic code:

- Any `nustom.com` email whose local part ends in `+test` skips email send and accepts OTP **`424242`**
  (see `apps/auth/src/server/auth-plugins.ts`).
- Sign-_up_ is gated by `APP_CONFIG_SIGNUP_ALLOWLIST` (auth Doppler). The local list allows
  `*@nustom.com`, `testuser+*@gmail.com`, etc. A brand-new email outside the
  allowlist returns `403 "Sign up is not available for this email address"`, so
  use e.g. `testuser+<scenario>@gmail.com`.

Flow (snapshot between steps; refs go stale on every navigation):

```bash
ab open "$(node -p 'require("./apps/os/.dev-server/dev-server.json").baseUrl')"
ab find role button click --name "Continue with Iterate"     # OS -> auth /login
ab find role button click --name "Continue with email"
ab fill "input[type=email]" "testuser+dbg@gmail.com"
ab find role button click --name "Send verification code"
ab fill "input[autocomplete=one-time-code]" "424242"
ab find role button click --name "Continue with email"        # -> /project-access or /consent
```

If the OTP form rejects a code, the OTP really is in the DB — read it (below) to
confirm; "Invalid OTP" usually means a stale verification row, "Forbidden"/403
means the allowlist rejected sign-up.

### Consent step quirk

The better-auth oauth-provider consent button posts via a client plugin that
reconstructs the signed query from `window.location.search`. If clicking
"Allow access" loops back to `/consent`, drive the endpoint directly from the
page context and follow its redirect:

```bash
cat <<'EOF' | ab eval --stdin
(async () => {
  const sp = new URLSearchParams(window.location.search);
  const signed = new URLSearchParams();
  for (const [k, v] of sp.entries()) { signed.append(k, v); if (k === "sig") break; }
  const res = await fetch("/api/auth/oauth2/consent", {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ accept: true, oauth_query: signed.toString() }),
  });
  const data = await res.json();
  if (data.url) window.location.href = data.url;   // -> OS /api/iterate-auth/callback
  return { status: res.status, url: data.url };
})()
EOF
```

## Create orgs and projects

- **Org**: the post-login `/project-access` page has a "Create organization"
  form; fill it and submit. Or call the auth contract
  (`internal.organization.createForUser`) with a service token.
- **Project**: use the OS UI route `/new-project`, fill the slug form, and
  submit. The dashboard create flow runs through the current itx-backed server
  function and refreshes the auth session before navigating to the project.

Project claims only land in the JWT on token refresh (or a fresh sign-in), so
the OS create-project UI forces an auth session refresh after creation before it
navigates to the project. If you bypass the UI in a one-off debugging script,
call `/api/iterate-auth/session?refresh=force` afterward before testing cold
reloads or WebSocket-backed project routes.

## Read local server state directly

The AUTH worker's local D1 lives as miniflare SQLite files (OS itself has no
D1 — OS state is Durable Object SQLite; read it through itx instead:
`pnpm cli itx run`):

```bash
ls .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite
# auth DB has: user, account, organization, member, oauthClient, oauthRefreshToken, verification

DB=.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
sqlite3 "$DB" "SELECT identifier, value FROM verification ORDER BY rowid DESC LIMIT 3"   # pending OTPs (value is 'otp:attempts')
sqlite3 "$DB" "SELECT clientId, substr(token,1,10), revoked, expiresAt FROM oauthRefreshToken ORDER BY createdAt DESC"
sqlite3 "$DB" "SELECT clientId, substr(clientSecret,1,12) FROM oauthClient"
```

Refresh/OTP tokens are stored **hashed/encoded**, so a value read here is not the
literal bearer the client holds — useful for state/rotation inspection, not for
replaying a token by hand.

## Instrumenting UI behaviour

`ab eval --stdin` runs arbitrary JS in the page. For transient visual bugs,
prefer a `MutationObserver` (fires regardless of tab focus) over `requestAnimationFrame`
/ `setInterval` sampling — a backgrounded headless tab throttles timers to ~1s,
which is too coarse to catch sub-second flashes. Example: count skeleton churn
and row add/remove around an action, then read the tallies back in a second
`eval`.

## Inspecting the session without logging out

```bash
cat <<'EOF' | ab eval --stdin
fetch("/api/iterate-auth/session", { credentials: "include" }).then(r => r.json())
EOF
```

Returns the decoded `expiresAt`, organizations, and projects the OS worker sees
— the fastest way to confirm what a token actually carries after a refresh.
