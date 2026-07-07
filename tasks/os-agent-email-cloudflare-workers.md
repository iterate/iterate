---
state: todo
priority: medium
size: large
dependsOn: []
tags: [os, agents, email, cloudflare, integrations]
---

# OS agent email over Cloudflare Email Workers

**Status:** the v1 sending slice landed with PR #1634 — `itx.email.send`
(rpc-targets.ts `EmailRpcTarget`, `domains/email/utils.ts`, `EMAIL`
send_email binding on all itx workers, `email/sent` audit events, the
`email-send` catalogue example). Sends from `<slug>@<first project hostname
base>`, enforced in OS.

The inbound + threading slice is in review (branch dour-clavicle): the
worker `email()` handler (`domains/email/email-ingress.ts`), the `email`
thread-router processor on `/integrations/email`, per-thread agents at
`/agents/email/t<threadId>`, the `email-agent` processor, `itx.email.reply`
with derived threading headers + `Reply-To: <slug>+t<id>@<base>`, outbound
attachments from itx.files, a deployment-wide DMARC-gated sender allowlist
(`APP_CONFIG_EMAIL__ALLOWED_SENDERS`), and Email Routing enable + catch-all
in ensure-resources.ts. NOTE: it uses an offset-keyed thread id + Reply-To
token + Message-ID directory instead of the `p_<base32(agentPath)>` codec
proposed below — real agent paths overflow the 64-char local-part limit and
the router needs the Message-ID index anyway. Remaining: Email Sending
onboarding in the Cloudflare dashboard per env, per-project sender policy in
router state (deployment-wide config today), inbound attachment storage into
itx.files (metadata-only today), miniflare send_email simulation for local
dev.

## Goal

Let OS projects and agents receive and send first-party email through
Cloudflare Email Workers on `iterate.app`.

Primary address shapes:

- Project inbox: `<slug>@iterate.app`
- Agent inbox: `<slug>+<escaped-agent-path>@iterate.app`

Use local parts on one owned domain instead of per-project subdomains. This
avoids onboarding arbitrary `<slug>.iterate.app` email domains and keeps routing
behind one Cloudflare Email Routing catch-all rule.

## Proposed address codec

Parse the local part by splitting on the first `+`.

- `<slug>@iterate.app` routes to the project-level email inbox for `slug`.
- `<slug>+p_<encodedPath>@iterate.app` routes to an agent path inside `slug`.

For v1, define `<escaped-agent-path>` as `p_<base32lower(canonicalPathBytes)>`,
without padding. Example canonical paths:

- `/agents/support`
- `/agents/research`
- `/integrations/email/default`

Reasons:

- Lowercase output survives clients and systems that case-fold email local parts.
- The alphabet is email-client friendly: `[a-z2-7]`, plus the `p_` prefix.
- The codec is reversible and does not rely on path segment conventions.

Keep room for a future human-readable alias layer, but make the primary address
codec deterministic.

## Cloudflare setup

Use Cloudflare Email Service for both directions:

- Add a Send binding to the OS worker or a dedicated OS email worker:
  `type = "send_email"`.
- Onboard `iterate.app` for Email Sending so dynamic senders under
  `@iterate.app` are valid.
- Enable Email Routing for `iterate.app`.
- Add a catch-all route for `*@iterate.app` to the email Worker.
- Enable plus/subaddress handling if Cloudflare requires it for routing
  behavior; the Worker must still parse the full recipient address from the
  delivered message.

Do not use `allowed_sender_addresses` for every project/agent address. That list
would be dynamic and unbounded. Instead, enforce sender authorization in OS:

- Only allow `from` addresses generated for the caller's project or agent.
- Never allow a project to send as another project slug.
- Reject non-`iterate.app` senders unless custom-domain support is deliberately
  added later.

Cloudflare docs checked while drafting:

- Email Service overview:
  https://developers.cloudflare.com/email-service/
- Workers send API:
  https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- Email Routing Worker handler:
  https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
- Routing addresses and catch-all behavior:
  https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/
- Email Service limits:
  https://developers.cloudflare.com/email-service/platform/limits/

## OS implementation plan

### 1. Add an email ingress Worker surface

Pick one of:

- Add an `email(message, env, ctx)` entry point to the deployed OS API worker if
  its module shape can own both HTTP and email handlers cleanly.
- Create a small dedicated email ingress Worker that shares the same bindings
  needed to resolve projects and append stream events.

Ingress responsibilities:

- Validate the recipient domain is exactly `iterate.app`.
- Parse and normalize the recipient local part.
- Parse MIME content with a real MIME parser instead of ad hoc header/body
  string parsing.
- Preserve the original `Message-ID`, `In-Reply-To`, `References`, sender,
  recipient, subject, text body, HTML body, and attachment metadata.
- Generate an idempotency key from Cloudflare delivery metadata when available,
  otherwise from a stable hash of message headers plus body.
- ACK accepted Cloudflare deliveries quickly after durable append/enqueue.

### 2. Add address helpers

Create shared helpers near the OS integration/domain code:

