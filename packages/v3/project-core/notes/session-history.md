# Clean-room session history

This is a decision record reconstructed from the user-authored portions of the Claude history for this worktree. It separates durable direction from proposals that were explored and rejected. It is deliberately not a transcript and contains no credentials or copied tool output.

## Coverage and confidence

- Inventory: 13 top-level JSONL sessions in the worktree's Claude project directory, containing 12,544 user messages in total. Eight sessions contain clean-room or v3/project-worker scope; six were read closely for the requirements below.
- Primary evidence: `a70981f6-df19-4448-9d75-6cc615980ff1` (2026-07-28–2026-09-02), `18bac060-edf7-4cfa-95fc-89902c78d0be` (2026-08-19–2026-09-01), `1de5e3fb-9e50-44aa-99a4-ef6ea8ff2f31` (2026-09-01–04), `eed333f2-1be1-4387-aa4c-4725fbc203dd` (2026-09-01), and `915ddd3a-765a-497b-866c-2f7e52ac434b` / `02851f02-ee95-4a6c-b455-53683c57e070` (2026-09-04).
- Secondary evidence: `d0650284-162e-4d90-bbba-28d4007014a3`, `8d4ff551-6bbf-4ce0-af10-29b6efbcb9a5`, and `e9ef03f2-fe9c-46ad-ae3a-cee0e484ab19`. The last establishes precedent for a separate, small, plain-JS exploratory copy plus an append-only decision record.
- The current clean-room surface and tutorial proof are useful corroboration, but the user messages are the authority for intent. See `packages/v3/project-worker/docs/itx-surface-as-built.md` and `tutorial-proof/`.

## The product boundary

The desired system is a small, self-hostable project core and an optional hosted control plane, not a mandatory hosted OS. A self-hosted project should run unprotected on a small Cloudflare/Miniflare deployment if its owner chooses to put Cloudflare Access or another perimeter in front of it. Iterate-hosted mode adds services Iterate can uniquely operate: billing/credit, shared ingress domains, and approved third-party OAuth clients. The same project-facing core and user-space configuration should work in both forms. (a709…: 2026-07-28 08:53, 12:33.)

An integration is not a privileged product category. Its observable outcome is events arriving on a stream, secrets becoming available, ingress handlers, and UI contributions. First-party Slack/Gmail/GitHub code, agents, renderers, and even the dashboard should be replaceable user-space modules where practical. The early conclusion to retain a kernel-level “integration” concept was explicitly provisional. (a709…: 08:53–13:19.)

Each project is a distinct information and authority boundary. If information needs separating, use separate projects. Money and credentials are real constraints; a project can receive authority/funds and delegate bounded budgets down its path tree, but spending stops when authority is exhausted. This is design direction, not a request to prematurely model payment mechanics. (a709…: 09:42–09:49.)

## Minimal kernel and package cuts

Start from the self-deployed core and layer outward. The target is a working, human-owned skeleton with the same public types, APIs, and module boundaries as the larger production implementation, initially around one to two thousand lines plus runnable tests. It is the place to test API shapes and narrate the system; production can be larger. Backwards compatibility is not a constraint for this clean-room simplification. (a709…: 2026-07-28 14:20; 1de5… continuation: 2026-09-01 23:12; a709…: 2026-09-02 11:20–11:43.)

The core's durable primitives are:

1. A capnweb context capable of bidirectional calls and of lending live capabilities.
2. One fetch door, which accounts for both outbound egress and inbound/tunnel-shaped fetch.
3. An append-only stream and stream processors.

Authentication, live state, richer secrets, repositories, dashboards, agents, integrations, and application UI build on those primitives. Executing loaded code is an important additional mechanism to introduce when the tutorial needs it; it should not obscure the first three. (a709…: 2026-09-01 07:13–09:01.)

Use one package per deployable worker. Shared packages are for code that two worker packages would otherwise duplicate and whose disagreement would be a defect. The project worker is the capability host; the control plane/directory chooses project identity and hostname routes. Do not let a sleeping context own mutable hostname-directory state. (d065…: 2026-08-07; eed…: 2026-09-01 identifier decision.)

## State, paths, and capabilities

The context is a dotted capnweb surface over one context Durable Object per `{projectId, path}`. The edge is a thin proxy; the DO owns append, reduction, delivery, and durable state. The edge only owns session-bound acts such as lending a live client capability, then expresses durable configuration as appended events. A capability/stub is physical; a rewrite/mount is pure stored data. Do not conflate them. (1de5…: 2026-09-01 19:28–23:12; 915…: 2026-09-04 11:21–12:03.)

The central simplification is “one event shape”: provision/mount, subscription, and processor configuration should reuse ordinary events and ordinary rewrite/mount data rather than grow specialist event families. A live `provide` is a physical lend plus an ordinary durable mapping; its session end undoes the lending. Processors are subscriptions whose target is a loaded durable facet. The inline core reducer is the only core processor. (1de5…: 2026-09-01 20:11–23:12.)

