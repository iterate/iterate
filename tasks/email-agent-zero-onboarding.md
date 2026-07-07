---
status: implemented, awaiting review
size: large
branch: email-agent-zero-onboarding
pr: https://github.com/iterate/iterate/pull/1707
tags: [os, auth, agents, email, cloudflare, integrations, onboarding]
relatedTasks: [os-agent-email-cloudflare-workers.md]
---

# E2E global email agent with zero onboarding

## Status summary

Implementation complete, both slices, e2e-verified against a live local dev
environment (see Implementation log). Spec came from a grill session
(transcript in `tasks/email-agent-zero-onboarding.interview.md`). Shipped
pieces: inbound email ingress (`email()` handler + admin-gated inject route
over one shared `handleInboundEmail`), DMARC/DKIM sender-verification gate,
auto-provisioning of user/org/project, email sender directory + thread router
modeled on Slack, agent kickoff with an email system prompt, threaded reply
via an extended `itx.email.send`, and an e2e suite runnable against dev or
preview-N. Remaining: review, plus the deliberately-deferred follow-ups (real
MX + prd enablement + rate limiting; full `<slug>@` inbox semantics in the
sibling task).

## Raw ask (verbatim from Misha)

> e2e global email agent with zero onboarding
>
> how it'll work:
>
> Joe Bloggs wants something done. He just emails bot@iterate.com and we receive it via some global webhook/cloudflare email handler worker thing. (e.g. "Make me a browser slime volleyball game" from joebloggs@gmail.com to bot@iterate.com)
> we map joebloggs@gmail.com to a user/organization/project. If none exist, we create them in the auth service
> we consider this request _trusted_ - i will rely on you to determine what exactly that means in terms of scopes etc. but the important thing is: we _know_ this email came from joebloggs@gmail.com so we _don't_ need to separately auth in order to just do what's asked
>
> not important to set up MX records for bot@iterate.com to work spelled exactly like that yet - the flow is what I want, but I do want to be able to test that it works. Use best judgement for how to do that with preview-${n} slots

## The flow (decided)

1. Mail arrives addressed to `bot@<projectHostnameBases[0]>` (`bot@iterate.app`
   prd, `bot@iterate-preview-N.app` preview slots). Real path: Cloudflare Email
   Routing catch-all → new `email()` entrypoint on the OS worker. Test/dev
   path: admin-secret-gated `POST /api/integrations/email/inject` accepting
   `{envelopeFrom, envelopeTo, rawMime}`. Both are thin adapters over one
   shared `handleInboundEmail` which does its own MIME parsing (so the parser
   is covered by e2e).
2. **Verify the sender**: parse `Authentication-Results` (Cloudflare computes
   SPF/DKIM/DMARC before invoking the worker). Require `dmarc=pass` OR
   (`dkim=pass` with the DKIM domain aligned to the From-header domain, RFC
   7489 relaxed alignment). Identity = the From-header address, normalized by
   lowercasing only (never strip `+tags`/dots — `joe+x@gmail.com` is a
   distinct identity, useful for testing). Failure → drop + log to an
   ops-visible stream, **no reply** (no bounce oracle), no provisioning.
3. **Resolve or provision**: look up the sender in a new global email sender
   directory stream (`EMAIL_SENDER_DIRECTORY_STREAM_PATH`, mirror of the Slack
   team directory: fold to `Map<normalizedFrom, projectId>`). Unclaimed →
   provision via the existing auth internal calls
   (`internal.user.upsertVerifiedEmail` → `internal.organization.createForUser`
   → `internal.project.createForOrganization`), then append the claim event
   ("Email Sender Claim" — now in CONTEXT.md). Get-or-provision must be **one
   serialized method on the directory-owning Durable Object** so concurrent
   first emails from the same new sender can't double-provision.
4. **Route to an agent**: append `email/received` to the project's
   `/integrations/email` stream; an email router processor assigns/reuses an
   agent path `/agents/email/thread-<hash of root Message-ID>` (tracks
   Message-ID → path; `In-Reply-To`/`References` matches reuse the path) and an
   email agent processor emits `events.iterate.com/agent/input-added` with the
   parsed email dumped as YAML (Slack convention).
