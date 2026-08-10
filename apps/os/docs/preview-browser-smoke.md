# Preview browser smoke (Playwriter)

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

Preview OS configs use the matching slot's Iterate Auth Worker as their issuer.
The preview provisioner creates the clients and Doppler configs; run it when
setting up slots or rotating their auth credentials:

```bash
doppler run --project _shared --config prd -- \
  pnpm preview provision-auth-preview-configs
```

Create or reuse an auth-worker user that has access to the target organization
and project. Then open the preview with Playwriter headless:

```bash
SID=$(playwriter session new --browser headless 2>&1 | sed -n 's/^Session \([0-9][0-9]*\) created.*/\1/p')
playwriter -s "$SID" --timeout 60000 -e "$(cat <<'EOF'
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage());
await state.page.goto('https://os.iterate-preview-2.com/projects/<projectSlug>/streams', { waitUntil: 'domcontentloaded' });
console.log(await snapshot({ page: state.page }));
EOF
)"
```

The snapshot should show the project-bound Streams page, including the
breadcrumb, filter/create combo box, `Reset`, `Create stream`, and the sortable
`Stream path`, `Created`, and `Woke` table headers.

To prove the UI can mutate deployed state, create a stream from the combo box
using locators from a fresh `snapshot()` (fill + click create), then confirm the
URL ends with something like:

```text
https://os.iterate-preview-2.com/projects/<projectSlug>/streams/playwriter-ui-smoke
```

## Unattended sign-in (no human)

Use **headless** Playwriter (never the user's real Chrome for unattended
automation). Example:

```bash
playwriter browser install   # one-time Chrome for Testing
SID=$(playwriter session new --browser headless 2>&1 | sed -n 's/^Session \([0-9][0-9]*\) created.*/\1/p')
```

For a fully unattended admin session, authenticate the slot's bootstrap admin
against better-auth's API, inject the resulting session cookies into the
Playwright context, then let the OAuth flow complete:

1. **Sign in via the better-auth API** (email/password IS enabled at the API
   level even though the UI hides it). Keep the secret in a shell var — never
   echo it:

   ```bash
   export AUTH_ORIGIN=https://auth.iterate-preview-N.com
   export SECRET=$(doppler secrets get APP_CONFIG_SERVICE_AUTH_TOKEN --project auth --config preview_N --plain)
   curl -s -c /tmp/auth.txt -X POST "$AUTH_ORIGIN/api/auth/sign-in/email" \
     -H 'content-type: application/json' \
     --data "$(python3 -c 'import json,os;print(json.dumps({"email":"admin@nustom.com","password":os.environ["SECRET"]}))')"
   ```

   - email: `admin@nustom.com` (`BOOTSTRAP_ADMIN_EMAIL`)
   - password: the auth worker's `APP_CONFIG_SERVICE_AUTH_TOKEN` (Doppler `auth/prd`)

2. **Inject the `__Secure-better-auth.session_{token,data}` cookies** into the
   Playwriter page context (Playwright `context.addCookies` from the jar).
3. **Run the OS OAuth flow**: navigate to
   `https://os.iterate-preview-N.com/api/iterate-auth/login`.
   With the session present it lands on the matching preview auth consent page.
4. **Approve consent** via snapshot + click (React-wired buttons need a real
   click / DOM activation, not a silent evaluate unless needed).
5. Land on `/projects`, authenticated.

Each preview authenticates against its own `auth.iterate-preview-N.com` worker
and D1 database. For a fresh non-admin user, provision it via that auth
worker's service-token-gated internal oRPC API
(`internal.user.upsertVerifiedEmail` + `internal.organization.createForUser`).

### Driving a real agent conversation

Use snapshot → fill message → click send on the agent stream URL, then verify
server state with `pnpm cli itx run` if the live UI does not update.

### Gotchas

- **The OS session JWT is short-lived.** If project-scoped pages start throwing
  `Project <id> not found` in the error boundary, re-run the sign-in flow.
- **Live stream display uses WebSocket.** If messages do not render live, verify
  via `pnpm cli itx run` and Workers logs.
