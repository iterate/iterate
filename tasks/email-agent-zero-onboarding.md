---
status: in-progress
size: medium
branch: email-zero-onboarding-v2
baseBranch: dour-clavicle (PR #1711 — stacked)
supersedes: PR #1707 (email-agent-zero-onboarding)
tags: [os, auth, agents, email, cloudflare, onboarding]
relatedTasks: [os-agent-email-cloudflare-workers.md]
---

# Email zero-onboarding, rebuilt on the inbound-email foundation (PR #1711)

## Status summary

Fresh implementation of the zero-onboarding email agent, **stacked on Jonas's
inbound-email PR (#1711)** instead of competing with it. PR #1707 built the
same product on its own plumbing; #1711's plumbing is better where they
overlap (offset-based thread ids + `+t` Reply-To routing tokens, outbound
attachments, `itx.email.reply`, ensure-resources MX automation, body
truncation), so this branch keeps all of that and adds only what #1707
uniquely had. Spec decisions carry over from the grill session recorded in
PR #1707's `tasks/email-agent-zero-onboarding.interview.md`.

## Raw ask (verbatim from Misha, via PR #1707)

> e2e global email agent with zero onboarding
>
> how it'll work:
>
> Joe Bloggs wants something done. He just emails bot@iterate.com and we receive it via some global webhook/cloudflare email handler worker thing. (e.g. "Make me a browser slime volleyball game" from joebloggs@gmail.com to bot@iterate.com)
> we map joebloggs@gmail.com to a user/organization/project. If none exist, we create them in the auth service
> we consider this request _trusted_ - i will rely on you to determine what exactly that means in terms of scopes etc. but the important thing is: we _know_ this email came from joebloggs@gmail.com so we _don't_ need to separately auth in order to just do what's asked
>
> not important to set up MX records for bot@iterate.com to work spelled exactly like that yet - the flow is what I want, but I do want to be able to test that it works. Use best judgement for how to do that with preview-${n} slots

## Design: what this branch adds on top of #1711

#1711 gives existing projects an inbox: `<slug>@<domain>`, closed behind a
sender allowlist + DMARC, one agent per thread (`/agents/email/t<offset>`),
replies via `itx.email.reply` with a `+t<id>` Reply-To routing token. This
branch adds the **open-world lane**:

1. **`bot@<domain>` recipient lane** in the same ingress door
   (`email-ingress.ts`): `bot` is a reserved local part checked before the
   project-slug lookup. Mail to it bypasses the allowlist entirely and is
   instead gated by:
   - `emailZeroOnboardingEnabled` (envs.ts: dev/preview on, prd off), and
   - **unconditional sender verification** — `verifySenderAlignment` parses
     `Authentication-Results` clauses and requires `dmarc=pass` OR
     `dkim=pass` whose domain aligns (RFC 7489 relaxed) with the From-header
     domain. No `requireDmarc=false` escape hatch on this lane: tests craft a
     passing header through the inject route instead of turning the gate off.
     (Stricter than #1711's slug-lane regex check, which is fine there —
     the allowlist is the real gate.)
2. **Sender directory + auto-provisioning**: a deployment-wide
   `/integrations/email-sender-directory` stream ("Email Sender Claim",
   CONTEXT.md) maps normalized From address → projectId. Unclaimed →
   provision: `internal.user.upsertVerifiedEmail` →
   `internal.organization.createForUser` (owner) →
   `ProjectCollectionRpcTarget.create` **as that user**
   (`provisionedUserAuthContext`), running the ordinary bootstrap saga.
   Claims are idempotency-keyed on the address, the fold is
   first-claim-wins, so concurrent first contact converges (loser adopts the
   winner, logs its orphan). Project slug pre-probed via
   `internal.project.bySlug` + one suffixed retry (auth hard-conflicts on
   cross-org project slugs).
3. **Zero-onboarding mail joins #1711's threading unchanged**: the received
   event carries the provisioned project's slug, the router mints
   `t<offset>`, and the agent's reply sets `Reply-To:
<slug>+t<id>@<domain>` — so Joe's follow-ups route back without ever
   touching `bot@` again. No new threading machinery.
4. **Inject seam + e2e** (what #1711 lacks): admin-secret-gated
   `POST /api/integrations/email/inject` accepting
   `{envelopeFrom, envelopeTo, rawMime}`, a thin fake delivery over the same
   `handleInboundEmail` (which now returns a result object instead of void).
   The e2e drives inject → provision → agent → reply attempt → thread
   continuation against any deployment; senders use the non-deliverable
   `.test` TLD.
5. **`email/send-failed` audit** in EmailRpcTarget's `#deliver`, so the reply
   attempt is observable on deployments whose domain isn't onboarded for
   Email Sending.
6. **Reserved platform slugs** (`bot`, `postmaster`, `noreply`, …) in
   `@iterate-com/shared/slug`, enforced in auth for project and org slugs so
   nothing can ever shadow the platform addresses.

Trust model, naming, idempotency, loop-guard, and scope-cut decisions are
unchanged from the grill session (see PR #1707's interview transcript).
Rate limiting stays deferred to the real-MX/prd-enablement follow-up, which
must bundle it.

## Checklist

- [ ] `RESERVED_PLATFORM_SLUGS` in shared + auth enforcement (project create rejects, org create routes around)
- [ ] `emailZeroOnboardingEnabled` in envs.ts → `APP_CONFIG_EMAIL__ZERO_ONBOARDING_ENABLED` → `config.email.zeroOnboardingEnabled`
- [ ] `verifySenderAlignment` + `normalizeEmailAddress` + sender-directory constants/fold in `domains/email/utils.ts` (+ unit tests)
- [ ] `domains/email/zero-onboarding.ts`: directory lookup + provisioning chain (+ `provisionedUserAuthContext` in auth.ts)
- [ ] `bot@` lane in `email-ingress.ts`; `handleInboundEmail` returns a result and takes ctx
- [ ] `POST /api/integrations/email/inject` (admin-gated) + ingress.ts api-lane registration + worker.ts dispatch
- [ ] `email/send-failed` audit in EmailRpcTarget `#deliver`
- [ ] Prompt: zero-onboarding additions to `EMAIL_AGENT_SYSTEM_PROMPT` (self-contained for strangers, ship built things as URLs)
- [ ] CONTEXT.md: Email Sender Claim entries
- [ ] E2E: spoofed-drop, provision→agent→reply-attempt, thread continuation (header + `+t` token lanes), idempotent second contact
- [ ] Docs: `apps/os/docs/email.md` describing the merged design
- [ ] Verify e2e green against local dev; unit suites + typecheck green

## Guesses and assumptions

- Authserv-id pinning is NOT implemented: a sender could forge their own
  `Authentication-Results` header, and we cannot verify whether Cloudflare
  strips conflicting ones without real MX. Both #1711 and #1707 share this;
  the real-MX follow-up must confirm Cloudflare's stripping behavior (RFC
  8601 §5 says receivers SHOULD delete forged headers) before prd enablement.
  Acceptable now: the only ingress is the admin-gated inject route.
- Zero-onboarding mail bypasses `email.allowedSenders` by design — the env
  flag is its gate. The slug lane keeps #1711's allowlist semantics
  untouched.
- `bot@` first contact runs provisioning inline in the SMTP/inject request
  (tens of seconds worst case with `waitUntilCreated`); Cloudflare Email
  Workers allow long-running handlers, and dedupe keys make MTA retries safe.

## Implementation log

_(started 2026-07-07 — see commits)_
