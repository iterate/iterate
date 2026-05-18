---
state: todo
priority: high
size: large
dependsOn: []
---

# GitHub Integration for OS

Captured: 2026-05-13

## Objective

Add a GitHub integration to OS that mirrors the Slack integration shape:

- GitHub App installation and connection state are project-scoped.
- Inbound GitHub webhooks are verified, resolved to the claimed project, and
  appended to a project integration stream.
- Codemode and agents get a GitHub API tool provider backed by Octokit and a
  GitHub App installation.

## Current Findings

Legacy `apps/os` GitHub integration was removed with the OS1 app. OS should implement GitHub using its existing stream and capability model from scratch.

Relevant OS foundations already exist:

- `project_connections` stores provider connection rows.
- `project_connections.webhook_provider_identifier` supports globally unique
  webhook routing claims, currently used by Slack team IDs.
- `project_secrets` stores project secrets for Slack/Google.
- `oauth_states` stores short-lived provider callback state.
- `src/domains/secrets/integration-api.ts` routes Slack/Google callbacks and
  Slack webhooks.
- Slack appends raw webhooks to `/integrations/slack` as
  `events.iterate.com/slack/webhook-received`.
- `SlackCapability` exposes `ctx.slack.*` by reading a project Slack token and
  calling the Slack Web API.

## Target Shape

Use provider name `github` in OS, not legacy `github-app`.

`project_connections` row:

- `provider`: `github`
- `external_id`: GitHub installation ID as a string
- `webhook_provider_identifier`: GitHub installation ID as a string
- `provider_data`:
  - `installationId`
  - `accountId`
  - `accountLogin`
  - `accountType`
  - `repositorySelection`
  - `installedByUserId`

Route inbound GitHub webhooks by `payload.installation.id`. This is the GitHub
equivalent of Slack routing by `team_id`.

Do not persist GitHub installation access tokens as long-lived project secrets.
GitHub App installation tokens expire quickly, so the GitHub codemode provider
should mint fresh installation-scoped Octokit clients from runtime GitHub App
config.

## Runtime Config

Extend `AppConfig.integrations` with GitHub App config:

- `appId`
- `appSlug`
- `privateKey`
- `webhookSecret`
- `oauthClientId` if using GitHub user OAuth during install
- `oauthClientSecret` if using GitHub user OAuth during install

Prefer Octokit's GitHub App client for installation-scoped API access:

- `new App({ appId, privateKey, webhooks: { secret } })`
- `app.getInstallationOctokit(installationId)`

Keep webhook signature verification explicit in the fetch handler, like Slack,
rather than depending on Node middleware.

## Integration API

Add handling in `src/domains/secrets/integration-api.ts`:

- `/api/integrations/github/callback`
- `/api/integrations/github/webhook`

Callback flow:

- Consume `oauth_states` for provider `github`.
- Require Clerk callback user to match the state user.
- Read `installation_id`.
- Build a GitHub App client.
- Fetch installation/account metadata.
- Check whether the installation ID is already claimed by another project.
- Upsert the `project_connections` row.
- Append `events.iterate.com/github/connected` to `/integrations/github`.
- Redirect back to the original callback URL.

Webhook flow:

- Read the raw body.
- Verify `x-hub-signature-256` using configured webhook secret.
- Require `x-github-event` and `x-github-delivery`.
- Parse JSON payload.
- Resolve `payload.installation.id`.
- Find the claimed project by `(provider, webhook_provider_identifier)`.
- Append to `/integrations/github`.

Suggested raw webhook event:

```ts
{
  type: "events.iterate.com/github/webhook-received",
  idempotencyKey: `github-webhook:${deliveryId}`,
  payload: {
    action,
    body,
    deliveryId,
    githubEvent,
    headers: {
      githubDelivery,
      githubEvent,
    },
    installationId,
    repositoryFullName,
  },
}
```

## Project RPC and UI

Add contract and router methods next to Slack/Google:

- `getGithubConnection`
- `startGithubInstallFlow`
- `disconnectGithub`
- `listGithubRepositories` if repo selection is needed

Update the integrations page to add a GitHub card with connect, disconnect,
connection metadata, token/material status where relevant, and scope/permission
summary if useful.

For install start, return:

```txt
https://github.com/apps/{appSlug}/installations/new?state={state}
```

## Codemode Provider

Add a GitHub capability entrypoint and export it from `entry.workerd.ts`.

Recommended first provider API:

```ts
ctx.github.request({
  route: "GET /repos/{owner}/{repo}/issues",
  owner,
  repo,
  per_page: 20,
});

ctx.github.paginate({
  route: "GET /repos/{owner}/{repo}/pulls",
  owner,
  repo,
  state: "open",
});
```

Capability behavior:

- Require `DB` binding and `projectId` props.
- Read the project GitHub connection.
- Extract `installationId`.
- Parse OS `AppConfig`.
- Create a GitHub App client.
- Get an installation-scoped Octokit.
- Dispatch `octokit.request(...)` or `octokit.paginate(...)`.
- Return a stable JSON response shape.

Register the provider in:

- `createDefaultCodemodeProviderRegistrations`
- `createExampleCapabilityProviders`
- `AgentDurableObject.createCodemodeToolProviders`
- codemode tests where provider lists are asserted

## Optional GitHub Processor

If GitHub webhooks should wake or drive agents, add a shared stream processor
after the base integration works.

Processor target:

- Mounted on `/integrations/github`.
- Slug: `github`.
- Reduces connected/disconnected state.
- Consumes `events.iterate.com/github/webhook-received`.
- Routes pull request events to a stream like
  `/agents/github/{owner}/{repo}/pulls/{number}`.
- Routes issue events to a stream like
  `/agents/github/{owner}/{repo}/issues/{number}`.
- Forwards the original webhook unchanged to the routed stream.
- Leaves agent semantics to a downstream GitHub agent processor or generic
  agent setup.

This should be a second slice. The first slice should prove connection,
webhook ingestion, and API capability.

## Dependencies

- Add `octokit` to `apps/os/package.json`.
- Regenerate lockfile with pnpm.
- If schema changes are needed, use sqlfu:
  - update `src/db/definitions.sql`
  - run `pnpm sqlfu:generate`
  - check generated migrations

No schema change is expected for the basic implementation because the existing
connections/secrets/oauth tables are generic enough.

## Testing Plan

- App config parsing accepts GitHub runtime config.
- Install URL generation creates a state row and correct GitHub App install URL.
- Callback rejects missing/expired state and user mismatch.
- Callback upserts a GitHub connection and emits a connected event.
- Callback rejects an installation already claimed by another project.
- Webhook handler rejects missing/invalid signature.
- Webhook handler rejects missing delivery/event/installation ID.
- Webhook handler appends a deduped raw event to `/integrations/github`.
- GitHubCapability fails clearly when no project connection exists.
- GitHubCapability uses an installation-scoped Octokit client and dispatches
  `request` and `paginate`.
- Integrations UI shows connected and disconnected states.

## Risks and Open Questions

- GitHub App permissions need deliberate design. The App settings must include
  every REST operation agents should use, such as contents, issues, pull
  requests, checks/actions, statuses, and metadata.
- Decide whether GitHub user OAuth is needed during installation. A pure App
  installation flow may be enough for project-level access.
- Decide whether OS1 config repo behavior belongs in OS. Current evidence says
  no for the first slice.
- Decide how PR/issue agent routing should work before adding a GitHub
  processor. Slack-style routing is a good model, but GitHub route keys and
  stream path naming need explicit product decisions.
