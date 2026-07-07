# Email: project inboxes and the zero-onboarding agent

How OS receives and sends email. Two tasks built this:
`tasks/os-agent-email-cloudflare-workers.md` (project inboxes, threading,
attachments — PR #1711) and `tasks/email-agent-zero-onboarding.md` (the
`bot@` zero-onboarding lane, stacked on it).

## Inbound: one door, two lanes

Cloudflare Email Routing (catch-all per project hostname base — enabled by
`ensure-resources`) delivers to the OS worker's `email()` entrypoint; the
admin-secret-gated `POST /api/integrations/email/inject` fakes the same
delivery shape for e2e/local dev (there is no other way to trigger `email()`
without MX). Both run one `handleInboundEmail`
(`src/domains/email/email-ingress.ts`):

- **`<slug>@<domain>` — a project's inbox.** Closed by default: the sender
  must match the deployment allowlist (`APP_CONFIG_EMAIL__ALLOWED_SENDERS`)
  AND pass DMARC (`requireDmarc`, opt-out for local dev). One exception: the
  sender a project was zero-onboarding-provisioned for (its Email Sender
  Claim) may always mail it, under the strict verification below — that is
  how thread replies keep working for senders no allowlist knows.
  Unauthorized mail gets a real SMTP reject plus an envelope-only
  `email/rejected` audit event.
- **`bot@<domain>` — the zero-onboarding inbox.** Open-world, gated by
  `emailZeroOnboardingEnabled` (envs.ts: dev/preview on, prd off) plus
  **unconditional** sender verification: `verifySenderAlignment` parses
  `Authentication-Results` clauses and requires `dmarc=pass` or `dkim=pass`
  aligned (RFC 7489 relaxed) with the **From-header** domain — the identity
  primitive, lowercased, `+tags`/dots preserved. Verification failures are
  accepted-and-dropped (no bounce: answering spoofed mail would make the
  door an oracle). A verified unknown sender is provisioned on the spot:
  `internal.user.upsertVerifiedEmail` → org (`createForUser`, owner role) →
  `ProjectCollectionRpcTarget.create` as that user (the ordinary bootstrap
  saga), then an "Email Sender Claim" is recorded on the deployment-wide
  `/integrations/email-sender-directory` stream (idempotency-keyed,
  first-claim-wins fold — concurrent first contact converges; see
  `zero-onboarding.ts`). `bot` and other well-known local parts are
  `RESERVED_PLATFORM_SLUGS` (`@iterate-com/shared/slug`), unclaimable as
  project/org slugs.

## Routing, agents, replies

The `email` router processor on `/integrations/email` resolves each mail to
one thread agent stream (`/agents/email/t<threadId>`, id = event offset):
recipient `+t` tag first, then In-Reply-To/References against its Message-ID
index (outbound `email/sent` ids included), else a new thread. The
`email-agent` processor transcribes mail into `agent/input-added`; the agent
path selects `EMAIL_AGENT_SYSTEM_PROMPT`, whose reply door is
`itx.email.reply({ text, attachments? })` — it derives counterpart, subject,
threading headers, and stamps `Reply-To: <slug>+t<id>@<domain>` so replies
route back regardless of client header behavior. Every send attempt is
audited on `/integrations/email`: `email/sent`, or `email/send-failed` when
the EMAIL binding call fails (e.g. domain not onboarded for Email Sending).

## Testing

- Unit: `src/domains/email/*.test.ts`.
- E2E: `e2e/vitest/email-zero-onboarding.e2e.test.ts` — inject → provision →
  agent → reply attempt → `+t` continuation → idempotent second contact,
  against any deployment (`doppler run --config <env> -- pnpm e2e --project
node email-zero-onboarding`). Synthetic senders use the non-deliverable
  `.test` TLD; the crafted `Authentication-Results` header keeps verification
  ON in tests. The only code e2e can't reach is Cloudflare's own SPF/DKIM
  computation and the `email()` stream-drain adapter.

## Ops / follow-ups

Per environment: `ensure-resources` sets up Email Routing (inbound);
Email Sending onboarding is a one-time dashboard step per domain; the sender
allowlist is a Doppler secret. **Before flipping `emailZeroOnboardingEnabled`
for prd**: bundle per-sender rate limiting, and confirm Cloudflare strips
sender-forged `Authentication-Results` headers (RFC 8601 §5) — neither lane
pins the authserv-id today, which is acceptable only while the admin-gated
inject route is the sole ingress for the bot lane.
