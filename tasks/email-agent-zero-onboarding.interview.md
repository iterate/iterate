# Interview log: email-agent-zero-onboarding

Grill session between main-claude (answering as Misha, guesses tagged `[guess: ...]`) and a sub-claude interviewer running `grill-with-docs` (sonnet, session `64552595-c44b-4de1-8158-1ba0093e706c`).
Dossier: /tmp/grillings/iterate/email-agent-zero-onboarding/dossier.md — raw turn JSON in the same directory.

---

## Q1 — trust model: what verification gates auto-provisioning — 2026-07-07

Sub-claude noted Cloudflare Email Routing gives no `verified: true` boolean — the Worker gets the envelope `from` plus an `Authentication-Results` header with Cloudflare's own SPF/DKIM/DMARC verdicts. It recommended: require `spf=pass` AND `dkim=pass` for the envelope-from domain; drop (log, no reply) on failure so we're not a bounce oracle; gate brand-new-sender provisioning behind a per-env boolean in envs.ts (on for dev/preview_N, off for prd initially); new user gets owner role on the auto-created org. It also confirmed `internal.user.upsertVerifiedEmail` exists with zero callers today — an unused building block meant for exactly this flow.

## A1

Yes, with one adjustment: identity primitive is the **From header** address (what Joe sees and where replies go), and the verification must **align** with it — require `dmarc=pass` OR (`dkim=pass` with the DKIM domain aligned to the From domain). SPF/envelope alone is insufficient (forwarding breaks SPF; envelope sender can differ from From, and keying identity on an unverified From header would be the actual spoofing hole). `[guess: exact predicate is my call, but "authenticated domain must align with From domain" is the non-negotiable part]`. Drop+log on failure, no reply. Env gate `emailZeroOnboardingEnabled` on for dev/preview_N, off for prd; prod flip is a follow-up, not this task. Owner role agreed. Addition: normalize by lowercasing only — do NOT strip +tags or dots; `joe+x@gmail.com` is a distinct identity (useful for testing).

---

## Q2 — addressing: the reserved "bot" local part — 2026-07-07

Sub-claude confirmed `resolveProjectCreateTarget` (apps/auth/src/server/orpc/routers/project-slugs.ts) has no reserved-word check today, so a project named `bot` would shadow the global address. Recommended: derive domain from `projectHostnameBases[0]` (bot@iterate.app / bot@iterate-preview-N.app, no new envs.ts field for the address); hardcode local part `"bot"` as a constant next to the address codec, checked before slug fallthrough; reserve the slug in auth; replies always from the provisioned project's address, never bot@. Asked: reserve just `bot` or a wider platform-word list?

## A2

Wider list — no-brainer, near-zero cost: `bot, admin, administrator, support, help, postmaster, abuse, security, noreply, no-reply, mailer-daemon, root, info, contact, team, hello` (noreply matters — auth already sends OTP as `noreply+auth@<domain>`). Boring string-array constant exported from one place; auth slug resolution rejects them for project AND org slugs. `[guess: exact word list is mine, trim/extend freely]`. Rest agreed; note the Q1 enablement boolean is still a new envs.ts field.

---

## Q3 — provisioning chain, idempotency, naming — 2026-07-07

Sub-claude confirmed the Slack directory pattern (`routeSlackWebhook`, global directory stream folded to Map<externalId, projectId>) but flagged that Slack's read-then-append is only race-safe because "unclaimed" is a no-op there. Recommended: new `EMAIL_SENDER_DIRECTORY_STREAM_PATH` global stream; OS-orchestrated provisioning chain (`upsertVerifiedEmail` → `createForUser` → `createForOrganization`, no new composite auth endpoint); make get-or-provision a single serialized method on the directory-owning Durable Object to prevent double-provisioning; derive names from the sender local part with a deterministic userId-based suffix (e.g. `joebloggs-x7k2`) instead of probe-and-retry.

## A3

Atomic DO method: yes, exactly. Chain: agreed, OS-orchestrated, no composite endpoint for v1. Naming: **pushed back on the deterministic suffix** — auth already has `resolveUniqueSlug` (the existing convention interactive signup uses, and it produces nicer slugs like `joebloggs`, `joebloggs-2`). Slugify the local part, hand it to auth, let auth uniquify. Only if implementation reveals `resolveUniqueSlug` isn't concurrency-safe, fix THAT (pre-existing flaw), don't invent a suffix scheme. `[guess: haven't read resolveUniqueSlug internals]`. Partial failure: claim event only appended after the full chain succeeds, so retry re-runs the chain; worst case an orphaned org — accepted v1 tradeoff, documented, no saga.

---

## Q4 — email() ownership and the synthetic-injection seam — 2026-07-07

Sub-claude checked the slack e2e template and noted Cloudflare's `ForwardableEmailMessage` has no HTTP surface to fake from outside and Cloudflare won't run SPF/DKIM for a throwaway domain. Recommended: `email()` on the OS worker (same bindings as fetch/queue); architect as thin adapter parsing to a plain shape, calling one shared `handleInboundEmail`; an admin-secret-gated `POST /api/integrations/email/inject` route that builds the same shape (including a crafted `Authentication-Results` header) and calls the same function — leaving only Cloudflare's own SPF/DKIM computation untested, which is Cloudflare's contract; idempotency key = Message-ID else stable hash.

