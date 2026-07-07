# Email: the zero-onboarding agent and first-party sending

How OS receives and sends email, and how the zero-onboarding flow turns a
stranger's email into a working project. Tasks:
`tasks/email-agent-zero-onboarding.md` (this flow, shipped) and
`tasks/os-agent-email-cloudflare-workers.md` (full `<slug>@` inbox semantics,
follow-up).

## The flow

Anyone emails `bot@<email domain>` (`bot@iterate.app` in prd,
`bot@iterate-preview-N.app` on preview slots — always
`projectHostnameBases[0]`). Receipt of a DMARC/DKIM-verified email **is** the
authentication:

1. **Ingress** — both inbound paths are thin adapters over one shared
   `handleInboundEmail` (`src/domains/email/inbound.ts`):
   - the OS worker's `email()` entrypoint (`src/worker.ts`), invoked by
     Cloudflare Email Routing once a catch-all route exists (see Ops below);
   - `POST /api/integrations/email/inject` (`src/email-ingress.ts`),
     admin-secret gated, accepting `{envelopeFrom, envelopeTo, rawMime}` —
     the e2e/local-dev lane, since nothing can trigger `email()` without MX.
2. **Guards** — 1MB raw-MIME cap, `Auto-Submitted`/`Precedence`/`List-Id`
   mail-loop guard, MIME parsing via postal-mime.
3. **Sender verification** — parse `Authentication-Results` (Cloudflare
   computes SPF/DKIM/DMARC before invoking the worker): `dmarc=pass`, or
   `dkim=pass` with the DKIM domain aligned (RFC 7489 relaxed) to the
   **From-header** domain. The From address, lowercased (never `+tag`/dot
   stripped), is the identity. Failures drop silently — no reply, no bounce
   oracle.
4. **Resolve or provision** — the deployment-wide email sender directory
   stream (`/integrations/email-sender-directory`, "Email Sender Claim" in
   CONTEXT.md) maps sender → projectId. Unclaimed senders are provisioned —
   gated by `emailZeroOnboardingEnabled` (envs.ts: preview/dev on, prd off):
   `internal.user.upsertVerifiedEmail` → `internal.organization.createForUser`
   (owner role) → `ProjectCollectionRpcTarget.create` as that user (the full
   ordinary bootstrap saga). Claims are idempotency-keyed on the address and
   the fold is first-claim-wins, so a concurrent first contact converges on
   one project.
5. **Route** — `email/received` lands on the project's `/integrations/email`;
   the `email` router processor maps Message-ID ancestry to one stable agent
   stream per conversation (`/agents/email/thread-<id>`) and forwards. It
   also folds outbound Message-IDs from `email/sent`, so a human reply to the
   bot's reply threads back to the same agent.
6. **Agent** — the `email-agent` processor transcribes mail into
   `agent/input-added`; the agent path selects `EMAIL_AGENT_SYSTEM_PROMPT`
   (project-processor-implementation.ts), whose reply door is
   `itx.email.send({ to, subject, text, inReplyTo, references })`.

Mail to `<slug>@<domain>` currently routes **only** when it references a
known thread; anything else is dropped (loudly) until the sibling task ships
project-inbox semantics. Reserved local parts (`RESERVED_PLATFORM_SLUGS` in
`@iterate-com/shared/slug`) can never be project or org slugs.

## Sending

`itx.email.send` (EmailRpcTarget, rpc-targets.ts) sends via the Cloudflare
Email Service `EMAIL` binding from the project's own `<slug>@<domain>`
address only. `inReplyTo`/`references` set the threading headers;
`Message-ID` is platform-generated and returned/audited. Every attempt lands
an audit event on `/integrations/email`: `email/sent` on success,
`email/send-failed` when the binding call fails (e.g. domain not onboarded
for Email Sending) — bodies stay out of the stream.

## Testing / local dev

- Unit: `src/domains/email/*.test.ts` (pipeline, codec, router, agent
  transcription).
- E2E: `e2e/vitest/email-agent.e2e.test.ts` drives inject → provision →
  agent → reply-attempt against any deployment. Synthetic senders use the
  non-deliverable `.test` TLD deliberately. Run with
  `doppler run --config <env> -- pnpm e2e --project node email-agent`.
- Local dev: same inject route against `pnpm dev` — the only untestable code
  without real MX is Cloudflare's own SPF/DKIM computation and the `email()`
  stream-drain adapter, by design.

## Ops: attaching real inbound email to an environment

Nothing in code changes; per environment:

1. Onboard the env's email domain (e.g. `iterate-preview-3.app`) for **Email
   Sending** in its Cloudflare account, so `itx.email.send` deliveries leave.
2. Enable **Email Routing** on the zone and add a catch-all route
   (`*@<domain>`) delivering to the env's OS worker — the `email()`
   entrypoint.
3. For prd: flip `emailZeroOnboardingEnabled` in envs.ts — but that follow-up
   MUST bundle per-sender rate limiting first (see the task file's
   out-of-scope section); it is deliberately absent while the only ingress is
   the admin-gated inject route.
