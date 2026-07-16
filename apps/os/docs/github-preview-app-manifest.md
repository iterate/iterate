# GitHub Apps for preview environments

Use this runbook when you need to create or repair the GitHub App for an OS
preview slot, or when setting up a new developer environment app.

Each preview slot and developer environment gets its own GitHub App so that
webhook delivery is isolated: GitHub routes every event for a given installation
to exactly one webhook URL, and that URL is set at the app level, not the
installation level.

For the Doppler secrets shape and the integration runtime, see
[`apps/os/docs/integrations-and-secrets-design.md`](integrations-and-secrets-design.md).

| OS config   | GitHub App name       | Webhook URL base                   |
| ----------- | --------------------- | ---------------------------------- |
| `dev_<you>` | `iterate (dev-<you>)` | `https://os.iterate-dev-<you>.app` |
| `preview_N` | `iterate (preview-N)` | `https://os.iterate-preview-N.app` |
| `prd`       | `iterate`             | `https://os.iterate.com`           |

Do not reuse the production GitHub App for previews, and do not point one GitHub
App at multiple preview slots. Each GitHub App has exactly one webhook URL.

## Why GitHub Apps and not OAuth Apps

GitHub Apps authenticate at the installation level (per repo/org) rather than
the user level, which gives:

- **Check Runs API** — exclusive to GitHub Apps. Creates inline PR annotations
  with action buttons that fire webhook events back to OS. OAuth Apps cannot
  create check runs at all.
- **Higher rate limits** — 5 000 req/hr baseline, up to 12 500 for large
  installations, versus 5 000/hr total for a PAT.
- **Scoped permissions** — repositories only grant the minimum required access;
  user tokens via `request_oauth_on_install: true` give user-scoped actions
  (creating personal repos, acting as the user).
- **Webhook signatures** — every payload is signed with the app's webhook
  secret, verified in OS before any processing.

## Manifest

This is the maximal manifest for a full AI coding-agent integration. Replace
every `N` placeholder with the slot number (hyphen form in names and hostnames,
underscore form only for Doppler config names). Replace `<you>` for dev apps.

The manifest targets the **GitHub App Manifest flow** (see below) — paste this
JSON into the creation form in one step.

```json
{
  "name": "iterate (preview-N)",
  "url": "https://os.iterate-preview-N.app",
  "description": "Iterate AI coding agent — preview-N",
  "public": false,
  "request_oauth_on_install": true,
  "setup_on_update": true,
  "hook_attributes": {
    "url": "https://os.iterate-preview-N.app/api/integrations/github/webhook",
    "active": true
  },
  "callback_urls": ["https://os.iterate-preview-N.app/api/integrations/github/callback"],
  "redirect_url": "http://localhost:3333/github-app-created",
  "default_permissions": {
    "actions": "write",
    "administration": "write",
    "attestations": "write",
    "checks": "write",
    "code_scanning_alerts": "write",
    "commit_statuses": "write",
    "contents": "write",
    "dependabot_alerts": "write",
    "deployments": "write",
    "environments": "write",
    "issues": "write",
    "metadata": "read",
    "pages": "write",
    "pull_requests": "write",
    "repository_security_advisories": "write",
    "secret_scanning_alerts": "write",
    "secrets": "read",
    "variables": "read",
    "webhooks": "write",
    "workflows": "write",
    "members": "read",
    "organization_administration": "write",
    "projects": "write",
    "email_addresses": "read"
  },
  "default_events": [
    "branch_protection_rule",
    "check_run",
    "check_suite",
    "code_scanning_alert",
    "commit_comment",
    "create",
    "delete",
    "dependabot_alert",
    "deployment",
    "deployment_protection_rule",
    "deployment_review",
    "deployment_status",
    "discussion",
    "discussion_comment",
    "fork",
    "installation_repositories",
    "installation_target",
    "issue_comment",
    "issues",
    "label",
    "merge_group",
    "milestone",
    "projects_v2",
    "projects_v2_item",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "pull_request_review_thread",
    "push",
    "release",
    "repository",
    "repository_advisory",
    "repository_dispatch",
    "repository_ruleset",
    "secret_scanning_alert",
    "security_and_analysis",
    "status",
    "workflow_dispatch",
    "workflow_job",
    "workflow_run"
  ]
}
```

### Notable permissions