Paths name project-local contexts and capabilities, never platform directory state. App host labels become project-local app names; custom or wildcard hostname resolution happens in the control plane before the root context wakes. For an app, exposing it is providing its fetch-shaped capability. External callers never choose arbitrary capability paths through a public `/cap` escape hatch. (eed…: 2026-09-01 fetch/ingress design.)

There are levels of built-ins. Axioms are the small unavoidable physical doors; bindings are environment capabilities such as AI; library conveniences can be represented in user space. Built-ins need a physical, inspectable namespace that user-space rules can shadow at the short spelling without altering what the platform itself calls. `append` remains named `append`; the reading surface was corrected to `readEvents`. (915…: 2026-09-04 11:21–12:03, 19:52–19:56.)

## Fetch, secrets, approvals, and signed external input

There is one fetch model, not ingress versus egress subsystems. A request entering a provided/tunnel capability and a request leaving the project both travel through a real fetch hop and the same rule mechanism. The public hostname selects the initial application capability; all other request matching is data-driven user-space policy. The rejected alternatives were URL-encoded capability paths, a special `fetch-rule-*` event family, and a separate `itx.egress` root. The current direction is one `itx.fetch` door that distinguishes internal/project hosts from external destinations as needed. (eed…: 2026-09-01 21:11–21:20.)

Secrets enter egress at the terminal authority boundary. Policy code receives placeholders and may allow, deny, rewrite, inject, or hold a request; it does not receive the underlying secret merely to make a decision. Approval/HITL, secret substitution, egress allow/deny rules, logging, mocks, and live shadows are instances of this fetch-door pattern. A synchronous approval gate is user-space code/facet policy, not a new core event or kernel gate. (a709…: 2026-07-28 10:31; eed…: fetch-rules cuts 1, 3, 5.)

External webhooks and other trusted ingress must be represented as verifiable, signed input: authenticate at the boundary, retain a durable explanation of what was accepted or refused, and append the resulting project event. The core should provide the fetch/capability and event primitives; provider-specific signature verification and payload conversion belong in connector/user-space code. This aligns with the requirement that normal failure is bounded and classified rather than silently swallowed. (a709…: hosted integrations framing; 02851…: 2026-09-04 memory/error requirements.)

## Config, repositories, and connectors

The config worker is a user-space composition root expressed as `fetch` and `processEvent` functions. It should import the core in a way that yields a type error when an incompatible core API changes; a project's agent/config can then repair its own wiring. A project should visibly declare the first-party packages it was born with, including agent wiring, rather than hide them in the kernel. (a709…: 2026-07-28 08:53–11:15.)

Repositories are ordinary user-space/project data and capabilities, not a core primitive. A provider can turn repository activity into signed ingress events and use repository credentials through the one fetch/secret door. This keeps a self-hosted project viable while a hosted mode can supply optional shared OAuth clients and managed resources. (a709…: 08:53, 12:33.)

The requested library-shaped connector names are `itx.connectToMcp`, `itx.connectToOpenApi`, and `itx.connectToCapnweb`. They are convenience/library tier, distinct from axiomatic doors. App configuration should be typed and parsed into an explicit data structure. (915…: 2026-09-04 19:52–19:56.)

## Tutorial and proof discipline

The tutorial is one runnable project whose stages are commits, not one directory per stage. Its markdown narration is appended with each corresponding commit; it begins in one file and later refactors into a production-mirroring module structure as complexity earns it. Every snippet must run as written in a gitignored proof area. (a709…: 2026-09-01 06:55–07:27, 19:46; 2026-09-02 11:20–11:47.)

Teach capnweb first through what makes it unusual: serializable callbacks/`Request`/`Response`, bidirectional calls, and a held live capability. Then introduce the context/capability surface, one fetch in both directions including secret substitution/tunnelling, and streams/processors. Authentication is motivated by fetch and ingress, rather than being an unexplained prologue. The concrete correction is that `authenticate(...)` returns the RPC stub directly; do not invent a following `.get()`. (a709…: 2026-09-01 06:31–09:01.)

Proofs must exercise the real platform semantics and be allowed to falsify the tutorial. The memory work makes the operational part explicit: retain bounded memory; make large append/read failure deterministic and coded; test both payload size and concurrent delivery; never treat repeated unexplained failures as acceptable background noise. (02851…: 2026-09-04 10:52; `tutorial-proof/` corroborates the runnable-proof convention.)

## Practical implications for this parallel core

This folder should be a clean, independently runnable exploration rather than a partial port. Preserve the above public vocabulary where it is settled, make forks explicit when the architecture is genuinely undecided, and record the reason a branch was rejected. Begin with the smallest runnable capnweb context, physical capability lending, one event log/reducer, and one fetch door. Add config, connectors, signed ingress, repository integration, and approval policy as composition modules so they can be present in hosted deployments without becoming core prerequisites.
