# iterate — the interview (append-only)

> **What this is.** A running, append-only transcript of Claude interviewing Jonas to
> harden `DESIGN.md`. Format: each entry is a **Q** (with concrete code / a hypothetical),
> Jonas's **A** (his honest answer, captured close to verbatim), and a short **→** note
> on what it changes in `DESIGN.md` (which Belief / Requirement / Decision / Taxonomy /
> Open-question it feeds). Ideas Claude floats are marked **[idea]** with pros/cons.
>
> **Rules.** Append only — never rewrite a past Q&A. The **Backlog** at the very bottom is
> the one living list (questions Claude still wants to ask); it gets rewritten freely.
> Entries are numbered I1, I2, … so we can point at them.

---

## Session log

<!-- entries appended below, oldest first -->

### I1 — Are the event dimensions really 3 independent knobs, or is side-effects derived from TTL?
**Asked.** You said side-effects-allowed feels "tied to TTL — a bit messy." My candidate
resolution: there are only **two independent knobs** — *delivery* (broadcast vs opt-in)
and *retention/TTL* (durable vs expiring) — and **side-effects-allowed is *derived*, not
set.** The reason it couples to TTL is [[R6]]: side effects survive eviction by being
**re-driven from the log on wake** (idempotency-key re-drive of an open obligation). You
can only re-drive an obligation whose triggering fact is **still there** — so an event
that will age out **must not** be the sole cause of a durable side effect. Hence
"no side effects" ⟺ "will expire", by the recovery model, not by accident.
Concrete trace posed: an inbound **voice call** — PCM chunks at ~50/sec, a transcription,
a "book the meeting" side effect, TTS chunks back out — which dimension is set how on each
of those five kinds of event?

**A:** Agrees the recovery logic *couples* side-effects to TTL — but **rejects *deriving***
the flag from TTL, on **principle-of-least-surprise** grounds ("this event has TTL 0 and
*therefore* doesn't run through processEvent" is surprising; `sideEffects: "disallow"` is
obvious). So model side-effects **explicitly.** "Ephemeral" = colloquial combination of
(a) **excluded-by-default from subscriptions** — the one that matters now: high-freq
chunks are opt-in via the `subscribe` signature for **push, pull, *and* waitFor**, so a
quick `itx.subscribe` isn't flooded; (b) **TTL** (null=forever, 0=deletable; implementation
**deferred** to detailed stream design, + R2 offload for >10 GB); (c) explicit side-effects
flag. Left the durable-transcript sub-question unanswered → **pinned.**
**Meta-instruction:** stop asking hyper-detailed questions — ask **broad, directional**
ones; when he volunteers a detail, *then* go deeper; file parked detail here and return to
the big picture.

**→** refined [[D11]]; [[Q16]] resolved-direction + TTL pinned; saved feedback memory
(broad-strokes interviewing).

### I2 — Is there a part of the organism it's *not allowed* to change? (the membrane)
**Asked (broad):** does a digital organism have a tiny un-editable membrane, held by the
platform, à la DNA-repair / apoptosis in a cell?
**A:** **100% yes — there must be guardrails.** Contents: (1) **crypto human-approval**
(secure enclaves) — for legal constraint, taken seriously, used rarely; gates
merge/push-to-main (PR-review-like) and high-risk egress (large Stripe refunds via egress
policy); (2) **spend control** — a key human-world input, implicit (LLM) + explicit
(virtual cards, third-party, infra); a big missing primitive; spend also happens in
third-party systems → a **money-spent event** on any stream, tagged, aggregated at levels,
with a global **kill switch**; argues for per-project third-party API keys + possibly
**per-project Cloudflare accounts** so infra spend is capped per customer; (3)
**runaway/loop controls** requiring human sign-off; (4) the **live-version pointer = the PR
idea**. "Everything needs to be able to grind to a halt."
**→** new [[D14]] (the membrane), [[B5]] (spend ceiling = human input), [[R14]] (uniform
spend tracking + halt), updated [[R10]] (spend containment), [[Q15]] elevated. **Pins:**
membrane name; money-spent-event mechanics.

