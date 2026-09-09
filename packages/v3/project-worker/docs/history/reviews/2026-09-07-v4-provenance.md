# Signed / validated events (v4 provenance) — reviewed against v3

## 1. What v4 has

**Files** (code lines = non-blank, non-comment, measured):

| File                                            | total | code    | what                                                                                                   |
| ----------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------ |
| `packages/v4/project-worker/src/provenance.ts`  | 364   | **310** | the whole feature: zod schemas, canonical message, WebCrypto verify, `decideTrust`, `TrustPolicyStore` |
| `src/stream/events.ts` (delta vs v3)            | +16   | ~12     | two envelope fields + the idempotency-equality widening                                                |
| `src/iterate-context-durable-object.ts` (delta) | —     | ~25     | `#trust`, the async prepare, the sync-door guard                                                       |
| `src/stream/stream.ts` (delta)                  | —     | ~9      | `StreamCommitParticipant` + `appendSystem` (shared with repos/fetch-policy)                            |
| `src/lib/errors.ts` (delta)                     | —     | 4       | two codes + two HTTP statuses                                                                          |
| `e2e/provenance.e2e.test.ts`                    | 284   | 242     | 9 tests                                                                                                |
| `e2e/trusted-mechanical-facts.e2e.test.ts`      | 240   | 208     | 5 tests, mostly system facts under a locked policy                                                     |

Non-test total attributable to provenance: **≈ 360 code lines**.

**Public API as spelled** (`src/provenance.ts`):

- `provenanceMessage(input: Record<string, unknown>, location: { projectId, path }): string` — the canonical
  UTF-8 body a signer signs: `canonicalJson({ event: { type, payload?, metadata?, source?, idempotencyKey? },
path, projectId, v: 1 })`, keys sorted (`provenance.ts:248-266`, `328-338`). Offset, `createdAt`, the evidence
  itself and the receipt are deliberately excluded.
- `prepareProvenance(input, location): Promise<ProvenanceVerification | undefined>` — the async half: parse,
  refuse a caller-supplied `verification`, refuse evidence on an ephemeral, `crypto.subtle.importKey/verify`
  each Ed25519 signature, refuse duplicates, return `{ signerKeyIds: sorted [`ed25519:<b64url>`] }`
  (`provenance.ts:270-326`).
- `decideTrust(event, cryptoVerification, state): TrustDecision` — pure; the policy decision
  (`provenance.ts:133-191`).
- `class TrustPolicyStore { constructor(sql); apply(event): void }` — one SQLite table
  `provenance_trust_policy (singleton, policy, configured_offset)` in the DO's own storage; `apply` stamps
  `event.verification` and writes the next policy inside Stream's transaction (`provenance.ts:198-244`).
- `isTrustConfiguration(event)`, `TRUST_CONFIGURATION`, types `ProvenanceEvidence`,
  `ProvenanceVerification`, `TrustPolicy`. **None of it is exported from the SDK** — `src/sdk/index.ts` does
  not re-export `provenanceMessage`; the four e2e files import it from `../src/provenance.ts` directly.

**Envelope changes** (`src/stream/events.ts:29,45`):

- input: `provenance?: { signatures: [{ algorithm: "Ed25519", publicKey: string≤86, signature: string≤86 }] }`
  (1–16 entries);
- committed: `verification?: { signerKeyIds: string[]; signers?: {keyId,trusted}[]; level?: 0|1|2;
policyOffset?: number }`;
- `sameIdempotentEvent` now also compares `provenance` and `source` when either side is signed
  (`events.ts:59-76`) — a signed retry that changes attribution is an `IDEMPOTENCY_CONFLICT`.

**Events it appends**: exactly one type, and it is an ordinary durable event the caller appends —
`events.iterate.com/provenance/trust-configured`, payload `{ keys: string[] (each `ed25519:<32-byte
canonical base64url>`, ≤64, distinct), minimumLevel: 0 | 1 | 2, minimumSigners?: 1..16 (default 1) }`
(`provenance.ts:82-102`). Nothing else is appended; the receipt rides the event being appended.

