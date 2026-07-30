# Q — Email (inbound + outbound) as a network-edge capability, and its domain problem

**Status: 🔬 researching (sub-agent running).** A new dimension flagged by Jonas: email is a
control-plane / network-edge capability made available to the project — and it carries a _domain_
requirement (MX for inbound, a verified sending domain + DKIM for outbound) that self-host must satisfy.

## The question

1. Is email inherently a **network-edge / control-plane** capability — inbound MX lands at the control
   plane and is routed to the project; outbound leaves via the control plane's sending domain — with the
   project only receiving/sending _through_ it? _(Strong prior: yes; it's the same shape as ingress /
   egress / webhooks in ADR 0017.)_
2. **The domain problem (the real wrinkle).** Email needs DNS a project can't self-provision: MX records
   - a verified sending domain + DKIM keys. In **full self-host** the operator must supply their own
     email domain. **Can we avoid forcing a whole domain burn?**

## Why it matters

This is the email analogue of the ingress/routing question (ADR 0020): iterate-hosted provides a shared
base; self-host needs its own — with a possible "we still provide a shared base" escape hatch. Jonas:
_"if you're completely self-hosting, you provide the inbound and outbound email — but then what's the
hostname for that? Maybe that means we do want iterate.app … maybe we force people to burn a whole
domain … but I wonder if we can elegantly get around it."_

## Options for the domain (to evaluate once facts land)

- **(A) Bring your own email domain** — self-hoster owns `mail.example.com`, sets MX + DKIM, points the
  Email Worker at their control plane. Clean, but a domain burn + DNS setup.
- **(B) We provide a shared email base even in self-host** — like `*.iterate.app`: addresses under a
  shared iterate-run mail domain (`<project>@mail.iterate.com`), inbound routed to the self-hoster's
  control plane. Avoids the burn but re-introduces an iterate dependency (and who holds DKIM?).
- **(C) Per-project addressing on ONE shared domain** — `<addr>+<project>@mail.example.com` or
  `<project>.<addr>@…` so many projects share a single email domain + one DKIM setup. Reduces N domains
  to one.
- **(D) Sub-addressing under the ingress base** — reuse the wildcard base domain (ADR 0020) for email
  too (`@<slug>.base.com`), so one domain serves both HTTP ingress and email.

## Parallels / cross-refs

- **ADR 0017** — control plane = the network edge (ingress + egress + webhooks). Email is the same class;
  this ticket asks whether to fold it in explicitly.
- **ADR 0020** — the wildcard-base / shared-base pattern; the domain escape-hatch here is the same shape.
- Related aside from Jonas: **dynamic worker building** ("workers") is another control-plane-provided
  capability made available to the project — track alongside (it lands in build-plan Phase 2).

## Current facts (apps/os + Cloudflare) — researched 2026-07-30

**The elegant finding: email already rides the SAME base domain as HTTP ingress.**
`emailDomainForDeployment()` = `projectHostnameBases[0]` (`utils.ts:98`) — the identical wildcard base
from ADR 0020. A zone holds both wildcard `A`/`CNAME` (`<slug>.base.com`) and `MX`+DKIM
(`<slug>@base.com`). So email is **not a separate domain dimension** — it's the same domain you already
root to the control plane. No extra burn.

**Inbound** (`worker.ts:93` `email()` → `email-ingress.ts:39` `handleInboundEmail`):

- Cloudflare Email Routing catch-all → the worker's `email()` handler; recipient parsed
  `<slug>[+t<threadId>]@<domain>` (`utils.ts:157`); only the deployment's one email domain accepted,
  else a real SMTP bounce (`email-ingress.ts:48`). Sender allowlist + DMARC check.
- Lands as an `email/received` event on `/integrations/email`; a processor forwards to a per-thread
  agent stream (new thread births an agent). Provisioned by `ensureInboundEmailRouting`
  (`email-routing-resources.ts:24`) — **requires a Cloudflare zone named `emailDomainForDeployment`** +
  a catch-all rule → worker; defers gracefully if the zone isn't there yet.

**Outbound** (`rpc-targets.ts:3636` `EmailCapabilityRpcTarget.send/.reply` → `env.EMAIL.send`):

- Purely the Cloudflare **`send_email` binding** (`generate-wrangler-config.ts:361`, one binding, all
  envs; Miniflare _simulates_ sends). No MailChannels/Resend/SES. Sender hard-pinned to
  `<slug>@<same domain>`.
- **Caveats:** Cloudflare "Email Sending" is **paid-plan only**; before a domain is onboarded (its own
  `cf-bounce` MX/SPF/DKIM/DMARC — a **manual, un-automated** dashboard step) you can only send to
  _verified destination addresses_. So real outbound-to-anyone = paid plan + a manual DKIM onboarding
  we don't script today (a gap).

**Cloudflare constraints:** inbound needs the domain's DNS on Cloudflare + Email Routing + catch-all →
worker (any address, no per-address registration). One domain supports subaddressing (`+tag`) for
unlimited projects; a **subdomain works as its own sending domain**. So one shared mail domain scales to
all projects.

## Recommendation (updated after Jonas's annotation)

1. **Email is not a separate dimension — it rides the ADR 0020 base domain.** Fold "email" into "control
   plane = network edge" (ADR 0017); no new domain requirement beyond the ingress base.
2. **The thing to actually PROVE (Jonas):** in the completely-self-hosting scenario with a couple of
   projects, you can **send and receive email for them**. The shared-`mail.iterate.com` escape hatch is
   **not loved** — drop it as the headline. Instead prove real self-host email via one of: your own email
   domain · a dedicated email-sending hostname · a `workers.dev` subdomain for sending. Make "self-host
   email in + out works" a deliverable, not a hand-wave.
3. **Accepted:** paid Cloudflare plan is fine (ADR 0030-adjacent). **Still to track:** outbound DKIM
   onboarding is manual + unscripted; Miniflare only _simulates_ sends; inbound has no non-Cloudflare path.
