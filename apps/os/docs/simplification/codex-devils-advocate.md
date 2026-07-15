# Codex (gpt-5.6-sol, xhigh) — devil's-advocate pass · 2026-07-15

> Sourced during the interview to stock questions. A1–A20 = questions, B1–B6 = pitches
> (all verdict ADOPT), C1–C3 = strongest disagreements. Distilled into INTERVIEW.md backlog.

## A. Twenty sharp interview questions

### A1. What exactly does `await append()` wait for?

```ts
await itx.stream("/orders").append({
  type: "payment-requested",
  id: "pay_42",
});
return new Response("accepted");
```

Trace the contract: `payment-requested` commits as sequence 410; `processEvent(410)` appends `payment-started` as 411; `processEvent(411)` calls Stripe for 45 seconds. Does `await append()` mean “410 is durable,” “the first `processEvent` returned,” or “the entire causal chain settled”? The third option never terminates for a live organism; choose one of the first two and state who observes failures.

*Why this matters:* D3 cannot remain non-blocking while “wait for `processEvent`” remains undefined.

### A2. Where is the concurrency-control point for stateless `fetch`?

```ts
export async function fetch(_request: Request, itx: Itx) {
  const inventory = await itx.stream("/inventory/sku-7").reduced();

  if (inventory.available === 0) return new Response("sold out", { status: 409 });

  await itx.stream("/inventory/sku-7").append({
    type: "item-reserved",
    orderId: crypto.randomUUID(),
  });

  return new Response("reserved");
}
```

Send 100 requests concurrently when `available === 1`; all 100 stateless workers can read one and return 200. Is the solution a conditional append against a stream revision, a reservation RPC on the stream DO, or acceptance followed by 99 asynchronous rejections? Specify the client-visible result.

*Why this matters:* R13’s horizontal scaling does not provide database invariants.

### A3. What orders concurrent LLM-driven code changes?

```ts
const [fraudFix, pricingFix] = await Promise.all([
  llm.editRepo({ parent: "C0", event: event80 }),
  llm.editRepo({ parent: "C0", event: event81 }),
]);
// Produces incompatible commits C1 and C2.
```

R12 requires both requests in flight, but both edit the active config from parent `C0`. Does the platform serialize activation by event sequence, merge the commits with another LLM, reject the second commit, or allow nondeterministic “last completion wins”? State which code handles event 82 if C1 and C2 finish three milliseconds apart.

*Why this matters:* Concurrent inference is easy; deterministic self-modification is the unsolved part.

### A4. What happens to a poison event?

```ts
export async function processEvent(event: Event, itx: Itx) {
  if (event.type === "github/push") {
    // Old events lack repository.fullName.
    await routePush(event.repository.fullName);
  }
}
```

After a deployment, sequence 900 throws on every retry while sequences 901–14,000 are waiting. After exactly how many attempts or minutes is 900 quarantined, who may skip it, and how does reduced state advance past a fact the configured reducer cannot consume?

*Why this matters:* “Retry forever” turns one schema mistake into permanent project-wide paralysis.

### A5. Who stops an infinite self-improvement loop?

```ts
case "config/activated":
  await requestAgent("Review the new config and improve it");
  break;

// The agent commits, causing another config/activated.
```

At ten iterations per second and $3 per model call, this burns $108,000 per hour while continuously rewriting production. Name the exact kernel-enforced circuit breaker: causal-depth limit, dollars per root event, activations per hour, or something else. Also name who can raise that limit without letting the looping code raise its own limit.

*Why this matters:* A userspace safety mechanism disappears precisely when userspace breaks.

### A6. What information may leave the “secret jail”?

```ts
const result = await itx.secretJail.run("stripe-key", ({ secret }) => {
  return new TextEncoder().encode(secret);
});
```

Blocking network access inside the jail is irrelevant if arbitrary result bytes return to config code. Is the jail allowed to return only an HTTP response from a fixed host, only outputs of enumerated cryptographic operations, or arbitrary values filtered by an impossible secret-taint checker? Define the output type, not the isolation technology.