**Semantics**: level = 2 if any signer is in `policy.keys`, 1 if signed by anyone, 0 if unsigned
(`provenance.ts:157-161`). With a policy installed, `level < minimumLevel` or too few accepted signers ⇒
`PROVENANCE_REQUIRED` (403); a reconfiguration must itself carry a currently-trusted signer
(`provenance.ts:172-180`). Policy applies in event order within a batch, from the row committed _before_ the
batch, so a rotation and the first fact under the new key land atomically (`e2e/provenance.e2e.test.ts:215-274`).
Before any policy exists, unsigned events keep the byte-identical old envelope (`provenance.ts:149-150`).

**Config / bindings / infra**: none — no secret, no binding, no DNS. It needs WebCrypto Ed25519 (present in
workerd) and one extra SQLite table per context.

**Tests**: `e2e/provenance.e2e.test.ts` (plural evidence + receipt, tamper, signed idempotent retry, retry
cannot swap `source`, forged receipt refused, evidence on ephemeral refused, base64url alias refused,
duplicate signer refused, bootstrap → locked → atomic rotation) and `e2e/trusted-mechanical-facts.e2e.test.ts`
(system facts still land in a locked context). `e2e/approval.e2e.test.ts`, `egress-deployed.e2e.test.ts`,
`fetch-policy-authority.e2e.test.ts` sign their events too. **There is no unit/table test**: no file under
`src/**` imports `provenance.ts` except `events.ts` (types) and the DO. The e2e lane can be pointed at a
deployment (`e2e/support/client.ts:10-17`, `WORKER_BASE_URL`); `docs/preview-proof.md:712-714` records the
deployed matrix that includes provenance passing 30/30.

**What inside v4 it depends on**: the v4-only `StreamCommitParticipant` seam (`stream.ts:36-38,82,393`),
`Stream.appendSystem` (`stream.ts:282`) so platform lifecycle facts bypass the gate, the DO's async
`append` (`iterate-context-durable-object.ts:411-421`) and its refusal of signed events on the synchronous
pager door (`:432-443`), and `lib/errors.ts`. One consumer treats the receipt as authority:
`fetch/policy.ts:229` refuses an egress approval whose event is not `verification.level === 2`
(`iterate-context-durable-object.ts:354`).

## 2. What v3 has today for the same need

Tonight's IDENTITY arc (BUILD-LOG `2026-09-06 — identity`, commit 773978230):

- `src/principal.ts` (112 lines, 86 code): a **project token** `{ projectId, actor, email?, expiresAt }`,
  HMAC-SHA256 with `APP_CONFIG_PROJECT_TOKEN_SECRET`; `signProjectToken` / `verifyProjectToken` /
  `stampPrincipal`. `session.authenticate({ projectToken })` → `session.whoami()`, `projects.get` bound to
  the token's one project (`src/session.ts:92-124,164-175`).
- The principal rides one dispatch: `IterateContextDurableObject.invokeAs(principal, call, …)` over an
  `AsyncLocalStorage` (`iterate-context-durable-object.ts:743-750`), or the `x-itx-principal` header on the
  fetch lane (`:777-784`).
- The **append root stamps it**: `context/built-ins.ts:324` —
  `append: (...e) => ownContext().append(...e.map(event => stampPrincipal(event, deps.principal())))`, so
  `source.principal` is the DO's field and a client-supplied one is dropped. Every edge verb writes through
  that same door (`iterate-context.ts:377`).
- Doctrine: identity is **attribution, not authority** (trusted client).

**Where v4's design conflicts with v3:**

1. **The signed body includes `source`, which v3's platform owns.** `provenance.ts:253-259` signs `source`;
   v3 stamps `source.principal` at `built-ins.ts:324` _before_ `DO.append` runs. Adopt v4 verbatim and every
   signature from an authenticated session fails verification. This is the single most concrete collision.
