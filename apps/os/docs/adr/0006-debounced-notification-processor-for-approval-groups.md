# Debounce Approval Group pushes in NotificationProcessor, don't rely on APNs threading or batch signatures

**Superseded by ADR 0007**: batching moved upstream into the egress door —
one `human-approval-requested` event per burst, one signed decided event —
which deleted this state machine entirely.

A `Promise.all` script run can hold N egress requests at once; notifying on
each one individually floods the device. We collapse them into one push per
Approval Group by giving `NotificationProcessor` a small, explicit exception
to its otherwise-stateless-per-event design: per-`executionId` reduced state
(open members, window-opens-at) and a Durable Object alarm, modeled on
`SchedulerProcessor`'s alarm-from-reduced-state pattern, that debounces a
short extendable window (3s, capped at 10s) before appending one
`notification/requested` intent summarizing the group's currently-open
members.

We considered relying on APNs `thread-id` grouping so iOS visually collapses
the pushes client-side — rejected because it doesn't reduce push _volume_,
only presentation; the user still gets N buzzes. We considered a batch
signature covering all N requests — rejected because per-request grant events
remain the unit of record on the stream (see the Approval Group term in
CONTEXT.md); the mobile client instead does one Face ID unlock to produce N
ordinary signatures (`signManyWithApproverKey`).

Consequence: `NotificationProcessor` is no longer "every intent derives from
its triggering event alone" for every event type — that invariant now holds
for everything except grouped approval requests, which get this documented
state machine instead. State is pruned once a group's members are all
resolved and its window has fired, so a long-lived project doesn't accumulate
one entry per script run forever.