| Permission                           | What it unlocks                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `checks: write`                      | **Check Runs API** — exclusive to GitHub Apps; inline PR annotations with action buttons that POST back to OS |
| `contents: write`                    | Read/write files, create commits, manage releases                                                             |
| `workflows: write`                   | Create or update `.github/workflows/` YAML — lets the agent wire up its own CI                                |
| `actions: write`                     | Trigger `workflow_dispatch` and `repository_dispatch`, download run logs                                      |
| `organization_administration: write` | Create repos in orgs via installation token                                                                   |
| `email_addresses: read`              | User account permission; requires `request_oauth_on_install: true` to be useful                               |

`request_oauth_on_install: true` triggers GitHub's user OAuth flow immediately
after app installation, giving OS a user-to-server token in addition to the
installation token. This is required for creating repos in a user's personal
namespace (personal namespace repos can only be created by the user, not by an
installation token).

`setup_on_update: true` re-runs the setup redirect when the app's permissions
are updated, keeping existing installs in sync.

## How GitHub App creation works

GitHub does not expose a REST API endpoint for creating apps. There is no
`POST /apps`. The only supported path is the **App Manifest flow**:

1. You construct an HTML form that POSTs the manifest JSON to
   `https://github.com/organizations/iterate/settings/apps/new` (for org apps)
   or `https://github.com/settings/apps/new` (for personal apps).
2. The GitHub UI shows a review screen — the user clicks **Create GitHub App**.
   This is the one mandatory human interaction.
3. GitHub redirects to the `redirect_url` in your manifest with a `?code=`
   parameter (one-time use, expires in 1 hour).
4. Your server exchanges the code: `POST /app-manifests/{code}/conversions`.
   Response contains `id`, `pem` (RSA private key), `client_id`,
   `client_secret`, `webhook_secret`.

Everything except step 2 is scriptable. The typical bulk-creation pattern runs
a local HTTP server to capture the redirect automatically, reducing each app to
one browser click.

## Single app: browser flow

1. Open `https://github.com/organizations/iterate/settings/apps/new`.
2. In the **Register a new GitHub App** form, paste the filled manifest JSON
   into the **From a manifest** tab.
3. Click **Create GitHub App**.
4. Capture the credentials from the post-creation screen (**App ID**, download
   **private key**, note **Client ID**, **Client Secret**, **Webhook secret**).

If you included `"redirect_url": "http://localhost:3333/github-app-created"`,
GitHub will redirect there after creation with `?code=...`. You can exchange
the code immediately:

```bash
curl -s -X POST https://api.github.com/app-manifests/CODE_HERE/conversions \
  -H "Accept: application/vnd.github+json" \
  | jq '{id:.id, appSlug:.slug, clientId:.client_id, clientSecret:.client_secret, webhookSecret:.webhook_secret, pem:.pem}'
```

The `pem` field is the RSA private key. Store it as-is (with literal `\n`).

## Bulk creation: one-click-per-app script

For creating many apps at once (10 preview slots, multiple developer envs),
this pattern reduces each app to one browser click with automatic credential
capture.