*Why this matters:* Raw-secret access plus caller-visible output is an exfiltration API.

### A7. Who receives attenuated capabilities if every handler receives root `itx`?

```ts
const supportOnly = itx.slack.postMessage.bind({
  channel: "C_SUPPORT",
});

await runUntrustedAgentCode({ itx, supportOnly });
```

The agent ignores `supportOnly` and calls `itx.slack.postMessage({ channel: "C_PAYROLL" })`. Which execution boundary withholds root `itx`, and who mints the narrower object, given D1 says everything inside a project sees the same things? If no such boundary exists, remove attenuation from the security story.

*Why this matters:* Object-capability security requires absence of ambient authority, not merely capability-shaped APIs.

### A8. Enumerate every egress door, including the incoming request’s response.

```ts
export async function fetch(_request: Request, itx: Itx) {
  const bytes = await itx.secretJail.run("payroll-key", signOrReveal);
  return new Response(bytes);
}
```

Those bytes leave through the response without calling external `itx.fetch`. Repeat the analysis for WebSocket frames, logs, exception text, uploaded blobs, project exports, DNS, email adapters, and third-party processors. Are all of these kernel-routed through one byte-level policy point, or is “one egress door” only a metaphor?

*Why this matters:* A security boundary that omits one output channel is not a boundary.

### A9. What does “exactly what happened and why” mean after PCM expires?

A ten-minute call at 48 kHz, 16-bit mono produces 57.6 MB of PCM. Give it a 30-second TTL; one hour later the durable transcript says “wire fifty thousand dollars,” while the caller disputes saying it. Can R5 reconstruct the model input that caused the transfer, or does “traceable” mean only that the now-unverifiable transcript event existed?

*Why this matters:* D11 deletes the evidence needed to substantiate R5’s strongest claim.

### A10. What is the overload policy for live audio?

At 20 ms per PCM event, one call emits 50 events per second; 10,000 calls emit 500,000 events and roughly 960 MB of raw audio per second. A transcription subscriber pauses for two seconds: does the stream buffer 100 chunks per call, drop oldest, drop newest, slow the publisher, or disconnect the subscriber? Pick one and state how the resulting gap becomes durably traceable.

*Why this matters:* Live media requires loss and backpressure semantics that append-only durable logs do not have.

### A11. How does a broadcast stream become a task queue?

```ts
await itx.stream("/invoices").append({
  type: "invoice-send-requested",
  invoiceId: "inv_7",
});
```

Eight processor replicas receive this event, but queue semantics require one active claimant, a 30-second lease, and takeover after death. Where is the atomic claim operation, and what prevents all eight replicas from emailing the invoice before any completion event lands? If the answer is idempotency, identify the external idempotency key and what happens when the provider lacks one.

*Why this matters:* Database logs, broadcasts, and competing-consumer queues have incompatible delivery semantics.

### A12. How is a cross-stream invariant recovered after a mid-saga crash?

```ts
await itx.stream("/accounts/alice").append({
  type: "debit-completed",
  transferId: "tx_9",
  cents: 100_00,
});

// Process dies here.

await itx.stream("/accounts/bob").append({
  type: "credit-requested",
  transferId: "tx_9",
  cents: 100_00,
});
```

D3 requires cross-posting rather than a multi-stream transaction. Which durable event proves the missing second append remains an open obligation, and which processor can discover it without scanning every account stream? State whether money is temporarily destroyed, duplicated, or unavailable.

*Why this matters:* “Cross-post everything” pushes transaction recovery into an unspecified global indexing problem.

### A13. What is the maximum permitted replay bill?

A project has one billion durable events. Its reduced state is evicted, and replay runs at 50,000 events per second: recovery takes 5.6 hours; if 1% of one million projects suffer this daily, 10,000 such replays begin each day. Define the checkpoint interval, integrity mechanism, recovery-time objective, and whether old segments may ever be compacted.