2. **A second commit-time projection beside the core reduce.** v3's core reduce already owns exactly this
   shape of row — `CoreState.paused` is a durable-event-configured _admission gate on append_
   (`stream/core-processor.ts:226`, gate at `stream/stream.ts:335-346`), alongside
   `itxExpressionRewriteRules` and `subscriptions`, checkpointed with the batch. v4 instead adds a private
   SQLite table plus `TrustPolicyStore` that re-reads and re-parses a row per event. v4's own workers test
   names the failure mode this creates: `no such table: provenance_trust_policy`
   (`__workers-tests__/uncontrolled-degradation.test.ts:749-767`). This violates "the core reduce owns all
   sync state".
3. **`minimumLevel ≥ 1` breaks the session verbs.** `provide`, `subscribe`, `enableProcessor` build events at
   `iterate-context.ts:377`, and the rpc-stub rule _rides the pager upgrade_ and is appended by the DO's
   **synchronous** door, which v4 makes refuse any signed event (`iterate-context-durable-object.ts:432-443`).
   v4's own reading guide concedes it: "With a nonzero minimum trust level, a new unsigned `provide` or
   `subscribe` is refused" (`docs/reading-guide.md:226-229`). So a locked context can no longer lend an rpc
   stub at all — v3's central vocabulary.
4. **Level 1 is worth nothing and level 2 is authority.** Anyone can generate a keypair, so `minimumLevel: 1`
   refuses nobody. And `fetch/policy.ts:229` makes `level === 2` the _authorization_ for an egress approval,
   contradicting the file header's "authorization remains a separate policy concern".
5. **No policy read door and no policy in live state.** The only way to learn the current policy is to scan
   the log for the last `trust-configured`. Had it been a `CoreState` field it would ride core live state and
   the existing `rewriteRules.list()`-shaped precedent for free.
6. **Attribution ≠ an auditable log.** There is no hash chain anywhere in v4 (grepped): signatures prove
   "this key said this fact at this address", not that the log is complete or unreordered.
7. **The verifier is not shippable.** `provenanceMessage` is absent from `src/sdk/index.ts`, so an
   independent verifier must re-derive the canonical JSON by hand — which is the whole value proposition.

**What per-event Ed25519 actually buys over v3's principal** — sharply:

- **Offline / third-party verification: yes, real.** v3's principal is a platform assertion derived from an
  HMAC bearer token; verifying it requires the shared secret, i.e. being the platform. An Ed25519 signature
  over the event body is checkable by anyone holding the public key, from an export, forever.
- **Signers with no session: yes, and this is the only thing v3 genuinely cannot do.** A device, a build
  system, a partner, an offline agent can sign a fact that somebody _else_ relays; the principal only ever
  describes the relayer.
- **Non-repudiation across projects: no, as built.** The canonical message pins `projectId` and `path`
  (`provenance.ts:260-265`), so a signed fact cannot be re-verified after being copied to another project or
  context. That is the right anti-replay call, but it means the evidence is not portable — the README's
  cross-project story is not delivered by this code.
- **Access control: no, and the README says so** — at `minimumLevel: 0` an unsigned holder may rewrite the
  trust policy and the rewrite rules. That is fine under v3's trusted-client doctrine, and it means the level
  ladder is not buying security, only a self-imposed lock.

## 3. Proposed layering on v3

Litmus test: verifying signatures could be written in a userspace worker; **refusing an append cannot**.
So the gate is an axiom of the log, and nothing here becomes a new root or a library module.

- **Envelope (axiom).** `StreamEventInput.provenance?: { signatures: { algorithm: "Ed25519"; publicKey:
string; signature: string }[] }` in `src/stream/events.ts` — v4's shape, kept.
- **Receipt lives where the principal lives.** `source.signers?: string[]` (sorted `ed25519:<b64url>` key
  ids), stamped by the DO next to `source.principal`. One home for "who", one field, no `verification`
  object. `level`, `signers[].trusted` and `policyOffset` are dropped: all three are recomputable from the
  policy events, and v4's own docstring calls them "a dated policy decision".
