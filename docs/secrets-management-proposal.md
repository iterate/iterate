# Secrets and egress

This file used to be a proposal. It is now current implementation
documentation for project-scoped secrets, egress substitution, and integration
credential storage in OS itx.

## Current shape

Project secret material is path-addressed and write-only:

```ts
await itx.secrets.get("/secrets/openai").update({
  material: "...",
  egress: { urls: ["https://api.openai.com"] },
});
```

Secret paths are normalized and must start with `/secrets/`. The public secret
capability has `update`, `describe`, `fetch`, and `processor`, but no method
that returns material. `describe()` reports metadata only: whether material is
present, the egress allowlist, and usage audit counters.

The implementation lives in:

- `apps/os/src/domains/secrets/secret-durable-object.ts`
- `apps/os/src/domains/secrets/utils.ts`
- `apps/os/src/rpc-targets.ts`
- `apps/os/src/domains/projects/project-durable-object.ts`
- `apps/os/src/domains/projects/egress.ts`

## Using a secret in outbound requests

Outbound requests reference secrets with a header placeholder:

```ts
const request = new Request("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    authorization: 'Bearer getSecret({ path: "/secrets/openai" })',
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

const response = await itx.egress.fetch(request);
```

`getSecret({ path: "/secrets/..." })` is the current itx placeholder.
Substitution happens only inside the project egress path. Interceptors installed
with `itx.egress.intercept(handler)` run before substitution and see the
placeholder, never raw material.

The project Durable Object is the egress decision point:

1. If a live egress interceptor is installed, it handles the request before
   secret substitution.
2. Otherwise, the project DO scans request headers for `getSecret({ path })`
   placeholders.
3. If no secret is referenced, the request is fetched directly.
4. If exactly one secret is referenced, the request is forwarded to that
   Secret Durable Object.
5. The Secret DO checks that material exists and that the request origin
   matches one of the secret's allowed egress URL origins.
6. The Secret DO appends `events.iterate.com/secret/used`, substitutes matching
   header placeholders, and performs the terminal `fetch`.

Dynamic workers use the same egress door: their bare `fetch()` is wired through
`ProjectEgressEntrypoint`, which forwards to the project Durable Object.

## Security properties

- Secret material is encrypted before it is written to the secret stream state.
- The public secret surface cannot read material back.
- Egress allowlists are per secret and checked by URL origin.
- Usage is recorded in the secret's stream as audit data.
- Secret substitution currently scans headers only.
- A request can reference at most one secret path. Requests with multiple
  distinct secret paths are rejected.

The current authorization boundary is the project itx session. A caller who has
the authority to use the project itx can update that project's secret metadata
and send egress requests through that project's egress door. There is no
per-user secret ACL inside a project today.

## Integrations

Slack and Google use different storage paths because their runtime needs are
different.

Slack stores the project's bot token in the itx secret system at:

```text
/secrets/integrations/slack/bot-token
```

Slack Web API calls place `getSecret({ path: "/secrets/integrations/slack/bot-token" })`
in the authorization header and go through project egress, so token material
stays inside the substitution pipeline. The secret is allowlisted for
`https://slack.com`.

Google OAuth tokens live as AES-GCM ciphertext payloads on the project
`/integrations/google` stream. Refreshing a Google access token needs raw
refresh-token material in a form body, which the header-only secret
substitution path does not cover, so Google does not use the Secret Durable
Object path today.

OAuth state for Slack and Google is stateless HMAC-signed data, not D1 state.
Slack team routing is stored in the deployment-wide
`/integrations/slack-team-directory` stream.

## Mock HTTP proxy note

`packages/mock-http-proxy` still preserves `getIterateSecret({...})`-shaped
values in HAR sanitization. That is a HAR safety carve-out for historical proxy
placeholder tokens; it is not the current OS egress placeholder. Current OS
egress uses `getSecret({ path: "/secrets/..." })` in request headers.

## Current limits

These are not implemented in the current itx surface:

- Secret hierarchy across global, org, project, and user scopes.
- Per-user secret authorization within a project.
- Discovery endpoints that list usable secrets for a destination.
- Human-in-the-loop egress approval.
- Generic non-secret environment variable management through this system.
- Secret substitution in request bodies, URLs, or WebSocket upgrade payloads.
- Multiple secret substitutions in a single request.

Future work should extend the current project egress and stream model rather
than revive the old table-oriented proposal.
