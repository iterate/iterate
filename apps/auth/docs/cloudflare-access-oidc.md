# Cloudflare Access as an OIDC relying party

Status: **blocked** until auth ID tokens can be verified by Cloudflare Access.

Full task with research, acceptance criteria, and implementation order:

→ [`tasks/auth-cloudflare-access-oidc-compatibility.md`](../../../tasks/auth-cloudflare-access-oidc-compatibility.md)

## One-line summary

Cloudflare Access generic OIDC only accepts **RS\*/ES\*/PS\*** ID-token
algorithms. Our issuer (`https://auth.iterate.com/api/auth`) currently
advertises **EdDSA only**, so Access cannot use iterate auth as an IdP until
we dual-sign (or switch) token algorithms and seed an OAuth client with the
Access callback URI.