```bash
#!/usr/bin/env bash
# Usage: ./create-github-app.sh 3
# Creates iterate (preview-3), writes credentials to Doppler os/preview_3.
# Requires: jq, doppler, nc or python3 -m http.server

N=$1
APP_NAME="iterate (preview-$N)"
BASE="https://os.iterate-preview-$N.app"
REDIRECT="http://localhost:3333/github-app-created"
PORT=3333

MANIFEST=$(jq -nc \
  --arg name "$APP_NAME" \
  --arg url "$BASE" \
  --arg desc "Iterate AI coding agent — preview-$N" \
  --arg webhook "$BASE/api/integrations/github/webhook" \
  --arg callback "$BASE/api/integrations/github/callback" \
  --arg redirect "$REDIRECT" \
  '{
    name: $name,
    url: $url,
    description: $desc,
    public: false,
    request_oauth_on_install: true,
    setup_on_update: true,
    hook_attributes: { url: $webhook, active: true },
    callback_urls: [$callback],
    redirect_url: $redirect,
    default_permissions: {
      actions:"write", administration:"write", attestations:"write",
      checks:"write", code_scanning_alerts:"write", commit_statuses:"write",
      contents:"write", dependabot_alerts:"write", deployments:"write",
      environments:"write", issues:"write", metadata:"read", pages:"write",
      pull_requests:"write", repository_security_advisories:"write",
      secret_scanning_alerts:"write", secrets:"read", variables:"read",
      webhooks:"write", workflows:"write", members:"read",
      organization_administration:"write", projects:"write",
      email_addresses:"read"
    },
    default_events: [
      "branch_protection_rule","check_run","check_suite","code_scanning_alert",
      "commit_comment","create","delete","dependabot_alert","deployment",
      "deployment_protection_rule","deployment_review","deployment_status",
      "discussion","discussion_comment","fork","installation_repositories",
      "installation_target","issue_comment","issues","label","merge_group",
      "milestone","projects_v2","projects_v2_item","pull_request",
      "pull_request_review","pull_request_review_comment",
      "pull_request_review_thread","push","release","repository",
      "repository_advisory","repository_dispatch","repository_ruleset",
      "secret_scanning_alert","security_and_analysis","status",
      "workflow_dispatch","workflow_job","workflow_run"
    ]
  }')

# Start a one-shot local server to capture the redirect code
echo "Starting local redirect capture server on :$PORT..."
python3 -c "
import http.server, urllib.parse, sys, os, signal

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.urlparse(self.path).query
        code = urllib.parse.parse_qs(q).get('code', [None])[0]
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'<h1>App created — you can close this tab.</h1>')
        print('CODE=' + (code or ''), flush=True)
        signal.raise_signal(signal.SIGTERM)
    def log_message(self, *a): pass

http.server.HTTPServer(('localhost', $PORT), Handler).serve_forever()
" &
SERVER_PID=$!

# Open GitHub's app creation page with the manifest pre-filled
FORM_HTML=$(mktemp /tmp/gh-app-XXXXXX.html)
cat > "$FORM_HTML" <<HTML
<!doctype html><html><body>
<form method="post" action="https://github.com/organizations/iterate/settings/apps/new">
  <input type="hidden" name="manifest" value='$MANIFEST'>
  <button type="submit">Open GitHub App creation form</button>
</form>
<script>document.forms[0].submit();</script>
</body></html>
HTML
open "$FORM_HTML"

echo "Waiting for GitHub redirect..."
CODE=$(while read line; do
  [[ "$line" == CODE=* ]] && echo "${line#CODE=}" && break
done < <(python3 - <<EOF
# already started above — this just reads stdout
EOF
))

kill $SERVER_PID 2>/dev/null
rm -f "$FORM_HTML"

if [[ -z "$CODE" ]]; then
  echo "No code captured. Did you click 'Create GitHub App' in the browser?" >&2
  exit 1
fi

echo "Exchanging code for credentials..."
CREDS=$(curl -sf -X POST "https://api.github.com/app-manifests/$CODE/conversions" \
  -H "Accept: application/vnd.github+json")

APP_ID=$(echo "$CREDS" | jq -r '.id')
APP_SLUG=$(echo "$CREDS" | jq -r '.slug')
CLIENT_ID=$(echo "$CREDS" | jq -r '.client_id')
CLIENT_SECRET=$(echo "$CREDS" | jq -r '.client_secret')
WEBHOOK_SECRET=$(echo "$CREDS" | jq -r '.webhook_secret')
PEM=$(echo "$CREDS" | jq -r '.pem')

echo "Created app: $APP_NAME (id=$APP_ID slug=$APP_SLUG)"

# Write to Doppler
jq -nc \
  --arg appId "$APP_ID" \
  --arg appSlug "$APP_SLUG" \
  --arg clientId "$CLIENT_ID" \
  --arg clientSecret "$CLIENT_SECRET" \
  --arg webhookSecret "$WEBHOOK_SECRET" \
  --arg privateKey "$PEM" \
  '{appId:$appId, appSlug:$appSlug, oauthClientId:$clientId,
    oauthClientSecret:$clientSecret, webhookSigningSecret:$webhookSecret,
    privateKey:$privateKey}' |
  doppler secrets set APP_CONFIG_INTEGRATIONS__GITHUB \
    --project os \
    --config "preview_$N" \
    --silent

echo "Written to Doppler os/preview_$N. Verify:"
doppler secrets get APP_CONFIG_INTEGRATIONS__GITHUB \
  --project os \
  --config "preview_$N" \
  --plain | jq -e '.appId and .oauthClientId and .privateKey and .webhookSigningSecret' >/dev/null && \
  echo "Shape OK." || echo "Shape check failed — inspect the value." >&2
```