## A4

Shape agreed; inject route at admin-secret tier agreed; it doubles as the local-dev story (can't trigger email() in wrangler dev anyway). **One adjustment: make the internal shape rawer** — inject accepts `{envelopeFrom, envelopeTo, rawMime}` and `handleInboundEmail` does its own MIME parsing, so the parser is e2e-covered rather than only running against real Cloudflare deliveries. Tests build raw MIME with template strings. Only Cloudflare-specific bits (stream draining, `.setReject()`) stay in the `email()` adapter. `[guess: postal-mime as parser — pick whatever is smallest/workers-compatible]`.

---

## Q5 — agent path, threading, input shape — 2026-07-07

Sub-claude traced Slack's convention: one stable agent path per conversation (`/agents/slack/<channel>/ts-<threadTs>`), router processor decides once, input is the raw payload dumped as YAML with no explicit "reply via Slack" text. Recommended mirroring: `/agents/email/thread-<hash of root Message-ID>`; router processor tracks Message-ID → agent path, In-Reply-To/References reuse the path; YAML-dumped parsed email as input; mirror whatever mechanism makes Slack agents know their reply channel (untraced — flagged as implementation task); fresh provisioned project gets stock default agent config.

## A5

Path/threading: yes as described. "To-be-traced" is fine as a task-file item, **not fine as a shrug**: the e2e acceptance criterion is an observed outbound reply attempt, so whatever it takes to make a fresh default project agent reply by email is in scope. Explicit fallback if the Slack mechanism doesn't generalize: include a short preamble in the email-thread agent input ("this arrived by email from <addr>; reply using itx.email.send with these threading headers"). Prefer mirrored mechanism, fall back to preamble. `[guess: Misha cares about the demo working end-to-end more than mechanism purity]`. Fresh-project default config agreed.

---

## Q6 — reply path specifics — 2026-07-07

Sub-claude found a scope correction: shipped `EmailCapability.send` (apps/os/src/types.ts) has **no `inReplyTo`/`references` params** — threading is not "already wired up" as the dossier assumed. Recommended: extend `EmailCapability.send` + `buildProjectEmailMessage` with threading headers and a generated/returned outbound `Message-ID`; from-address enforcement unchanged; v1 text/html only, artifacts as links via existing hosting; router processor records outbound Message-IDs too so human replies to bot replies thread.

## A6

Agreed on all. One nit: inbound emails WITH attachments must not error the flow — parse and proceed with text/html, note attachment metadata in the agent input so the agent can acknowledge it can't read them. Silently dropping content is worse than acknowledging it. `[guess: matches sibling task's "don't silently drop attachments" principle at minimum cost]`.

---

## Q7 — testing strategy — 2026-07-07

Sub-claude checked `create-test-project.ts` — established convention is explicitly **no cleanup** (disposal documented no-op, preview stages periodically reset). Recommended: no OTP-style test-address convention needed (inject endpoint IS the trust bypass — tests craft their own passing Authentication-Results); unique-per-run synthetic senders to exercise brand-new-sender path; a second test reusing a fixed address to prove idempotency; waitFor-polling assertions (directory claim → agent input-added → outbound reply attempt); no cleanup; no special env override since the gate is on for preview_N.

## A7

Agreed on all. Two additions: (1) synthetic senders use a non-deliverable TLD (`@example.test`) deliberately so if a reply send fires for real on preview, nothing leaves the building — assert the attempt/audit event, not delivery; (2) the idempotency test asserts the SAME projectId both times and that no second user/org got provisioned.

---

## Q8 — v1 scope cuts: size, loops, rate limiting — 2026-07-07

Sub-claude observed the public-abuse surface is smaller than it looks: until real MX is attached, the only ingress is the admin-gated inject endpoint. Recommended: 1MB raw-MIME cap (drop+log); `Auto-Submitted`/bulk-header loop guard in shared `handleInboundEmail`; **defer rate limiting** to the prod-MX follow-up (which must bundle it as a prerequisite); beta allowlist superseded by the env gate.

## A8

Agreed on all four. Write the rate-limiting dependency INTO the task file so the prod-MX follow-up can't forget it.

---

## Q9 — reply-back continuation dependency — 2026-07-07

Sub-claude surfaced a dependency before closing: "human replies thread back" assumes an inbound handler for `<slug>@<domain>` — the sibling task's unshipped inbound half. Asked: is conversation continuation in scope, or is v1 strictly one-shot? Recommended one-shot with Message-ID plumbing built anyway.

## A9

Split the difference: **acceptance bar is one-shot**, but conversation continuation is an explicit second slice / stretch section in the SAME task, because (a) the e2e can drive it via inject with zero MX dependency, and (b) it's a thin slice over plumbing this task already builds — inbound to `<slug>@<domain>` whose In-Reply-To/References matches a known thread routes to that thread's agent path. Unmatched `<slug>@` mail stays drop+log, deferred to the sibling task (full inbox semantics remain sibling scope). Note in BOTH task files that sibling inbound work must reuse this task's directory + thread router. `[guess: Misha values the reply-back demo enough to want the thin slice, but not enough to block v1 on it]`.

---

Sub-claude confirmed every branch resolved, added CONTEXT.md entries (**Email Sender Claim** glossary term + a fact distinguishing it from Slack Team Claims), and declared ready for Phase 2.