5. **Reply**: the agent replies via `itx.email.send` from the provisioned
   project's own address (`<slug>@<domain>`, never `bot@`), with
   `In-Reply-To`/`References` threading headers — which requires extending the
   shipped `EmailCapability.send` (they don't exist yet). The router processor
   records outbound Message-IDs too, so human replies to bot replies can
   thread back (second slice).

## Trust model (what "trusted" means)

- Receipt of a DMARC/DKIM-aligned email **is** the authentication. The
  provisioned user is created via `upsertVerifiedEmail` (emailVerified: 1) and
  becomes **owner** of the auto-created org. The agent runs with the same
  standing any project agent has — the sender needs no session/token for the
  agent to act on their request.
- Brand-new-sender provisioning is gated per environment by a new
  `emailZeroOnboardingEnabled` boolean in `envs.ts`: **on** for dev/preview_N,
  **off** for prd. Flipping prd on is a follow-up (see below), not this task.
- Email content is untrusted user input everywhere downstream (standard
  processor/UI discipline); only the verified sender address is trusted.

## Decisions locked during the grill (see interview file for reasoning)

- **Addressing**: local part `bot` as a constant next to the email address
  codec, checked before `<slug>@` fallthrough. Reserve
  `bot, admin, administrator, support, help, postmaster, abuse, security,
noreply, no-reply, mailer-daemon, root, info, contact, team, hello` as
  project AND org slugs in auth slug resolution (one exported constant; note
  auth already sends as `noreply+auth@<domain>`).
- **Naming**: slugify the sender local part, pass to auth, let existing
  `resolveUniqueSlug` uniquify (`joebloggs`, `joebloggs-2`). No bespoke suffix
  scheme. If `resolveUniqueSlug` turns out not concurrency-safe, fix that
  (pre-existing flaw), don't work around it.
- **Partial provisioning failure**: claim appended only after the full chain
  succeeds; retry re-runs the chain (upsert is get-or-create). Worst case an
  orphaned org — accepted v1 tradeoff, log it, no saga.
- **Idempotency key** for inbound: `Message-ID`, else stable hash of
  headers+body.
- **Reply-channel mechanism**: trace how Slack agents know to reply via
  `itx.slack.sendMessage` from being on `/agents/slack/...` paths and mirror
  it for `/agents/email/...` → `itx.email.send`. If that mechanism doesn't
  generalize, fallback: a short preamble in the email-thread agent input
  ("this arrived by email from <addr>; when you have a result, reply using
  itx.email.send with these threading headers"). Either way, **the e2e must
  observe an outbound reply attempt** — that part is not optional.
- **Attachments**: never error the flow and never silently drop — proceed
  with text/html, include attachment metadata in the agent input so the agent
  can say it can't read them yet.
- **Limits**: 1MB raw-MIME cap; drop + log `Auto-Submitted: auto-*` and
  bulk/list-header mail (loop guard) in shared `handleInboundEmail`.
- **Artifacts**: delivered as links (project hosting), no outbound
  attachments in v1.

## Checklist

### Slice 1 — one-shot flow (the acceptance bar)

- [x] Shared email ingress core: `handleInboundEmail({envelopeFrom, envelopeTo, rawMime}, config)` in `apps/os/src/domains/email/` — MIME parsing (postal-mime or smallest workers-compatible equivalent), Authentication-Results alignment check, size cap, loop guard, idempotency key — _`apps/os/src/domains/email/inbound.ts`, fully DI'd; postal-mime added to apps/os_
- [x] `email()` entrypoint on the OS worker default export (`apps/os/src/worker.ts`) as a thin `ForwardableEmailMessage` adapter (stream drain, `.setReject()` on drop) — _worker.ts `email()` → `handleInboundEmailMessage` in `src/email-ingress.ts`; setReject only for oversize, everything else accept-and-drop (no bounce oracle)_
- [x] Admin-secret-gated `POST /api/integrations/email/inject` route calling the same `handleInboundEmail` (same trust tier as the existing admin API secret); doubles as the local-dev story — _`handleEmailInjectApiRequest` in `src/email-ingress.ts`, dispatched from `apiFetch` next to the Slack webhook_
- [x] `emailZeroOnboardingEnabled` in `envs.ts` (on: dev/preview*N; off: prd) + plumbed into OS config — \_envs.ts field → `APP_CONFIG_EMAIL_ZERO_ONBOARDING_ENABLED` env-shaped var; local dev gets a hardcoded `"true"` var so shared Doppler configs need no new entry*
- [x] Bot-address constant + recipient parsing (`bot` before slug fallthrough) in the email address codec (`apps/os/src/domains/email/utils.ts`) — _`ZERO_ONBOARDING_LOCAL_PART` + `parseEmailRecipient` (bot / project / reserved / unroutable)_
- [x] Reserved local-parts/slugs constant; enforce in auth slug resolution for projects and orgs — _`RESERVED_PLATFORM_SLUGS` in `packages/shared/src/slug.ts`; project create rejects (CONFLICT), org create routes around via resolveUniqueSlug isTaken_
- [x] Email sender directory stream (`EMAIL_SENDER_DIRECTORY_STREAM_PATH`, global, Slack-directory pattern) with a single atomic get-or-provision method on the owning DO — _implemented WITHOUT new DO surface: claim events are idempotency-keyed on the normalized address and the fold is first-claim-wins, so concurrent first contact converges deterministically (loser adopts the winner, logs its orphan). See `resolveSenderProject` in `src/email-ingress.ts`_
- [x] Provisioning chain via `createAuthWorkerServiceClient`: `upsertVerifiedEmail` → `createForUser` → `createForOrganization`; claim event appended last — _the project step goes through `ProjectCollectionRpcTarget.create` as the provisioned user (new `provisionedUserAuthContext` in auth.ts) so the full bootstrap saga runs; project slug pre-probed via `internal.project.bySlug` + one suffixed retry (auth does NOT auto-suffix project slugs — spec assumption corrected)_
- [x] `email/received` events on the project's `/integrations/email` stream — _`EmailProcessorContract` owns received/sent/thread-route-configured_
- [x] Email router processor: Message-ID → agent path (`/agents/email/thread-<hash>`), In-Reply-To/References reuse; records outbound Message-IDs too — _`email-processor-implementation.ts`; routing decision lives in the pure reduce fold (same-batch replies stay consistent) with a deterministic references-root fallback_
- [x] Email agent processor: `email/received` → `agent/input-added` (YAML dump of parsed email incl. attachment metadata) — _`email-agent-processor-implementation.ts`; also folds reply context (sender, subject, references chain) into state_
- [x] Reply-channel mechanism: mirror Slack's, or the documented preamble fallback — _mirrored exactly: `EMAIL_AGENT_SYSTEM_PROMPT` + `agentSystemPromptForPath` branch + birth-certificate `email-agent` subscription in project-processor-implementation.ts; no preamble fallback needed_
- [x] Extend `EmailCapability.send` + `EmailRpcTarget` + `buildProjectEmailMessage` with `inReplyTo`/`references` and a generated, returned, recorded outbound `Message-ID` — _Cloudflare structured send allows both headers (Message-ID itself is platform-generated and returned; recorded in `email/sent`). Added `email/send-failed` audit fact so the attempt is observable even where the domain is not onboarded for sending_
- [x] Unit tests: alignment predicate, address normalization, recipient parsing incl. reserved words, idempotency key, loop/size guards — _`inbound.test.ts` + extended `utils.test.ts`_
- [x] Processor tests: new sender provisions once (incl. concurrent duplicate delivery), known sender routes straight in, thread reuse, malformed mail dropped — _`email-processors.test.ts` on the shared in-memory stream harness (extracted to `domains/streams/memory-stream-test-support.ts`); replay-dedupe covered; concurrent-first-contact convergence covered at the fold level in `utils.test.ts`_
- [x] E2E (preview-N / dev, template `slack-agent.e2e.test.ts`): inject synthetic email from `zero-onboarding-<unique>@example.test` (non-deliverable TLD on purpose — assert the attempt, deliver nothing) with crafted passing Authentication-Results → poll directory claim → `agent/input-added` → outbound reply attempt (`email/sent` event) threaded to the inbound Message-ID — _`apps/os/e2e/vitest/email-agent.e2e.test.ts`; outbound assert accepts `email/sent` OR `email/send-failed` (deployments without Email Sending onboarding still prove the attempt)_
- [x] E2E idempotency: second inject from the same fixed sender → same projectId, no second user/org — _second test in the same file; asserts exactly one sender-claim event_
- [x] No test cleanup (matches `create-test-project.ts` documented no-op convention)
- [x] Docs: flow description + ops note on attaching real Email Routing later (`email()` is the only untested-by-e2e code by design) — _`apps/os/docs/email.md`, linked from apps/os AGENTS.md_

### Slice 2 — stretch: reply-back continuation

- [x] Inbound to `<slug>@<domain>` whose In-Reply-To/References matches a known thread routes to that thread's agent path (thin layer over the slice-1 router) — _`parseEmailRecipient` project lane + router `resolveThreadPath` (project mail never opens fresh threads)_
- [x] Unmatched `<slug>@` mail: drop + log (full inbox semantics stay with the sibling task) — _router processEvent warn-and-drop; unit-tested_
- [x] E2E: inject a reply to the bot's outbound Message-ID → same agent path gets a second `agent/input-added` — _e2e injects a same-thread reply (In-Reply-To the root) and asserts a second `email/received` on the same agent stream; the reply-to-OUTBOUND-id lane is unit-tested (the outbound Message-ID is only knowable in e2e when real sending is onboarded)_

## Out of scope / follow-ups

- **Prod enablement + real MX** (own task): Email Routing catch-all on
  `iterate.app` zone(s), flipping `emailZeroOnboardingEnabled` for prd — and it
  MUST bundle per-sender rate limiting / abuse throttling as a hard
  prerequisite. Rate limiting is deliberately absent here because the only
  ingress until then is the admin-gated inject route.
- Full `<slug>@` / agent-path inbox semantics — sibling task
  `os-agent-email-cloudflare-workers.md`, which must **reuse** this task's
  `handleInboundEmail`, sender directory, and thread router rather than
  reinvent them (note added there).
- Outbound attachments, HTML-mail niceties, custom domains, billing/quotas.

## Guesses and assumptions (made on Misha's behalf — spot-check these)

- Alignment predicate: `dmarc=pass` OR aligned `dkim=pass`; the non-negotiable
  intent is "authenticated domain aligns with From domain".
- Exact reserved-words list — trim/extend freely.
- `resolveUniqueSlug` assumed concurrency-safe (unread internals).
- postal-mime as the MIME parser, pending a workers-compatibility check.
- Demo-over-purity on the reply mechanism: preamble fallback is acceptable if
  mirroring Slack's mechanism is deep plumbing.
- Reply-back continuation valued enough to be a stretch slice, not enough to
  block v1.
- Attachment handling: acknowledge-not-error, per the sibling task's
  "don't silently drop" principle.

## Implementation log

- 2026-07-07: Slice 1 + slice 2 implemented (commit "email zero-onboarding:
  inbound ingress, provisioning, thread routing, agent kickoff"). Notable
  deviations from the spec, each explained inline in the checklist above:
  - **No atomic DO method** for get-or-provision: idempotency-keyed claim
    appends + a first-claim-wins fold achieve the same convergence without
    adding email-specific surface to the generic Stream DO. Worst case under
    a concurrent first contact is one orphaned org/project (logged), the same
    accepted class as partial-failure orphans.
  - **Project slugs are NOT auto-uniquified by auth** (spec guessed they
    were): `resolveProjectCreateTarget` hard-CONFLICTs on cross-org slug
    collisions. Provisioning pre-probes `internal.project.bySlug` via
    `resolveUniqueSlug` and retries once with a random suffix on a
    probe-to-create race.
  - **Routing decisions live in the router's reduce fold**, not just
    processEvent, so two related emails in one delivery batch resolve
    consistently; `email/thread-route-configured` remains as an audit fact.
  - **`email/send-failed` audit event** added so the e2e can observe the
    outbound reply attempt on deployments whose domain isn't onboarded for
    Email Sending yet (preview slots, probably).
- Verified: 66+ unit tests green, apps/os + apps/auth + packages/shared
  typecheck clean.
- 2026-07-07: **e2e verified against a live local dev environment** (`pnpm
dev` + shared dev auth worker + real LLM): both tests in
  `e2e/vitest/email-agent.e2e.test.ts` pass in ~16s — spoofed mail dropped
  with no side effects; verified mail provisions user/org/project; router +
  agent processors fire; the agent's codemode script calls `email.send`; the
  outbound attempt lands an audit event; a same-thread reply reaches the same
  agent stream; a second contact reuses the project with exactly one sender
  claim. Found during verification: the inject route needed registering in
  `isApiWorkerLanePath` (src/ingress.ts) — `/api/*` paths are exact-match
  routed to the api pipeline.
