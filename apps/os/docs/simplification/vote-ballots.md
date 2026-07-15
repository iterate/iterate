# The vote — six independent judges (raw ballots)

3 Claude + 3 codex(gpt-5.6-sol xhigh). Chairs: shipper, security, DX/LLM-as-user, distributed-systems skeptic, ten-year founder, cost-at-1M. Tally + commentary rendered in index.html §7.

## Codex — distributed-systems skeptic

| ID | BUILD | SHELVE | KILL | ≤15-word reason |
|---|:---:|:---:|:---:|---|
| C1 |  |  | ✓ | Retention cannot erase divergent acknowledgement, retry, timeout, backpressure, and failure semantics. |
| C2 |  |  | ✓ | A tar cannot carry external state, credentials, leases, identity, or already-delivered consequences. |
| C3 |  | ✓ |  | Useful test only after complete egress capture, bounded snapshots, and live-canary semantics. |
| C4 |  | ✓ |  | Needs federated outboxes, deduplication, fencing, contract versioning, revocation, and dispute semantics first. |
| C5 | ✓ |  |  | Typed paths unify inspection while preserving each node’s distinct durability and backpressure contract. |
| C6 | ✓ |  |  | Journaled model outputs make stochastic steps replay-safe across crashes, retries, and eviction. |
| C7 |  |  | ✓ | Unbounded replay is expensive; counterfactuals cannot reconstruct external reads, effects, or timing. |
| D1 | ✓ |  |  | One routed verb centralizes confinement and egress policy without claiming uniform delivery semantics. |
| D2 |  |  | ✓ | The log’s ordering, fencing, wakeup, and replay guarantees must survive broken userspace. |
| D3 |  |  | ✓ | Mandates externalize correlated failures and upgrades; durable supervision belongs in operated deep modules. |
| D4 |  |  | ✓ | Race winners are nondeterministic; universal reactions amplify replay, poison, and feedback-loop failures. |
| D5 | ✓ |  |  | Evaluator-enforced constraints plus revocation centralize authority; version expression semantics and journal grants. |

1. TOP 3: D1, C6, D5
2. KILL HARDEST: D2 — The journal is the recovery boundary; userspace cannot reliably supervise its own supervisor.
3. MISSING: First-class effect obligations—durable outbox, deterministic dedupe, fencing, expiry, reconciliation, and bounded recovery.

## Codex — ten-year founder

| ID | BUILD | SHELVE | KILL | Reason |
|---|:---:|:---:|:---:|---|
| C1 |  | ✓ |  | The convergence is real, but journalizing every hot call risks latency and semantic contortions. |
| C2 | ✓ |  |  | Portable, code-stamped lives create trust, reproducibility, migration freedom, and a defensible moat. |
| C3 | ✓ |  |  | Safe self-improvement requires replay evidence before canaries; the primitives largely already exist. |
| C4 |  | ✓ |  | The endgame fits perfectly, but federation, contracts, payments, and reputation need market maturity. |
| C5 | ✓ |  |  | A typed path tree makes entities legible to humans and models without distorting storage. |
| C6 | ✓ |  |  | This is already iterate’s mind architecture; formalize its replay and compaction invariants. |
| C7 |  | ✓ |  | Past-state queries are valuable; live counterfactual forks should wait for portable deterministic replay. |
| D1 | ✓ |  |  | One routed fetch and one egress gate simplify security while enabling jailed replay. |
| D2 |  | ✓ |  | Correct abstraction test, but moving the load-bearing log now risks correctness, latency, and ecosystem fracture. |
| D3 |  |  | ✓ | Mandatory packages atomize the product, multiply trust decisions, and create fleet-wide dependency chaos. |
| D4 | ✓ |  |  | A post-commit, observable genome override is the practical mechanism for self-directed evolution. |
| D5 | ✓ |  |  | One constrained, revocable call representation unifies grants, tools, subscriptions, and durable invocation. |

1. TOP 3: D1, C2, C3.

2. KILL HARDEST: D3 — it turns a coherent intelligent entity into a supply-chain committee and permanently obstructs safe fleet evolution.

3. MISSING: C8 Sovereign continuity — entities own portable cryptographic identities; migrations preserve them, while forks become signed descendants.

## Codex — cost at 1M projects

| ID | BUILD | SHELVE | KILL | ≤15-word reason |
|---|:---:|:---:|:---:|---|
| C1 |  |  | ✓ | Making every call traverse journal machinery taxes the hottest path across the entire fleet. |
| C2 |  | ✓ |  | Portable replay is valuable, but historical runtimes and artifacts create costly indefinite retention. |
| C3 |  | ✓ |  | Mandatory replay per promotion multiplies builds and compute; prove value with selective canaries later. |
| C4 |  | ✓ |  | O(1) updates are compelling; bilateral delivery, metering, isolation, and provider failures need maturation. |
| C5 |  | ✓ |  | A projected tree improves navigation, but scalable listing, grep, and typed-node semantics remain unresolved. |
| C6 | ✓ |  |  | Journaled model outputs eliminate replay inference spend; compaction bounds context and storage growth. |
| C7 |  | ✓ |  | On-demand time travel could cut incidents, but universal snapshots and forks need strict economics. |
| D1 | ✓ |  |  | One routed fetch path centralizes policy, removes duplicate machinery, and simplifies fleet operations. |
| D2 |  |  | ✓ | Per-project stream implementations fragment correctness, upgrades, migrations, and incident response at fleet scale. |
| D3 |  |  | ✓ | Million-project package copies guarantee version fragmentation, rebuild storms, supply-chain risk, and support chaos. |
| D4 |  |  | ✓ | Every durable event pays worker invocation, delivery, cold-start, dedupe, and feedback-loop costs. |
| D5 | ✓ |  |  | One constrained evaluator replaces bespoke grant paths and makes revocation centralized and O(1). |

1. TOP 3 to build first: D1, D5, C6.
2. KILL hardest: D3 — Shipping mutable domain packages into a million projects creates an unbounded update, rebuild, security, and support tax.
3. MISSING: Shared content-addressed runtime layers with channel-following pointer manifests, so one build serves every undiverged project.

## Claude ballots
(shipper, security, DX — full tables captured in session; verdicts folded into index.html §7)