### I3 — What physically forces the organism through the one egress door?
**Asked (broad):** is the egress door a physical chokepoint code can't route around, or a
door we ask it to use? Does that mean sandboxing even trusted git-repo code?
**A:** **Emphatically physical, and yes — all code is sandboxed.** "At the network level
there must be NO way to fetch the internet without going through our gate." Mechanism = a
**programmable man-in-the-middle SSL egress proxy** at the project boundary — like
**draconian enterprise security** (log, capture/store all egress, filter, data-mine, DLP).
The code runs in a **sandbox**: a Cloudflare **dynamic worker**, or a **VM / Cloudflare
container with egress interception**. Cloudflare general-purpose sandboxes **force egress
through the container Durable Object** whose `fetch` is the MITM proxy; a **borrowed Mac**
lent to the project has its egress forced through the gate too. No un-proxied path out,
from anywhere. Secrets that mutate the world: the **agent must never see them** (like human
devs never seeing prod secrets; far-future exception: briefly, when the agent creates one).
Also volunteered: **spend is transitive** — sub-budgets with "come back to me when the $20
is gone."
**→** new [[D15]] (egress = programmable MITM SSL proxy + sandboxed code + forced routing),
refined [[R14]] (transitive budgets), [[D10]] (never-see), §7.7, §7.9. Pin: what MITM SSL
rules out (cert pinning); DLP policy surface.

### I4 — Do we wait for the reaction? → the two primitives
**Asked (broad):** does `append` wait for the reaction, or just for durability? Is the
config worker a stateless function or a resident Durable Object?
**A:** You **must** wait for durability (for sure). Waiting for the *whole reaction* — "it
just depends." The **fundamental operations are just two: `append`, and `consume`** a
stream from a starting offset (check every event). Everything else is an **optimisation**
on top: "append waits for durability but you wait for outcomes yourself" is expressible as
consume; server-side filters (JSONata / a discrete type filter) are just *faster* ways to
do consume-and-check — "logically that's what this is, that's what we're building."
**→** new [[D16]] (two primitives: append + consume; `processEvent` = hosted consume,
`waitFor` + filters = optimisation); [[Q5]] **resolved** (stateless stands, DO is only the
ordering point; placement is an optimisation). Taxonomy: `append`, `consume` (+ flagged:
consume vs subscribe).

---

## Backlog — questions still to ask (living list, reorder freely)

_Seeded from DESIGN.md §8 open questions + the tensions between locked decisions.
Codex (gpt-5.6-sol, xhigh) and a prior-art researcher are feeding this list in the
background._

