# Claude OAuth interoperability

Verified against primary sources on 2026-09-10.

Claude selects CIMD when discovery advertises CIMD support and public-client
(`none`) token authentication. Its requested scope comes from the initial
challenge, falling back to resource metadata. Our initial challenge asks for
`iterate`; account management requires an explicit request.

Claude Code's [public client metadata](https://claude.ai/oauth/claude-code-client-metadata)
uses its document URL as the client ID and loopback callbacks at
`http://localhost/callback` and `http://127.0.0.1/callback`. Ports vary by session.
The pinned provider already compares these loopback redirects without their port.

The browser acceptance test should use that real CIMD document and a local
callback listener, preserving the client's state and S256 verifier throughout
first-user organization/project creation. It should exchange the resulting code
against the deployed issuer and exercise the MCP token on the new project.

[Claude's connector authentication documentation](https://claude.com/docs/connectors/building/authentication)
describes discovery, callbacks, scopes, refresh and cross-host issuers.
