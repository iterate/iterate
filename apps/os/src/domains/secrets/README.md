# Secrets Domain

A Secret is a domain object: a journal at `{projectId}:/secrets/{slug}` plus a
`SecretDurableObject` folding it. Material is AES-256-GCM encrypted in every
event payload (`secret-crypto.ts`) and exists in plaintext only inside Secret
DOs. The logic lives in the secret STREAM PROCESSOR
(`stream-processors/secret`): derivation runs are its reaction to
`secret/derive-requested` events; the DO is the host (crypto key, sibling
dials, the expiry alarm) plus request/response verbs that only append facts
and read the fold.

Material flows out only as substitution: project egress parses
`getSecret({ key })` placeholders and DELEGATES the request into the
referenced secrets' own DOs (`egressFetch` — hop-by-hop substitution, last
hop fetches). The audited `revealForPlatformUse` trapdoor exists for the two
callers a fetch hop can't cover: websocket frames (Discord gateway identify,
UrlDial upgrade headers) and sibling derivation sources.

Derived secrets (`secret-derivation.ts`) subsume OAuth refresh: an access
token is an `http-exchange` derivation over sibling Secrets (refresh token,
client secret), re-derived inline when a use finds it stale. `sensitivity:
"plain"` covers Doppler-style config variables. OAuth login state is a signed
stateless token (`oauth-state.ts`) — no table.

The full design narrative: `apps/os/docs/integrations-and-secrets-spike.md`.