> **⚠️ Interview style (Jonas, 2026-07-15):** ask **broad, big-picture, directional**
> questions ("where are we going / how does it work in the abstract"). Do **not** open
> with hyper-detailed mechanics. When Jonas volunteers a detail, *then* a detailed
> follow-up is welcome; otherwise **file the detail here as a pin** and steer back to the
> big picture. (Misses to avoid: TTL-value tables, "quarantine a poison event after how
> many retries," etc.)

**Load-bearing (ask first):**
- **Q5 — config worker: stateless vs Durable Object; do we *wait* on processEvent?**
  Jonas's instinct ("we do have to wait — how else would it work?") vs D3 react-only vs
  R13 stateless ingress vs R12 concurrency. *(asking now — I1)*
- **Q4 — built-ins as capability mounts + the perf cost**; is the clean model "hooks"
  (a processor reacts to repo-push / worker-built and installs capabilities)?
- **Q7 — what do we call the non-kernel layer** (not "packages"), and where exactly is
  the line between a deep first-party module and a userspace extension?
- **Q8 — updating a million projects** without rebasing a million repos (apt / App-Store
  channel-or-pin model?).

**Streams & events:**
- **Q3 mechanics** — obligation convention (`requested → completed{outcome}`): at-head
  guard, idempotency-key re-drive. Worth a worked code trace?
- **D11 vs R5** — if ephemeral events (audio, tokens) are evictable, what exactly *is*
  the durable trace of a voice call? What's the rule for "distill ephemeral → durable"?
- **D7 leak test** — name the case where "one stream abstraction" visibly strains
  (e.g. a 50k-row relational query; a fan-out to 10k subscribers).

**Capabilities / security:**
- **Q9 — expressions that look like TypeScript** with a tiny grammar (get + call, no
  loops/eval); bind = enforced constraint, not object-merge. What does the source look like?
- **D6 vs D10** — the "secret jail" worker can see a raw secret; how is that not a hole
  in "the only security is the egress door"? What contains the jail?
- **Q15 — cryptographically verified human approval** (secure enclave / attestation) —
  concrete mechanism.

**Code / repos / scale:**
- **Q6 — do "other repos" need the repo abstraction** or is it "just use GitHub + octokit"?
- **Self-modification safety** — an agent rewrites its own `processEvent` into something
  that throws on every event. What stops the organism from bricking itself? Rollback story?
- **R10 export/portability** — what precisely is in the tarball, and what breaks when you
  rehydrate on a fresh Cloudflare account?

**Framing:**
- **Q13 — the PI coding agent reference** for "produces-only-code / self-modifying."
- The single crispest Paul-Graham one-liner (Q11 noun is set: "digital organism").

---

### 🔥 Stocked 2026-07-15 — Codex (gpt-5.6-sol xhigh) + prior-art research

_Full text on disk: **`codex-devils-advocate.md`** (A1–A20 questions, B1–B6 pitches all
verdict ADOPT, C1–C3 disagreements) and **`prior-art-findings.md`** (6 areas + PA1–PA8
questions, each naming a real system). Distilled below, most load-bearing first._

**★ Three convergences — where BOTH independent reviewers hit the same gap (ask these):**

1. **No protected control plane; the promotion gate is itself self-editable.**
   **[→ RESOLVED 2026-07-15 → [[D14]] the membrane (see I2); remaining opens: the name,
   the money-spent-event mechanics, and [[Q15]] human-approval attestation.]**
   Codex C3 / B3 / B5 / A5; prior-art PA7 (Darwin Gödel Machine + SICA: keep an archive of
   prior versions, sandbox-eval on a benchmark held *outside* the mutable agent, rollback).
   The organism can rewrite its own `processEvent` into something that throws on every
   event, loop at ~$108k/hr, or **edit its own spend cap / canary gate.** Direct tension
   with **[[D2]]** ("everything overridable in userspace") and **[[D1]]** ("nothing withheld
   inside the project"). → is there an *un-editable membrane* (active-code pointer, spend
   cap, activation+rollback gate) in the kernel, and exactly where does userspace stop?
   *(candidate → a new Decision, or a "constitution" / kernel control-plane concept)*
2. **ocap needs withheld ambient authority — but D1 withholds nothing and we hand root
   `itx` to LLM code.**
   **[→ NETWORK side RESOLVED 2026-07-15 → [[D15]]: physical MITM SSL egress proxy + all
   code sandboxed (see I3). Still open: the *in-process* ocap side — attenuation / who
   mints the narrowed capability / confused-deputy (A7, PA4/PA5); note D14.3 already gates
   high-risk egress via human approval.]** Codex C2 / A7 / A8; prior-art PA5 (Endo/Agoric Hardened JS:
   `harden()`, Compartments, no ambient `fetch`/`Date`), PA4 (June-2026 paper "Capability
   Gates Are Not Authorization": LangChain, LlamaIndex, Stripe Agent Toolkit *all* ship the
   confused-deputy bug; cheap models attempt unauthorized calls 3.2× more). → what
   withholds root `itx` from a script, who mints the attenuated handle, and is LLM code run
   in an SES/Compartment so it can't reach global `fetch` and route *around* `itx`? Does
   **[[D6]]** actually cover response bytes / WebSocket frames / logs / exports / secret-jail
   return, or is "one egress door" a metaphor?
3. **"One stream abstraction" is one *envelope* over several *substrates*, not one
   mechanism.** Codex C1 / B4; prior-art PA1 (Restate = journal+state in server,
   single-writer lock, stateless handlers — "architecturally identical to your
   DO-is-ordering-point"). A db needs conditional writes + indexes; a queue needs exclusive
   claim + lease + redelivery; live PCM needs bounded buffer + backpressure + deliberate
   loss. → keep **[[D7]]** as *one API/naming*, but admit distinct semantics underneath?
   (Re-opens D7's "four systems collapsed into one" wording.)

**Streams / events / concurrency:**
- **`await append()` — what does it wait for?** (A1) durable-commit only / first
  processEvent / whole causal chain (never terminates)? The `waitFor(terminalEvent)`
  pattern (B1) keeps D3 non-blocking. *[feeds Q5]*
- **Concurrency invariant on a stateless fetch** (A2): 100 concurrent buys of the last
  unit — conditional-append-on-revision vs reservation-RPC-on-DO vs accept-then-reject.
  R13 gives horizontal scale, not database invariants.
- **Broadcast stream → task queue** (A11): where's the atomic claim + lease so 8 replicas
  don't all send the invoice? Idempotency key must ride *into the external call* (PA3 —
  Temporal/Stripe; internal dedup window 24–72h expires).
- **Cross-stream saga recovery after a mid-crash** (A12): which durable event marks the
  open obligation, discoverable without scanning every account stream?
- **Replay bill** (A13): 1B events / 50k eps = 5.6h recovery. Checkpoint interval?
  May old segments ever be compacted? *[feeds Q5 / R6]*
- **Poison event** (A4): seq 900 throws forever, 901–14000 blocked. Quarantine after N
  tries? Who may skip? How does reduced state advance past it? *[feeds R6]*
- **Non-determinism in `reduce`** (PA2 — Durable Functions/Temporal replay ban
  `Date.now()`): what stops a stray clock/random call silently corrupting reduced state?

**Concurrent self-modification:**
- **Two LLM edits from the same parent commit** (A3): serialize by event seq / merge /
  reject / last-wins? Which code handles event 82 if C1 & C2 land 3ms apart?
- **Fleet update = merge across a million diverging branches** (PA8 — Cloudflare gradual
  deploys can't roll back across a KV/D1 schema change): precedence when a channel bump
  and a project's own rewrite touch the same file? The content-addressed **"system image"**
  (B6) answers Q7 + Q8 together.

**Secrets ([[Q14]]):**
- **What may leave the secret jail?** (A6, B2; PA6 — Vault Transit). Industry verdict:
  expose `hmac`/`sign`/`encrypt` *operations* (key never leaves) instead of a jail that
  sees plaintext — strictly stronger than [[D10]]'s escape hatch. SSRF: does the allowlist
  pin the *connected* host (post-DNS/redirect) or the *requested* host?

**Capabilities ([[Q9]] / [[Q4]]):**
- **The tiny grammar** (A19): productions for `itx.slack.postMessage.bind({channel})`; on a
  later call with `{channel:"C_PAYROLL"}` — reject / ignore / intersect? Stored as source
  text or canonical AST?
- **Mount-install vs code-activation race** (A15): must activation atomically bind
  `{codeDigest, capabilityTableDigest}`? Lookup cost for 200 mounts @ 10k rps?

**Trust boundary ([[D1]] / [[WA1]]):**
- **The two-person company** (A14): founder Alice + payroll *contractor* Bob + support
  Piper all get the same `itx`; Bob can read payroll, rewrite `processEvent`, use every
  secret. Refuse the deployment? Three projects over public HTTP? Rely on social trust?
  D1 rejects *ordinary delegation*, not just enterprise roles.

**Repos ([[Q6]]):**
- **A non-config repo is referenced, then GitHub deletes it** (A16): the export has commit
  C52 but can't rebuild it. Mirror referenced objects into a project-owned content store,
  or does [[R10]] explicitly exclude them? "Just use octokit" vs exportability/provenance.

**Human approval ([[Q15]]):**
- **What does the signature attest?** (A20): key-possession vs physical-presence vs
  informed-consent vs legal-identity — four different claims. Which canonical bytes, which
  *attested* UI shows them, what stops a destination-swap between approval and execution?
