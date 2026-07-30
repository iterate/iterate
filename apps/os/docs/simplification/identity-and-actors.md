# Identity, authentication & authorization — how much is kernel?

Jonas's question (2026-07-28): _to what extent is identity/auth/authz part of the
kernel?_ His lean: **it's a pluggable part of the kernel.** Below is his thinking,
plus a synthesis.

## The unifying observation

**Every credential is a claim about an _actor_, vouched for by a _trusted issuer_.**
The kernel's job is to _verify the voucher_ and produce a verified actor; _which
issuers you trust_ is the pluggable part.

Issuers Jonas named — all the same shape ("issuer X vouches: this is actor Y, with
claims Z"):

- **auth.iterate.com** (hosted) — a browser session / OIDC → "this human, logged in."
- **Cloudflare Access** (self-host) — `cf-access-jwt` → "this human, per your IdP"
  (different format, same meaning).
- **Slack signed webhook** — HMAC over the body with the app signing secret →
  "really from Slack; sender = user U in workspace W."
- **Inbound email DKIM** — signature on the From domain → "really from person@domain."
- **(non-human) a capability / grant** → "this call is from agent A / project P."
- **(non-human) the scheduler** → "triggered by a timer."

If you trust the third party, you trust the credential and the actor info it
carries. That's the whole model.

## The actor shape

An **actor identity** = `{ who, vouched-by (issuer), claims (attributes) }` — the
same shape whether it's a browser user, a Slack-message sender (as event metadata),
an email sender, an AI agent, the scheduler, or another project. Human and non-human
unify: a human's voucher is a session / DKIM / HMAC; a non-human's voucher is the
capability it holds.

Jonas's insight: an OS browser client's session is _not so dissimilar_ from an AI
agent, or from metadata on a stream event saying "here's the person who sent the
Slack message." They're all "an actor, vouched somehow."

## Kernel vs pluggable vs userspace

- **Kernel (mechanism):** verify a credential → produce a verified actor; attach the
  actor to whatever it causes — an `itx` call, or **event metadata** ("caused by
  actor X, vouched by issuer Y"). This generalizes the appended-by-capability
  provenance (§2/§11) to **appended-by-actor**.
- **Pluggable (the knob):** _which issuers are trusted, and how each is verified_ — a
  set of **verifiers**, one per issuer type. Hosted trusts auth.iterate.com;
  self-host trusts Cloudflare Access; both trust Slack HMAC, email DKIM, etc. This is
  the "identity authority" knob from the ~5-knob model, generalized: a deployment
  configures its trusted issuers.
- **Userspace (policy):** **authorization** — gating an action (an append, an egress)
  on the actor meeting criteria. Jonas: _"code that culminates in appending to a
  stream but doesn't actually append unless the user meets some criteria."_ So the
  kernel provides the verified actor + a **gate hook**; the _policy_ is userspace.
  Matches §15 (identity at the wall / authorization via `itx.auth`).

## Open questions

- **Abstraction, or just a collection?** (Jonas) — a first-class `Actor` type, or
  just a registry of credential-verifiers that all emit a common `{who, issuer,
claims}`? Lean: a thin actor shape + a verifier registry, not a heavy abstraction.
- **How standardized are claims** across issuers (email/name/workspace) vs
  pass-through issuer-specific blobs?
- **Where the authz gate hooks the append** — a userspace allow/deny the kernel calls
  before committing an append? (echoes the processor pre-commit `validate` hook).
- **Capability ≈ credential?** A non-human actor's identity _is_ the capability it
  holds. A capability vouches "you may do X"; a credential vouches "you are Y." Two
  views of the same thing — worth unifying, or keep distinct?