*Why this matters:* Event-sourcing purity without bounded replay is an unpriced operational liability.

### A14. Is this multi-human project explicitly unsupported?

Acme creates one project. Founder Alice, payroll contractor Bob, and support agent Piper all receive the same `itx`; Bob can read payroll streams, rewrite `processEvent`, and use every host-bound secret. Does iterate refuse this deployment, require three separate projects communicating over public HTTP, or silently rely on social trust?

*Why this matters:* D1 is not merely rejecting enterprise roles; it rejects ordinary delegation inside a two-person company.

### A15. Is capability installation transactional with code activation?

```ts
// Commit C18 becomes active and immediately handles traffic.
await itx.crm.createLead({ email: "ada@example.com" });

// The crm mount-installing processor is still reacting to repo-push.
```

A request arrives after C18 activates but before the asynchronous hook installs `crm`; meanwhile `__describe()` still reports capability-table version 17. Must every activation atomically bind `{codeDigest, capabilityTableDigest}`, or can newly active code observe a partially installed world? Give the target lookup overhead for 200 mounts at 10,000 requests per second.

*Why this matters:* Q4’s hook model creates an activation race before it creates a performance problem.

### A16. Are non-config repos durable organism state or disposable external dependencies?

Config commit `C52` references private GitHub commit `acme/payments@abc123`; GitHub later deletes the repository and revokes its token. A project export now contains C52 but cannot rebuild or explain the code change. Does iterate mirror every referenced object into a project-owned content-addressed store, or does R10 explicitly exclude these repos from “full durable state”?

*Why this matters:* “Just use Octokit” conflicts with exportability, replay, and long-term provenance.

### A17. Draw the kernel line around this module and name the layer above it.

```ts
import { slack } from "@iterate/???";

export default defineProject({
  mounts: [slack({ retry: "exponential", maxAttempts: 8 })],
});
```

The module handles OAuth refresh, retries, event normalization, and capability description; projects may override its routing. Fill in `???`, then state which parts can be overridden and how a critical OAuth bug reaches one million projects without replacing their custom logic. “Userspace” is a location, not a product or compatibility boundary.

*Why this matters:* Q7 cannot be solved by naming until the upgrade and override contract is explicit.

### A18. What happens during an emergency update across one million projects?

At 00:00, version `2026.7.16` closes an egress-policy bypass. Of one million projects, 700,000 follow `stable`, 250,000 are pinned to old versions, and 50,000 modified the affected module. Which layer updates forcibly, which projects can refuse, how is rollout canaried, and which version executes when replaying an event originally processed under `2026.7.15`?

*Why this matters:* Update channels solve distribution, not security authority or historical determinism.

### A19. Specify the tiny grammar by parsing this expression.

```ts
'itx.slack.postMessage.bind({ channel: "C123" })'
```

List the permitted grammar productions needed for property access, calls, object literals, strings, and binding. Then define what happens when later code calls the bound capability with `{ channel: "C_PAYROLL" }`: reject, ignore, or intersect constraints? Decide whether the stored representation is source text or a canonical AST, because “looks like TypeScript” does not require executing TypeScript.

*Why this matters:* Q9 is either a small capability language or an `eval` vulnerability wearing TypeScript syntax.

### A20. What, precisely, does a human approval signature attest?

```ts
const approval = {
  projectId: "prj_acme",
  action: "wire-transfer",
  amountCents: 5_000_000,
  destination: "GB29NWBK60161331926819",
  configCommit: "C52",
  expiresAt: 1784073660,
  nonce: "n_91",
};
```

A WebAuthn signature proves possession of a key, not that a human read or understood these fields. Which canonical bytes are signed, which trusted UI displays them, how is that UI attested, and what prevents code from substituting a new destination between approval and execution? State whether Q15 proves key possession, physical presence, informed consent, or legal identity—these are different claims.

