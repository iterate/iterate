# GitHub Apps for preview environments

Each preview slot needs its own GitHub App. GitHub sends every installation's
events to the single webhook URL configured on its App, so sharing an App would
route all preview traffic to one slot.

| OS config   | GitHub App            | URL base                           |
| ----------- | --------------------- | ---------------------------------- |
| `preview_N` | `iterate (preview-N)` | `https://os.iterate-preview-N.com` |
| `prd`       | `iterate`             | `https://os.iterate.com`           |

Do not reuse the production App. For the full expansion sequence, see
[Adding preview slots](../../../docs/adding-preview-slots.md).

## Safety boundary

The App Manifest flow is the only supported way to automate GitHub App
creation. It intentionally includes a GitHub review page; there is no direct
`POST /apps` API.

An agent may render manifests, start a local callback receiver, and open review
pages without changing GitHub. Before clicking Create, a human must approve:

- the `iterate` organization;
- the exact App names;
- the callback and webhook hostnames;
- the permission set;
- the matching `os/preview_N` Doppler writes.

That approval may cover a concrete batch such as slots 10–19. Stop on a name
collision, different organization, changed permissions, 2FA, or CAPTCHA. Never
create a near-duplicate to work around an existing App.

Use a dedicated, headed automation browser profile. Playwriter controls a
person's existing Chrome, so use it only with explicit permission for the
current task.

## Manifest

Replace every `N` with the slot number. Preview OS URLs use `.com`; `.app` is
the hosted-project domain. `default_permissions` uses GitHub's manifest/API
permission keys, which differ from several labels shown in the settings UI.
The manifest below was accepted by GitHub's review flow on 2026-07-20.

```json
{
  "name": "iterate (preview-N)",
  "url": "https://os.iterate-preview-N.com",
  "description": "Iterate AI coding agent — preview-N",
  "public": false,
  "request_oauth_on_install": true,
  "setup_on_update": true,
  "hook_attributes": {
    "url": "https://os.iterate-preview-N.com/api/integrations/github/webhook",
    "active": true
  },
  "callback_urls": ["https://os.iterate-preview-N.com/api/integrations/github/callback"],
  "redirect_url": "http://localhost:3333/github-app-created",
  "default_permissions": {
    "actions": "write",
    "administration": "write",
    "attestations": "write",
    "checks": "write",
    "security_events": "write",
    "statuses": "write",
    "contents": "write",
    "vulnerability_alerts": "write",
    "deployments": "write",
    "discussions": "write",
    "environments": "write",
    "issues": "write",
    "metadata": "read",
    "pages": "write",
    "pull_requests": "write",
    "repository_advisories": "write",
    "secret_scanning_alerts": "write",
    "secrets": "read",
    "actions_variables": "read",
    "repository_hooks": "write",
    "workflows": "write",
    "merge_queues": "read",
    "members": "read",
    "organization_administration": "write",
    "organization_projects": "write",
    "emails": "read"
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

`request_oauth_on_install` gives OS a user-to-server token after installation;
that is needed for user-scoped actions such as creating a personal repository.
The Check Runs API requires a GitHub App and `checks: write`.
`installation_repositories` is sent automatically to GitHub Apps and is not a
valid explicit subscription. The `merge_group` subscription requires
`merge_queues: read` even though the GitHub settings UI describes it as the
Merge queues permission.

## Agent-led creation

For a batch, use a small local helper rather than ad-hoc shell pipelines. It
must:

1. render one manifest and a cryptographically random `state` per slot;
2. start a callback server on loopback before opening GitHub;
3. map each callback to its slot by `state`, reject missing or repeated state,
   and capture the one-time `code` without logging it;
4. POST the code to `/app-manifests/{code}/conversions` within one hour;
5. validate the returned slug and IDs;
6. pipe the credential object directly into the matching Doppler config;
7. record only non-secret App ID, slug, slot, and verification state.

Do not use a background server whose stdout is disconnected from the process
that performs conversion. The old bulk example did that and could never
reliably recover the callback code.

Open each manifest with a POST to:

```text
https://github.com/organizations/iterate/settings/apps/new
```

The form field is named `manifest`. GitHub shows a review page. After the human
approves the exact batch, the agent can drive the Create buttons in its
dedicated browser session and let the callback helper complete each conversion.

The conversion endpoint returns `id`, `slug`, `client_id`, `client_secret`,
`webhook_secret`, and `pem`. Treat the complete response as secret material.

## Doppler shape

Write `APP_CONFIG_INTEGRATIONS__GITHUB` to `os/preview_N`:

```json
{
  "appId": "12345678",
  "appSlug": "iterate-preview-N",
  "oauthClientId": "Iv23li...",
  "oauthClientSecret": "...",
  "webhookSecret": "...",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
}
```

The runtime field is `webhookSecret`, not `webhookSigningSecret`. Preserve the
PEM newlines returned by GitHub. Never print the value to verify it; parse it
inside `doppler run` and assert that the required keys are non-empty.

## Verify

After writing Doppler and deploying OS:

1. Create an App JWT from the Doppler config.
2. Call `GET /app` and require the exact slug `iterate-preview-N`.
3. Call `GET /app/hook/config` and require the exact `.com` webhook URL.
4. Install the App through OS's Connect GitHub flow for a test project.
5. Deliver a real webhook and verify its signature and resulting project
   state, not merely an HTTP 200.

Do not hardcode installation-token lengths. GitHub supports both legacy and
new stateless token formats during its transition.

## Troubleshooting

- **Name already exists:** stop and inspect its owner, URLs, permissions, and
  credentials. Reconcile it or obtain explicit approval for a replacement.
- **Callback has no code:** check that the receiver was listening before the
  form opened and that GitHub used the exact loopback redirect URL.
- **State mismatch:** discard the callback. Do not convert it.
- **JWT error:** the private key may contain escaped `\\n` instead of PEM
  newlines, or belong to a different App.
- **Webhook mismatch:** compare `GET /app/hook/config` with the slot's exact
  `.com` URL. Rotate only with explicit approval.
- **OAuth callback fails:** require
  `https://os.iterate-preview-N.com/api/integrations/github/callback`; GitHub
  does not allow wildcard callback URLs.
- **No project reacts:** the App may not be installed through OS for that
  project, even if App authentication succeeds.

## References

- [GitHub App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [App Manifest conversion API](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest)
- [GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [Check Runs API](https://docs.github.com/en/rest/checks/runs)
