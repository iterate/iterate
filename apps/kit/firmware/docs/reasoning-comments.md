# Reasoning comments in firmware

Embedded realtime code hides important decisions behind very small amounts of
C. A branch that drops a frame, an atomic with relaxed ordering, or a queue
depth of eight may each encode a product requirement that cannot be recovered
from the syntax. Comments are therefore part of the design and review surface,
not optional prose.

The goal is high *reasoning density*, not a comment on every line.

## What a useful comment answers

For every non-obvious module, API, state machine, ownership boundary, resource
budget, and recovery policy, record the relevant subset of:

1. What user-visible or realtime requirement forced this design?
2. What is the correct mental model?
3. Which invariant must remain true across calls, tasks, reconnects, or time?
4. Which tempting alternative was rejected, and why?
5. What does a return value, counter, timestamp, or unit actually prove?
6. What happens at saturation, wraparound, overflow, timeout, or partial I/O?
7. Which task owns mutable state? Which fields may be observed concurrently?
8. What memory, stack, latency, or CPU budget constrains the implementation?

Prefer a module-level design comment plus focused comments at the few places
where an invariant is established or deliberately broken. Do not force readers
to reconstruct the design by collecting one-line fragments.

## Required levels

### Module and public API

Describe the problem boundary and explicitly state what the abstraction does
*not* guarantee. For example, local socket acceptance is not peer receipt, and
a WebSocket pong proves ordered parsing by the peer—not receipt by an upstream
voice provider.

Document ownership, allocation behavior, blocking behavior, timestamp units,
and lifecycle. If the API is safe only from one task, say so. If metrics are
read from another task, explain why their memory ordering is sufficient.

### State and policy

Explain the state-machine invariant near the state itself. A reviewer should be
able to answer questions such as:

- Which audio frames does an outstanding barrier cover?
- Why may frames after that barrier remain unconfirmed?
- Why does timeout replace the connection instead of retrying forever?
- Why does overflow discard stale speech rather than preserve FIFO history?

Every tuning constant must explain the tradeoff it controls and the failure
mode at either extreme. State units in names or comments.

### Concurrency and bounded resources

For rings, tasks, atomics, static workspaces, and fixed arrays, record:

- producer and consumer ownership;
- whether an operation can block or allocate;
- why the chosen memory ordering is enough;
- full/empty/drop policy and how loss becomes observable;
- the capacity or size budget and why it is acceptable.

Do not describe an opaque ESP-IDF, TLS, lwIP, or Wi-Fi buffer as exactly
measured when it is not. Classify telemetry as exact observation, conservative
derived bound, configured capacity, or unavailable.

### Tests

Put a short scenario comment immediately above each substantive test. It should
connect the synthetic setup to a real incident:

```c
/*
 * lwIP can accept several PCM frames while the radio makes no forward
 * progress. A naïve sender sees an empty application ring and calls itself
 * healthy. This scenario withholds the pong to prove that the peer-confirmed
 * window stops new audio and forces a fresh connection before old speech can
 * escape after recovery.
 */
static void stalled_peer_cannot_turn_backlog_into_delayed_speech(void) {
```

Also explain unusual assertions and fixed-size gates. A test name alone is not
enough when the relevance depends on networking, scheduling, or hardware
behavior.

## Comments to reject

These add noise without preserving reasoning:

```c
/* Increment retries. */
++retries;

/* Check whether the queue is full. */
if (depth == capacity) {
```

Replace them with the constraint:

```c
/*
 * Diagnostics run unattended and counters are part of the postmortem. Wrap to
 * zero would make a worsening fault look recovered, so retain UINT32_MAX as an
 * explicit “at least this many” value.
 */
atomic_saturating_increment(&retries);
```

Do not use comments to excuse unexplained behavior, indefinite retries, silent
loss, or unbounded work. Model and test those outcomes instead.

## Review checklist

- Can a new engineer explain the design without archaeology in issue history?
- Are guarantees and non-guarantees precise?
- Are ownership, blocking, allocation, time, and memory semantics explicit?
- Does each recovery path explain why data is retained, dropped, or abandoned?
- Does each test say which realistic bug it prevents?
- Would the comments still be true under reconnect, wraparound, prolonged
  backpressure, memory pressure, and a wedged diagnostics sink?

