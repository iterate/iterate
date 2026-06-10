# Google Domain

Google owns the Gmail codemode capability for project-connected Google
accounts.

## Files

- `entrypoints/gmail-capability.ts` — `GmailCapability` (`WorkerEntrypoint`,
  props `{ projectId }`). Implements one codemode function,
  `gmail.request({ path, method?, query?, body?, headers? })`, which proxies a
  Gmail REST API call (`https://gmail.googleapis.com/gmail/v1` + path) using a
  fresh access token from `getFreshGoogleAccessToken` in
  `~/domains/secrets/oauth.ts`.
- `gmail-provider-registration.ts` — the codemode tool-provider registration
  exposing the capability as `ctx.gmail`. Registered by
  `AgentDurableObject` and the inbound MCP server connection.

The Google OAuth connection itself (tokens, connect/disconnect, the
`/integrations/google` stream) lives in the secrets domain — see
`~/domains/secrets/README.md`.
