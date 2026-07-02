# Preview Agent Browser Smoke

Use this when you need to prove that a deployed OS preview works through the
real browser, Iterate Auth Worker, TanStack Start routing, and the app UI.

## Existing Smoke

`pnpm e2e -t "OS preview smoke"` runs `apps/os/e2e/vitest/preview-smoke.e2e.test.ts`.
It verifies the preview worker, unauthenticated redirect behavior, admin-token project setup, and
MCP and itx metadata wiring.

The itx e2e suites (`apps/os/e2e/vitest/`) run through the same `pnpm e2e`
config. Slack coverage lives in `apps/os/e2e/vitest/slack-agent.e2e.test.ts` (synthetic
signed-webhook smoke through the integrations domain).

## Authenticated Browser Smoke

Preview OS configs use the production Iterate Auth Worker as their issuer. Run
the OAuth client sync first if the preview was freshly created or auth callback
URLs changed:

```bash
doppler run --project auth --config prd -- \
  pnpm --dir apps/os auth:sync-clients
```

Create or reuse an auth-worker user that has access to the target organization
and project. Then open the preview and complete the auth-worker sign-in flow:

```bash
agent-browser open https://os.iterate-preview-2.com/projects/<projectSlug>/streams
agent-browser wait 5000
agent-browser snapshot -i
```

The snapshot should show the project-bound Streams page, including the
breadcrumb, filter/create combo box, `Reset`, `Create stream`, and the sortable
`Stream path`, `Created`, and `Woke` table headers.

To prove the UI can mutate deployed state, create a stream from the combo box:

```bash
agent-browser fill @COMBOBOX_REF agent-browser-ui-smoke
agent-browser click @CREATE_STREAM_BUTTON_REF
agent-browser wait 3000
agent-browser snapshot -i
agent-browser get url
```

The final URL should be:

```text
https://os.iterate-preview-2.com/projects/<projectSlug>/streams/agent-browser-ui-smoke
```

Close the browser when the smoke is done:

```bash
agent-browser close
```

## Unattended sign-in (no human, no CDP prompt) — verified 2026-06-10

Use a dedicated **headless** Chrome (never the user's real Chrome — that triggers
macOS prompts and reads their tabs). On this machine `~/.zshrc` sets
`AGENT_BROWSER_AUTO_CONNECT=1`, so always pass `AGENT_BROWSER_AUTO_CONNECT=0`
and a dedicated `--cdp` port:

```bash
agent-browser install   # one-time
BIN="$HOME/.agent-browser/browsers/chrome-149.0.7827.55/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
nohup "$BIN" --headless=new --remote-debugging-port=9444 --user-data-dir=/tmp/ab-own about:blank >/tmp/ab.log 2>&1 & disown
AB() { AGENT_BROWSER_AUTO_CONNECT=0 agent-browser --cdp 9444 "$@"; }
```

The hosted login UI (`auth.iterate.com/login`) **only offers "Continue with
Google"** — there is no email/password form to fill, and sign-up is disabled
(`apps/auth/src/server/auth.ts`). So you cannot log in by filling a form. Instead
authenticate the bootstrap admin against better-auth's **API**, inject the
resulting session cookies, then let the OAuth flow complete:

1. **Sign in via the better-auth API** (email/password IS enabled at the API
   level even though the UI hides it). Keep the secret in a shell var — never
   echo it:

   ```bash
   export SECRET=$(doppler secrets get SERVICE_AUTH_TOKEN --project auth --config prd --plain)
   curl -s -c /tmp/auth.txt -X POST https://auth.iterate.com/api/auth/sign-in/email \
     -H 'content-type: application/json' \
     --data "$(python3 -c 'import json,os;print(json.dumps({"email":"admin@nustom.com","password":os.environ["SECRET"]}))')"
   ```

   - email: `admin@nustom.com` (`BOOTSTRAP_ADMIN_EMAIL`)
   - password: the auth worker's `SERVICE_AUTH_TOKEN` (Doppler `auth/prd`)

2. **Inject the `__Secure-better-auth.session_{token,data}` cookies** into the
   browser (`AB cookies set --curl <json>`; the jar uses `#HttpOnly_` lines —
   strip that prefix when converting to the JSON importer shape).
3. **Run the OS OAuth flow**: `AB open https://os.iterate-preview-N.com/api/iterate-auth/login`.
   With the session present it lands on `auth.iterate.com/consent`.
4. **Approve consent.** The consent button is React-wired; a plain `click` may
   not fire it and the signed consent URL has a short `exp`, so click fast via
   the DOM:
   ```bash
   AB wait --text "Allow access"
   echo 'const b=[...document.querySelectorAll("button")].find(x=>/allow access/i.test(x.textContent)); if(b) b.click(); true;' | AB eval --stdin
   ```
   It redirects through the OS callback and lands on `/projects`, authenticated.
5. `AB state save /tmp/os-auth.json` immediately.

Previews authenticate against **production** auth (`auth.iterate.com`), so this
works against preview hosts too. For a fresh non-admin user, provision it
via the auth worker's service-token-gated internal oRPC API
(`internal.user.upsertVerifiedEmail` + `internal.organization.createForUser`).

### Driving a real agent conversation

```bash
AB open https://os.iterate-preview-N.com/new-project   # the slug create form
AB fill @<slug-textbox> my-smoke && AB click @<create-button>   # lands on /projects/my-smoke
AB open https://os.iterate-preview-N.com/projects/my-smoke/agents/streams/my-agent
AB fill @<message-box> "What is 7 times 6? Reply with just the number."
AB click @<send-button>
```

Verify the agent actually answered (the live UI may not update — see gotchas):

```bash
doppler run --config preview_N -- pnpm cli itx run \
  --context <prj_id> \
  --eval 'return await itx.agents.get("/agents/my-agent").processor.getRuntimeState()'
```

### Gotchas (hit and confirmed 2026-06-10)

- **The OS session JWT is short-lived.** If project-scoped pages start throwing
  `Project <id> not found` in the error boundary, the access token expired —
  re-run the sign-in flow. It is NOT a data/permissions bug; the same procedures
  succeed over direct RPC with a fresh cookie.
- **Live stream display uses WebSocket.** If sent messages and agent replies do
  not render live in the browser even though the conversation completes
  server-side, verify the agent state through `pnpm cli itx run` and inspect the
  `/api/itx` WebSocket path in Workers logs.
- Don't `agent-browser close` the `--cdp` instance (it kills the browser);
  `pkill -f ab-own` to clean up.
