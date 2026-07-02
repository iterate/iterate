# Google Domain

Google owns the Gmail itx capability for project-connected Google
accounts.

## Files

- `entrypoints/gmail-capability.ts` — `GmailCapability` (`WorkerEntrypoint`,
  props `{ projectId }`). Implements one itx capability function,
  `gmail.request({ path, method?, query?, body?, headers? })`, which proxies a
  Gmail REST API call (`https://gmail.googleapis.com/gmail/v1` + path) using a
  fresh access token from `getFreshGoogleAccessToken` in
  `~/domains/secrets/oauth.ts`.
- `GmailCapability` is provided as the project default `itx.gmail`, so
  project-scoped handles, agents, and inbound MCP execution all use the same
  capability chain.

The Google OAuth connection itself (tokens, connect/disconnect, the
`/integrations/google` stream) lives in the secrets domain — see
`~/domains/secrets/README.md`.
