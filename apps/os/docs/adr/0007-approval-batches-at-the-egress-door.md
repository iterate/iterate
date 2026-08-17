# Approvals are batches: coalesce at the egress door, decide with one signed event

A `Promise.all` script run can hold N egress requests at once. This PR's
first design (never landed, no separate ADR) kept per-request
`human-approval-requested`/`granted`/`rejected` events and
reassembled the burst downstream — a debounce state machine in
`NotificationProcessor` (its one exception to stateless-per-event), a
computed "Approval Group" on every approver surface, and N signed grant
events appended best-effort with no rollback when a human tapped Approve all.

We now make the batch the only shape, formed where the requests physically
are: the egress door. Requests matching a `hold` rule park in an in-memory
pending batch per (Script Execution, rule) for the rule's `debounceMs`
(default 100ms, each arrival extends, capped at 3x; `null` disables), then
commit as ONE `human-approval-requested` event whose payload carries the
ordered `requests` array. A lone request — or any hold without
script-execution provenance — is a batch of one. Batching only ever catches
CONCURRENT requests: a sequential caller's next fetch starts after the
previous one is approved, so a short window loses nothing.

One `human-approval-decided` event answers the batch: a verdict per index,
`decidedBy: "human" | "expiry"`, and at most one ECDSA P-256 signature over
the canonical approval.v2 message, which binds the batch offset, every
request subject (method, url, headers, bodySha256, secretPaths), and the
verdicts. The door honors the FIRST decided event referencing a batch.
All-reject decisions (including the door's own expiry) are never signed —
deny stays the fail-safe direction. Settlement stays per released request:
`human-approval-settled` carries the batch offset plus an `index`.

What this deletes: the debounce state machine (NotificationProcessor is
stateless-per-event again — one batch event, one push), the
`approvals-group` notification destination, client-side grouping in every
approver surface, and the mobile client's sign-N-then-append-N loop whose
mid-batch append failures could strand half a burst. The in-memory pending
batch needs no durability: if the Project DO dies pre-commit, the queued
fetch promises die with it — nothing recorded, nothing stranded.

Deliberately not backwards compatible: the granted/rejected event vocabulary
and the single-request payload shape are gone, with no legacy parsing. There
are no production users of the old events.