- **Signed body excludes `source`.** `provenanceMessage(event, { projectId, path })` signs
  `canonicalJson({ event: { type, payload?, metadata?, idempotencyKey? }, path, projectId, v: 1 })`. The
  platform owns `source`; a client cannot sign what the DO will overwrite. This is the fix for conflict 1.
- **Policy is a core row.** `CoreState.provenanceTrust: { keys: string[]; minimumSignatures: number } | null`
  in `src/stream/core-processor.ts`, fed by one new core event type
  `events.iterate.com/provenance/trust-configured` added to `CORE_EVENT_TYPES`. **One knob, not two**:
  `minimumSignatures: 0` = receipts only (today's behaviour); `n ≥ 1` = at least n of `keys` must sign. The
  0/1/2 ladder goes away with level 1, which refuses nobody.
- **The gate sits beside the pause gate**, in `Stream.append` step 1 and inside the per-event fold, reading
  the same local `reducedState` the core reduce is folding (`stream/stream.ts:425-440`) so a rotation batch
  behaves exactly as v4's does. A reconfiguration must be signed by a currently trusted key. Refusal is
  `PROVENANCE_REQUIRED`; malformed evidence is `PROVENANCE_INVALID`.
- **The verify lives in `src/principal.ts`** — signatures layer _on_ the principal by living in the same
  "who" module: `verifyEventSignatures(event, { projectId, path }): Promise<string[]>` returning key ids.
  The DO's async `append` calls it before the synchronous commit and stamps `source.signers`; the
  synchronous pager door refuses events carrying `provenance` or a client-supplied `source.signers`.
- **The platform bypasses the gate.** v3 needs v4's `Stream.appendSystem` split (or equivalent) so
  `stream/created`, `stream/woken`, `subscription-delivery-halted` and the dead-pager cleanup still land in a
  locked context. Keep this — v4 earned it with `e2e/trusted-mechanical-facts.e2e.test.ts`.
- **Export `provenanceMessage` from `src/sdk/index.ts`** so a signer and an offline verifier can be written
  against the same canonical function.

**Deliberately left out**: the level ladder; the `verification` object; the separate SQL table and
`TrustPolicyStore`; key→actor registration events; a policy read verb (the log and core live state answer
it); a signature as authorization for egress approvals; a hash chain (a separate feature).

**Where v4 is better than any first instinct, and should be copied**: the async-prepare / sync-commit split
(WebCrypto cannot run inside Stream's synchronous transaction); refusing a caller-supplied receipt; strict
canonical base64url so a key id has one spelling; forbidding evidence on ephemerals (they are never stored,
so evidence would be unverifiable later); widening idempotency equality so a signed retry cannot silently
swap its evidence or attribution.

## 4. Implementation sketch

1. **Canonical message + verify** — add to `src/principal.ts`: `provenanceMessage`, `canonicalJson`,
   canonical base64url decode, `verifyEventSignatures`. Extend the existing 10-row table test
   (`src/principal.test.ts`) with rows for: tamper, alias base64url, duplicate key, bad algorithm, wrong
   address. _Proof: the table test (local) — this is the pure module, per the one-file + table-tests rule._
2. **Envelope** — `src/stream/events.ts`: `provenance` on the input, `signers` inside `source`, widen
   `sameIdempotentEvent` exactly as v4 does.
3. **Policy row + gate** — `src/stream/core-processor.ts` (one `CoreState` field, one `CORE_EVENT_TYPES`
   entry, one reduce case, contract version bump) and `src/stream/stream.ts` (the refusal next to the pause
   check, reading the folding local). `src/lib/errors.ts`: `PROVENANCE_INVALID` 400, `PROVENANCE_REQUIRED` 403.
4. **System appends** — add `Stream.appendSystem` and route the DO's own lifecycle facts (wake record, dead
   rpc-stub rule un-set, delivery halt) through it, so a locked context still records mechanics.
5. **The doors** — `src/iterate-context-durable-object.ts`: verify in the async `append` before
   `stampPrincipal`, stamp `source.signers`, and refuse `provenance` / client `source.signers` on the
   synchronous pager path.
6. **SDK** — export `provenanceMessage` from `src/sdk/index.ts`; add `e2e/support/signer.ts`.
7. **Deployed proof** — `e2e/signed-events.e2e.test.ts`: (a) an unsigned context is byte-identical to today;
   (b) a signed event carries `source.signers` next to `source.principal` from an authenticated session
   (this is the test that would have caught conflict 1); (c) tamper ⇒ `PROVENANCE_INVALID`, nothing appended;
   (d) `minimumSignatures: 1` refuses unsigned, and an atomic rotation batch lands; (e) a locked context
   still records `stream/woken` and a delivery halt; (f) a signed retry cannot swap attribution. Run against
   the deployed worker with `WORKER_BASE_URL`, per the deployed-proof doctrine.

## 5. Effort

Upper bound is v4's ≈ 360 non-test code lines. The proposal removes the level ladder, the receipt object,
the private SQL table and `TrustPolicyStore` (≈ 90 of v4's 310 lines) and reuses the core reduce and its
checkpoint. Estimate: **principal.ts +95, core-processor.ts +18, stream.ts +22, DO +20, events.ts +12,
errors.ts +4, sdk/index.ts +1 ≈ 170 code lines**, plus ~60 lines of table rows and ~130 e2e lines.
At tonight's density (≈ 300 code lines with tests, docs and a deployed proof in ~3 hours):
**3–4 hours**, of which about an hour is the deploy-and-prove loop.

## 6. Dependencies and sequencing

- **Must land first**: nothing external — no binding, no secret, no DNS, no control-plane change. It does
  need tonight's identity arc (`src/principal.ts`, `source.principal`) already in the tree, which it is.
- **Couples to**: the `appendSystem` split (step 4) — shared with any other v4 feature whose
  platform-authored facts must survive a userspace gate (repos, fetch policy). Land it once, here or there.
- **Independent of**: project-host ingress, repos, worker loading, the fetch/secrets policy. If that policy's
  approval gate is ported, decide separately whether it uses signers as authority (v4 does; I would not).
- **Unblocks**: an offline verifier / export tool; device- and build-system-signed facts (Gap 7's machine
  credential could be a keypair, not a bearer secret); any fact attributable to a party with no session.

## 7. Risks and questions for Jonas

1. **Is there a real signer that is not a session?** The whole feature earns its keep only if yes — a device,
   a build system, a partner, or an export somebody outside iterate must verify. If every writer
   authenticates to `/api`, `source.principal` already answers "who" and this is 360 lines of speculative
   machinery. This is the decision.
2. **Do we want the lock at all?** `minimumSignatures ≥ 1` is a malicious-client defence at the append door,
   which the trusted-client doctrine says we do not build. My proposal keeps it because a _project_ may want
   to lock itself, but "receipts only, no gate" is half the code and none of the sharp edges.
3. **Locking kills `provide`.** With any gate on, unsigned `provide` / `subscribe` are refused and the
   pager-attach path cannot carry a signature at all. Either the session verbs learn to sign, or configuration
   events are exempt from the gate, or locking is documented as "no live lending". v4 shipped this edge
   unresolved (`docs/reading-guide.md:226-229`) — it needs a decision, not a note.
4. **Signatures without a chained log.** If the goal is "prove what happened", per-event signatures are half
   the answer; a per-offset hash chain is the other half and does not exist in v4. Is the chain wanted?
5. **Portability.** Binding to `{ projectId, path }` means a signed fact cannot be verified after being
   copied elsewhere. Correct for replay, wrong for "carry this receipt to another project". Which do we want?
6. **Unverified v4 claims.** I read the code but did not run v4's tests. I could not verify: that the
   deployed 30/30 matrix in `docs/preview-proof.md:712` corresponds to the provenance file as it stands now;
   that a hosted processor's own emitted events (which go through the trust-gated `append`, not
   `appendSystem`) still work in a locked context — no test covers it; or that WebCrypto Ed25519 verification
   at 16 signatures per event stays inside the DO's CPU budget under load.