- `emailAddressForProject({ slug })`
- `emailAddressForAgent({ slug, path })`
- `parseIterateEmailRecipient(address)`
- `assertEmailSenderAllowedForContext({ from, project, agentPath? })`

The parser should reject malformed local parts, unknown domains, invalid slugs,
bad codecs, and decoded paths that are not valid OS capability/agent paths.

### 3. Route inbound mail into streams

Model this after the Slack integration rather than inventing a separate control
flow.

Relevant references:

- `apps/os/src/domains/integrations/slack-webhook-api.ts`
- `apps/os/src/domains/integrations/slack-processor-implementation.ts`
- `apps/os/src/domains/integrations/slack-agent-processor-implementation.ts`
- `apps/os/src/domains/projects/project-durable-object.ts`
- `apps/os/src/domains/agents/agent-durable-object.ts`

Suggested streams/processors:

- Project-level inbound mail appends to `/integrations/email`.
- Agent-addressed inbound mail routes to the decoded agent path.
- An email router processor tracks email thread state using `Message-ID`,
  `In-Reply-To`, and `References`, so future replies can route even when the
  recipient is a project-level address.
- An email agent processor converts routed mail into
  `events.iterate.com/agent/input-added`.

In v1, attachments can be represented as metadata plus a stored blob reference or
explicitly rejected with a clear event. Do not silently drop attachments.

### 4. Add sending capability

Expose a first-party email capability in itx. Final naming is an open decision,
but the API should be close to:

```ts
await itx.email.send({
  to,
  subject,
  text,
  html,
  from,
  inReplyTo,
  references,
});
```

Sending rules:

- Default `from` to `<slug>@iterate.app` for project-scoped calls.
- Default `from` to `<slug>+p_<encodedPath>@iterate.app` for agent-scoped calls.
- Validate explicit `from` against the caller's project/agent context.
- Include reply headers when responding inside an existing thread.
- Append an `events.iterate.com/email/sent` event with enough metadata for audit
  and replay without overexposing private message bodies in logs.

Use `apps/auth/src/server/email.ts` only as a Cloudflare Send binding reference.
OS needs project/agent sender validation and thread-aware headers, so the auth
OTP helper should not be reused directly.

### 5. UI and docs

Add copyable email addresses in the places users naturally need them:

- Project settings: `<slug>@iterate.app`
- Agent detail/settings: `<slug>+p_<encodedPath>@iterate.app`

Document:

- How inbound routing works.
- How agents choose their sending identity.
- How replies preserve a thread.
- Initial attachment and size limits.
- Operational setup for Cloudflare Email Sending and Email Routing.

## Security and abuse controls

- Rate limit inbound and outbound mail per project.
- Reject mail loops with headers like `Auto-Submitted`, bulk/list indicators, and
  our own outbound marker header.
- Set a maximum accepted message size below Cloudflare's platform limit so OS has
  predictable storage and processing costs.
- Treat email content as untrusted user input in all processors and UI rendering.
- Avoid using subject/body content for routing decisions.
- Add a beta allowlist if production abuse risk is too high for immediate public
  exposure.
- Log sender/recipient/message IDs for audit, but decide separately whether raw
  body retention is required.

## Custom domains follow-up

Keep the core router domain-aware so this can extend later to project custom
domains. With Cloudflare-only receiving, custom domains are simplest when Iterate
controls or manages the domain's Cloudflare Email Routing setup. For
customer-owned domains outside our account, v1 should prefer instructions to
forward catch-all mail to the project's `@iterate.app` address, or we should
evaluate a provider such as SES/Mailgun/Postmark/Resend that supports arbitrary
customer-domain MX verification at SaaS scale.

Do not block the `@iterate.app` v1 on full custom-domain email.

## Open decisions

- Exact public itx surface: `itx.email` vs `itx.integrations.email`.
- Whether `<slug>@iterate.app` wakes a default project agent, appends to an inbox
  stream only, or does both.
- Which deployed Worker owns the `email()` handler.
- Whether raw MIME bodies are retained, transformed, or discarded after parsing.
- Attachment storage location and retention period.
- Preview/dev strategy for real email smoke tests.

## Acceptance criteria

- [ ] Cloudflare Email Sending and Email Routing are configured for `iterate.app`.
- [ ] Inbound mail to `<slug>@iterate.app` appends one deterministic project email
      event.
- [ ] Inbound mail to `<slug>+p_<encodedPath>@iterate.app` wakes/routes to the
      decoded agent path and creates an agent input event.
- [ ] OS can send mail through Cloudflare from authorized project and agent
      addresses.
- [ ] OS rejects attempts to send from another project slug or an unsupported
      domain.
- [ ] Replies preserve `In-Reply-To` / `References` headers and use the expected
      project or agent sender address.
- [ ] Unit tests cover the address codec/parser, sender authorization, and
      idempotency behavior.
- [ ] Processor tests cover inbound project mail, inbound agent mail, duplicate
      deliveries, malformed recipients, and outbound reply headers.
- [ ] Ops docs list the Cloudflare Email Sending and Routing setup steps.