Run it ten times in parallel:

```bash
for N in 1 2 3 4 5 6 7 8 9 10; do
  ./create-github-app.sh $N &
done
wait
```

Each invocation opens a browser tab at GitHub's app creation form. Click
**Create GitHub App** in each tab (you can batch the clicks). Credentials are
written to Doppler automatically after each redirect.

## Credential shape in Doppler

The key is `APP_CONFIG_INTEGRATIONS__GITHUB` in each `os/preview_N` config.

```json
{
  "appId": "12345678",
  "appSlug": "iterate-preview-N",
  "oauthClientId": "Iv23li...",
  "oauthClientSecret": "...",
  "webhookSigningSecret": "...",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
}
```

The `privateKey` must include the PEM header/footer with literal `\n` newlines
(as returned by the manifest conversion API). GitHub's JWTs use RS256; `appId`
is the `iss` claim, max 10-minute lifetime.

Write it manually if you collected credentials from the GitHub UI instead of
via the manifest flow:

```bash
jq -nc \
  --arg appId "$APP_ID" \
  --arg appSlug "$APP_SLUG" \
  --arg clientId "$CLIENT_ID" \
  --arg clientSecret "$CLIENT_SECRET" \
  --arg webhookSecret "$WEBHOOK_SECRET" \
  --arg privateKey "$PEM" \
  '{appId:$appId, appSlug:$appSlug, oauthClientId:$clientId,
    oauthClientSecret:$clientSecret, webhookSigningSecret:$webhookSecret,
    privateKey:$privateKey}' |
  doppler secrets set APP_CONFIG_INTEGRATIONS__GITHUB \
    --project os \
    --config preview_N \
    --silent
```

## Installation token format

As of April 2026, GitHub is transitioning installation tokens from the
legacy 40-character `ghs_…` format to a stateless `ghs_APPID_JWT` format
(~520 characters). Both formats are valid during the transition. Do not
hardcode token length limits anywhere in OS.

## Smoke test

After writing Doppler and redeploying:

```bash
(cd apps/os && doppler run --project os --config preview_N -- pnpm run deploy)
```

Verify the app credentials are valid (does not require an installation):

```bash
# from apps/os, using the preview_N Doppler config
doppler run --project os --config preview_N -- node -e "
const cfg = JSON.parse(process.env.APP_CONFIG_INTEGRATIONS__GITHUB);
const { createAppAuth } = require('@octokit/auth-app');
const auth = createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey });
auth({ type: 'app' }).then(a => {
  require('node:https').get({
    hostname: 'api.github.com',
    path: '/app',
    headers: { Authorization: 'Bearer ' + a.token, 'User-Agent': 'iterate-smoke' }
  }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(JSON.parse(d).slug)); });
});
"
```

Expected output: `iterate-preview-N` (the app slug).

## Troubleshooting

- **JWT error / bad credentials**: the `privateKey` in Doppler may have escaped
  newlines (`\\n` rather than `\n`). The PEM must decode to a valid RSA key.
  Check with `echo "$KEY" | openssl rsa -check -noout`.
- **Webhook signature mismatch**: `webhookSigningSecret` in Doppler does not
  match the app's Webhook Secret in GitHub settings. Rotate the secret in
  GitHub, write the new value to Doppler, redeploy.
- **OAuth callback fails**: confirm the `callback_urls` list in the GitHub App
  settings contains exactly
  `https://os.iterate-preview-N.app/api/integrations/github/callback`. GitHub
  does not allow wildcard callback URLs.
- **Events arrive but no project reacts**: the app is not yet installed on any
  repo/org. Install it through the OS **Connect GitHub** flow for the intended
  project.
- **Rate limit 403s on check run creation**: the app token is rate-limited
  per installation (5 000/hr baseline). Requests to `/repos/{owner}/{repo}/check-runs`
  require the `checks: write` permission on the installation, not just the app.

## GitHub references

- App Manifest flow:
  <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/creating-a-github-app-from-a-manifest>
- App permissions reference:
  <https://docs.github.com/en/rest/overview/permissions-required-for-github-apps>
- Check Runs API:
  <https://docs.github.com/en/rest/checks/runs>
- Installation token exchange:
  <https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app>
- App Manifest conversion endpoint:
  <https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest>
