# Q — Control-plane integrations (Slack, metered 3p secrets) & environment-determined capability presence

**Status: 🔬 researching (sub-agent).** Flagged by Jonas as the generalization behind email/webhooks:
some capabilities exist **only if the control-plane environment provides them** — they must not be
hardwired into the project worker.

## The principle (the real output)

**Capability _presence_ is a property of the control-plane environment, not the project.** The
`ProjectWorkerEntrypoint` must not hardwire the assumption that Slack / metered-AI / etc. exist. A
project asks "what's available here?" and the answer depends on what the control plane it runs under
provides. Self-host with no iterate control plane → those integrations are absent, unless the operator
wires their own (their Slack app + keys in `APP_CONFIG`). _(→ ADR 0021.)_

> "That needs to be … not hardwired into each project worker entry point. It is something that the
> environment determines — what capabilities are actually available in the control-plane environment
> that this project is running in." — Jonas

## Two kinds of control-plane integration

1. **Metered first-party secret.** We hold a 3rd-party API key; you use it without ever seeing it; we
   meter usage **on the egress path** (the secret is substituted at the egress door; the project sees
   only a placeholder). Presence = "does this control plane have that secret configured." _(This is R9 —
   volume-discounted 3p access via our keys — made concrete.)_
2. **OAuth-receiver integration** (Slack OAuth, GitHub App). The OAuth callback + events webhook land at
   the **control-plane host**. Presence = "does this control plane have the OAuth client configured":
   ours (hosted), your own app in `APP_CONFIG` (self-host), or empty → the feature simply doesn't exist.

## Why it matters / where it bites

- It's the same edge as ingress/egress/webhooks/email (ADR 0017) — **integrations are a control-plane
  concern the project reaches _through_**. Add them to that list explicitly.
- It forces a real modelling question **distinct from sourcing (Q03, deferred):** Q03 was _where_ a
  capability is served from; this is _whether it's present at all_. **Presence ≠ sourcing.** The
  entrypoint needs a way to be told "these integrations are available in your environment" (part of the
  props/config the control plane hands it — cf. topologies L2 prop set).
- **Self-host story:** either configure your own Slack app/keys → the capability appears, or leave empty
  → it's absent. No code fork; presence is config.

## Open sub-questions

- How is presence **declared** (control-plane `APP_CONFIG`) and **discovered** by the project (a
  capability that's absent vs one that throws)? Does an absent integration mean the getter is missing,
  returns undefined, or a typed "unavailable"?
- For metered secrets: is metering purely the egress-door accounting, or a separate hook?
- Does making presence environment-determined require breaking up `rpc-targets` (build-plan Phase 2), or
  can it be a thinner "available capabilities" map handed in props?

## Cross-refs

ADR 0017 (network edge) · ADR 0021 (presence principle) · Q03 (sourcing — presence is its sibling) ·
email ticket (same "rides the control plane" shape) · R9 (first-party metered secrets).

## Current facts (apps/os) — researched 2026-07-30

**Slack (OAuth-receiver kind):**

- Served by the **same control-plane worker** at its **fixed deployment hostname** (`AppConfig.baseUrl`):
  OAuth callback `/api/integrations/slack/callback` (`connect-flows.ts:97` builds
  `${baseUrl}/api/integrations/${provider}/callback`), events webhook
  `/api/integrations/slack/webhook` (`ingress.ts:159`). **One Slack app per deployment** (prod one; each
  `preview_N` its own) — no per-project Slack app or hostname.
- Config = env vars via Doppler → `AppConfig.integrations.slack` (`config.ts:168`); the whole
  `integrations` block is `.prefault({})` (optional). **Absence is handled inconsistently:** webhook door
  503s (`slack-webhook.ts:40`), OAuth start throws (`connect-flows.ts:79`), but the `itx.integrations.slack`
  getter is **unconditionally present** in the tree (`rpc-targets.ts:3050`).
- Inbound routing: a **deployment-wide directory stream** keyed `(slug, externalId)` e.g. `slack <teamId>`
  (`integration-streams.ts`); connect claims the key, webhook looks it up → appends to the project's
  stream; unclaimed ids → `200 ignored` (protects Slack's auto-disable threshold).

**Metered first-party secret (egress kind) — TWO lanes, only one meters:**

- **(a) Per-connection secrets** (Slack bot token, OAuth tokens) — Secret DO; caller sends placeholder
  `getSecret("<path>")` (`slack-api.ts:124`); substituted at the egress door
  (`project-durable-object.ts:666`), never returned. **Has metering** — `SecretDescription.audit`
  (`lastUsedAt/By/Url`, `usedCount`, `types.ts:144`).
- **(b) Deployment-owned platform keys** (Exa, Parallel) — resolved straight from `AppConfig`, no Secret
  DO, `substitutePlatformApiKeyReferences` + hardcoded origin allowlist (`platform-secrets.ts:13`).
  **No audit / no metering.** ⚠️ This asymmetry is the metering gap the "we meter on the egress path"
  design must close.

**Is availability env-determined today?** No — capability **shape** is hardwired/always-present;
only **credential availability** is env-determined, and ad hoc per-integration (`parallel` throws,
`exa` degrades, `slack` 503s). `__describe()`/the tree never hides an unconfigured capability. **Smallest
honest change toward ADR 0021:** one shared `requirePlatformIntegration(config, slug)` presence primitive
that every getter/webhook calls, + give the platform-key lane (b) the audit hook lane (a) already has.

## Update — Jonas annotation (2026-07-30)

- **Concrete example = Exa (and Parallel), not "metered AI".** First-party integrations where _we_ hold
  the API key and let customers use it, charging them; they configure nothing.
- **Metering is in scope to prove-we-could:** the control plane should **intercept** Exa/Parallel egress;
  a **control-plane billing DO** can count spend / what the customer owes. Not urgent, but prove the shape.
  A daily job downloads 3p cost data. **This billing + first-party-integration machinery is the _iterate
  product layer_ (ADR 0030), separable from the generic control plane** — turned **off by config** in
  self-host.
- **Framing note (Jonas):** drop the abstract "presence is config" phrasing. Say it concretely: _Exa is
  available iff the control plane was given the Exa key; Slack iff a Slack app was wired._ The environment
  determines which integrations exist.