*Why this matters:* “Cryptographically verified human” is meaningless until the verified proposition is named.

## B. Six provocative pitches

### B1. Replace “wait for `processEvent`” with explicit domain completion events

```ts
const requestId = crypto.randomUUID();

await itx.stream("/orders").append({
  type: "order-submitted",
  requestId,
  cart,
});

const outcome = await itx.stream("/orders").waitFor(
  event =>
    event.type === "order-decided" &&
    event.requestId === requestId,
  { timeoutMs: 10_000 },
);

return Response.json(outcome);
```

`append()` acknowledges durability only. Code that needs a synchronous outcome waits for one named terminal event; it never waits for an undefined processor or causal closure.

**PROS**

- Preserves D3: processing never blocks the log.
- Makes timeout and failure semantics domain-specific and observable.
- Allows many processors and LLM calls to run concurrently.

**CONS**

- Every synchronous workflow needs a correlation ID and terminal-event convention.
- Long waits consume request concurrency and still need polling or callback fallbacks.
- A buggy workflow can omit its terminal event forever.

**VERDICT: ADOPT** — causal closure is unknowable; explicit outcomes are the only waitable fact.

### B2. Delete the generic secret jail; provide declassification capabilities

```ts
const stripe = itx.secrets.use("stripe");

const signature = await stripe.hmacSha256(canonicalBody);

const response = await itx.fetch("https://api.stripe.com/v1/refunds", {
  method: "POST",
  headers: {
    Authorization: stripe.asBearer(),
    "Idempotency-Key": refundId,
    "X-Signature": signature,
  },
  body: canonicalBody,
});
```

A secret handle exposes fixed transformations and host-bound request injection, never a callback receiving raw bytes. Exotic protocols use audited adapters whose only output is a constrained request or a typed result.

**PROS**

- Gives the security model a finite, reviewable declassification surface.
- Prevents “return the secret from the jail” by construction.
- Supports common bearer, HMAC, OAuth, and signing cases directly.

**CONS**

- Every novel authentication scheme requires a new primitive or adapter.
- Signing oracles still need rate, payload-size, and destination constraints.
- Audited adapters become privileged platform code.

**VERDICT: ADOPT** — generic raw-secret execution makes R2 false; constrained declassification is the actual primitive.

### B3. Make code activation a protected release protocol, not “latest commit wins”

```ts
await itx.stream("/system/releases").append({
  type: "release-proposed",
  commit: "C52",
  parentActiveCommit: "C49",
  smokeSuite: "project-smoke-v3",
  maxErrorRate: 0.01,
  canaryRequests: 100,
});
```

Agents may commit freely, but a release controller activates a content-addressed build only after tests and a small traffic canary. The last-known-good build remains runnable outside the code currently under test.

**PROS**

- A broken `processEvent` cannot destroy the mechanism that rolls it back.
- Every event can record the exact config digest that processed it.
- Concurrent LLM edits resolve through an explicit activation sequence.

**CONS**

- Adds a protected control plane to the supposedly tiny kernel.
- Slows instantaneous self-modification.
- Tests and canaries can miss semantic corruption.

**VERDICT: ADOPT** — self-editing production code without independent activation and rollback is self-bricking by design.

### B4. Keep one event envelope, but admit two physical substrates

```ts
await itx.live("/calls/42/audio").publish(pcmFrame, {
  overflow: "drop-oldest",
  subscriberBufferMs: 500,
});

await itx.stream("/calls/42").append({
  type: "transcript-finalized",
  mediaDigest: rollingDigest,
  text,
  gaps: [{ fromMs: 18_420, toMs: 18_780 }],
});
```

Durable facts use ordered persistent streams. PCM and token chunks use a lossy pub/sub transport with explicit backpressure; durable summary events record digests, gaps, timing, and decisions.

**PROS**

