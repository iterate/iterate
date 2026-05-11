# Secrets Domain

Secrets owns project-level credential material and provider connection records
for the current OS2 POC.

This POC deliberately stores Secrets in D1 and exposes raw Secret material
through a project-bound `SecretsCapability`. Longer-term Project Egress and
Secret Durable Object work can move material behind a narrower trusted runtime
boundary.

Provider Connections are project-level only for this slice. Webhook-driven
providers can claim a provider webhook identifier, such as a Slack team ID, and
that identifier must resolve to exactly one ProjectId.

## Provider Claims

A Provider Claim is the routing edge between a third-party identifier and an
OS2 Project. The third party owns the identifier; OS2 owns the claim.

Slack is the first concrete claim:

- Provider: `slack`
- Webhook Provider Identifier: Slack `team_id`
- Claim owner: exactly one `ProjectId`
- Integration stream: that project's stream namespace at `/integrations/slack`
- Processor slug: `slack`

This means one Slack team cannot forward signed webhooks into two projects at
the same time. Reconnecting Slack in the same project can replace that project's
Slack connection, but connecting a Slack team already claimed by another project
must fail before writing a new connection or secret.

Future webhook-driven integrations should follow the same shape: identify the
provider-owned webhook routing key, store it in
`project_connections.webhook_provider_identifier`, enforce global uniqueness for
that provider, and route inbound webhooks by resolving that claim to a ProjectId.

Google is project-scoped for this slice:

- Provider: `google`
- Lifecycle stream: that project's stream namespace at `/integrations/google`
- Future processor slug: `google-integration`

OAuth callbacks manually append `events.iterate.com/slack/connected`
and `events.iterate.com/google-integration/connected` for now. Disconnect
actions manually append the matching `/disconnected` events. Future
`slack` and `google-integration` stream processors should own this
event vocabulary.
