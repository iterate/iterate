# Headless local debugging (drive the full OS + Auth stack)

How to reproduce UI/auth bugs against a **local** OS + Auth stack with a
scripted headless browser: sign in via test OTP, create orgs/projects, drive
OAuth, and read server state directly. Complements
[preview-agent-browser-smoke.md](./preview-agent-browser-smoke.md), which drives
a _deployed_ preview against _production_ auth.

## When to use which environment

- **Deployed preview** (`os.iterate-preview-N.com`): uses production auth. No
  test OTP — you sign in as a real allowlisted user. Best for final proof.
- **Local stack** (this doc): `pnpm dev` runs OS on the `os.iterate-dev-<you>`
  Cloudflare dev tunnel and Auth on `http://localhost:7101`, against a local D1
  (miniflare) you can read and write directly. Best for fast iteration and for
  bugs that need many synthetic events / fresh orgs.

## Bring up the local stack

```bash
pnpm dev   # monorepo root: starts apps/auth (localhost:7101) AND apps/os (dev tunnel)
```

`pnpm dev` exports `ITERATE_OAUTH_ISSUER=http://localhost:7101/api/auth` and
points OS at it. OS still serves on its **dev tunnel hostname**
(`https://os.iterate-dev-<you>.com`), not `localhost` — the OAuth `redirect_uri`
is the tunnel callback, so drive the browser against the tunnel host, not
`localhost:5173`.

Gotchas:

- The Doppler scope for `apps/auth` must resolve to a config that exists. If
  `pnpm dev` dies with `Could not find requested config 'dev_<you>'`, point it
  at the shared dev config: `doppler configure set config dev --scope apps/auth`.
- A loopback issuer signs tokens with the **local** auth keys, so a static
  production JWKS can't verify them. `apps/os/alchemy.run.ts` detects a loopback
  issuer and skips the static JWKS (falls back to runtime JWKS fetch).

## Headless browser without touching the user's Chrome

`~/.zshrc` sets `AGENT_BROWSER_AUTO_CONNECT=1`, which attaches to the user's
real Chrome (prompts + reads their tabs). For autonomous work launch a
dedicated, isolated, headless Chrome for Testing and drive it over CDP:

```bash
agent-browser install   # one-time: bundled Chrome for Testing
BIN="$HOME/.agent-browser/browsers/chrome-149.0.7827.54/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
nohup "$BIN" --headless=new --remote-debugging-port=9444 --user-data-dir=/tmp/ab-own about:blank >/tmp/ab-own.log 2>&1 & disown

# AUTO_CONNECT=0 overrides the .zshrc default so it never touches the user's Chrome.
# Use an isolated --session so refs/cookies don't collide with other work.
export AGENT_BROWSER_AUTO_CONNECT=0
ab() { agent-browser --session dbg --cdp 9444 "$@"; }
ab open https://os.iterate-dev-<you>.com/
```

- The browser keeps its profile in `--user-data-dir`, so an `iterate_session`
  cookie survives a _page reload_ but a fresh Chrome process is a clean slate.
- `ab state save /tmp/dbg-state.json` / `state load` persists cookies +
  localStorage across Chrome restarts (Chrome for Testing is occasionally
  OOM-killed by local dev rebuilds — save state once logged in).
- Do **not** `agent-browser close` the `--cdp` instance (it kills the browser).
  Clean up with `pkill -f ab-own`.

## Sign in with a test user (OTP)

Local/non-prod auth enables email OTP and a deterministic code:

- Any email matching `/\+.*test@/i` skips email send and accepts OTP **`424242`**
  (see `apps/auth/src/server/auth-plugins.ts`).
- Sign-_up_ is gated by `SIGNUP_ALLOWLIST` (auth Doppler). The local list allows
  `*@nustom.com`, `testuser+*@gmail.com`, etc. A brand-new email outside the
  allowlist returns `403 "Sign up is not available for this email address"`, so
  use e.g. `testuser+<scenario>@gmail.com`.

Flow (snapshot between steps; refs go stale on every navigation):

```bash
ab open https://os.iterate-dev-<you>.com/
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
- **Project**: the OS UI route is `/new-project`, but you can create directly
  against the OS oRPC REST surface from the authenticated page:

```bash
cat <<'EOF' | ab eval --stdin
(async () => {
  const res = await fetch("/api/projects", {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ slug: "dbgproj" }),
  });
  return { status: res.status, body: await res.text() };
})()
EOF
```

Project claims only land in the JWT on the next token refresh (or a fresh
sign-in), so a just-created project is visible to the creating session via its
seeded query cache but not to a cold reload until the access token reissues.

## Read local server state directly

Local D1 lives as miniflare SQLite files. There is one file per database; grep
the tables to tell auth from OS:

```bash
ls .alchemy/miniflare/v3/d1/miniflare-D1DatabaseObject/*.sqlite
# auth DB has: user, account, organization, member, oauthClient, oauthRefreshToken, verification
# OS DB has:   projects, ingress_routes, project_connections, ...

DB=.alchemy/miniflare/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
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