- Gives real-time media honest drop and latency semantics.
- Avoids paying durable-log costs for nearly one gigabyte per second of PCM.
- Preserves a homogeneous event-shaped API where that is useful.

**CONS**

- D7 stops being literally true.
- Replay cannot reproduce missing media.
- Processors must understand two delivery contracts.

**VERDICT: ADOPT** — one conceptual interface is valuable; one physical mechanism for databases and PCM is cargo culting.

### B5. Add a signed project constitution outside the self-editable config repo

```ts
const constitution = {
  monthlySpendUsd: 500,
  maxModelCallsPerRootEvent: 12,
  allowedEgressHosts: ["api.stripe.com", "slack.com"],
  activation: {
    requireSmokeSuite: "project-smoke-v3",
    rollbackErrorRate: 0.02,
  },
  changes: {
    signaturesRequired: 2,
    delayHours: 24,
  },
};
```

This is boundary policy, not business logic. Config code can request changes, but cannot immediately enlarge its own budget, egress set, or activation authority.

**PROS**

- Stops infinite loops and prompt injections from disabling their own guardrails.
- Gives operators a recoverable boundary when all project code is broken.
- Keeps ordinary userspace behavior fully overridable.

**CONS**

- Introduces authority that the AI does not automatically share, contradicting D1’s rhetoric.
- Requires key recovery, approval, and emergency-change procedures.
- A rigid constitution can block legitimate autonomous action.

**VERDICT: ADOPT** — a self-modifying organism needs a membrane it cannot rewrite in the same transaction as its behavior.

### B6. Ship the non-kernel layer as a content-addressed “system image”

```ts
export default defineProject({
  system: "iterate:stable@sha256:7d8c…",
  mounts: {
    slack: "iterate/slack@sha256:a941…",
    github: "iterate/github@sha256:11be…",
  },
  handlers: { fetch, processEvent },
});
```

Channels resolve to immutable digests; each execution records the resolved system image. Built-in capability mounts are compiled into that image, cached globally, and overridden explicitly by project code.

**PROS**

- Gives Q7 a concrete layer and Q8 a million-project update mechanism.
- Makes code, built-ins, and `__describe()` one versioned compatibility unit.
- Historical replay can resolve the exact image originally used.

**CONS**

- Pins create long-lived version fragmentation.
- Cold images increase startup and cache pressure.
- Forced kernel fixes and optional system-image updates need separate policies.

**VERDICT: ADOPT** — call the layer the system image; versioned immutable composition is the missing line between kernel and project DNA.

## C. Three things the design is probably getting wrong

### C1. “One stream abstraction does everything” is false at the semantic level

A database needs conditional writes and indexed queries; a queue needs exclusive claims, leases, and redelivery; a workflow needs timers, cancellation, and durable obligations; live PCM needs bounded buffers, backpressure, and deliberate loss. Giving all four an `append()` method does not unify them—it hides the incompatible behavior until production. Keep one event envelope and naming model, but build distinct durable-log, work-queue, and live-media semantics underneath it.

### C2. The security story confuses host confinement with safe authority

An allowlisted Stripe host does not stop compromised code from issuing a valid $5 million refund, and blocking outbound `fetch` does not cover HTTP responses, logs, exports, WebSockets, or secret-jail return values. D13 also collapses if every script receives ambient root `itx`; object-capability security works by withholding authority, while D1 insists nothing inside the project is withheld. The design currently protects project isolation better than it protects a project from its own untrusted inputs and self-authored code—and the latter is the advertised operating mode.

### C3. Event sourcing does not make uncontrolled self-modification recoverable

The log can prove that the organism installed broken code, spent $108,000, deleted useful state, and then entered a poison-event loop; it does not keep the organism available or capable of repairing itself. The active-code pointer, last-known-good runtime, spend limits, poison-event quarantine, and rollback mechanism must live outside the code being modified. Until that protected release plane exists, “self-improving digital organism” is indistinguishable from “production service continuously deploying unreviewed stochastic patches.”
