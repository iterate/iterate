---
state: done
priority: high
size: large
dependsOn: []
---

# Slack and Google Auth POC Implementation Log

Started: 2026-05-11
Completed: 2026-05-11

## Objective

Take a first crack at an end-to-end working OS2 implementation for Slack and
Google auth, keeping it clean and simple as a POC.

Explicit scope from the working session:

- OAuth client settings are OS2 Runtime Config, loaded from Doppler.
- There are only project-level Secrets and project-level Connections for now.
- `getSecret` returns raw secret material plus metadata for this slice.
- Slack team claiming is important: a Slack team/webhook identifier can be bound
  to exactly one ProjectId.
- Slack webhooks should be validated, mapped to a project, then appended to that
  project's stream namespace at `/slack/webhooks`.
- Basic CRUD for Secrets should be available as codemode tools.
- Egress proxy is out of scope.

## POC Decisions

### D1-backed project Secrets and Connections

For this first POC, Secrets and Connections are stored in OS2 D1 tables rather
than Secret Durable Objects. This is intentionally smaller than the longer-term
architecture. OAuth callbacks and webhook routing need indexed lookups, and the
POC goal is end-to-end Slack/Google auth rather than proving the Secret DO.

This means:

- `project_secrets` stores raw secret material and JSON metadata.
- `project_connections` stores provider connection rows and the webhook provider
  identifier used for claims, such as Slack `team_id`.
- `oauth_states` stores short-lived OAuth state for Slack/Google callbacks.

### Project-level only

OS1 Google was user-scoped, but OS2 POC Google is project-scoped. There are no
user-level, org-level, or global Secrets in this slice.

### Raw `getSecret`

The `SecretsCapability` codemode provider returns raw material and metadata from
`getSecret`. This is intentionally permissive for the POC. Later Project Egress
work can reintroduce Secret References and narrower policy.

### Provider claims

Webhook-driven providers can have claim semantics. Slack uses the Slack team ID
as the Webhook Provider Identifier. The POC enforces uniqueness on
`(provider, webhook_provider_identifier)` so one Slack team maps to one ProjectId
for webhook forwarding.

## Implementation Notes

- Runtime config uses structured `integrations.slack` and
  `integrations.google` fields in `AppConfig`.
- Doppler `os2/dev_jonas` now has the corresponding
  `APP_CONFIG_INTEGRATIONS__...` values copied from `os/dev_jonas`.
- The D1 schema change is captured in
  `src/db/migrations/0010_project_connections_and_secrets.sql` and the sqlfu
  generated table registry.
- `src/domains/secrets` owns project Secrets, Connections, OAuth state helpers,
  OAuth provider helpers, Slack webhook handling, and the project-bound
  `SecretsCapability`.
- Slack OAuth is implemented with direct `fetch()` calls to Slack OAuth v2 and
  `auth.revoke`; no `@slack/web-api` dependency is added.
- Google OAuth is implemented with direct PKCE helpers and token/userinfo
  `fetch()` calls; no `arctic` dependency is added.
- Webhook handling is mounted under `/api/integrations/slack/webhook` in the
  existing TanStack Start API catch-all route before oRPC fallback.
- The Integrations UI is project-scoped at
  `/orgs/$organizationSlug/projects/$projectSlug/integrations`.
- The project sidebar includes an Integrations entry with Slack and Google
  connect/disconnect buttons on the route.

## Verification

- `pnpm --dir apps/os2 typecheck`
- `pnpm --dir apps/os2 test -- src/app.test.ts`
- `git diff --check`

`pnpm --dir apps/os2 sqlfu:check` could not run because
`.alchemy/local/wrangler.jsonc` is missing; the local Alchemy config needs to be
materialized with `pnpm alchemy:up` or `pnpm dev` before that check can connect.

Manual OAuth callback/webhook verification was not run in this turn; the code is
ready for testing against the configured Slack/Google apps once a dev OS2
instance is running.
