# Stream acknowledgement lease — 5 September 2026

Local public-network proof: a reader cannot keep one of the context's 64 live
subscription slots indefinitely by withholding its page acknowledgement.
This is not deployed hostile-load or native-memory acceptance.

## Public contract

The server sends one page and waits for exactly its `throughOffset`:

```ts
socket.send(JSON.stringify({ afterOffset: page.throughOffset }));
```

A sent page has a 20-second acknowledgement deadline. A timely ACK releases
the page and may immediately send the next one. A late ACK cannot renew the
lease. An idle reader with no outstanding page owes no ACK and is not expired.
Expiry initiates close code `1008`, reason
`Stream acknowledgement deadline exceeded`. Reconnect using the last processed
offset; receiving a page is not the same as processing it.

The attachment has one source of truth, rather than separate `awaiting` and
deadline flags:

```ts
type SocketProgress = {
  kind: "stream";
  afterOffset: number;
  throughOffset: number;
  deadline: number | null; // null means no outstanding page
};
```

The attachment is serialized before sending. The Durable Object alarm takes
the earliest of the stream, processor, and lending deadlines. Subscribe and
ACK handlers await arming; append/publish already schedules the shared alarm.
The existing processor-run finalizer remains the only owner of processor
retry re-arming. Expiry runs before processor work in `alarm()`.

Admission also expires overdue readers and counts only `OPEN` sockets. A
closing transport cannot keep a live subscription slot. Cloudflare explicitly
documents that `getWebSockets()` can still contain `CLOSING` sockets after
`close()`; array length alone is not a live-reader count.
[Durable Object state contract](https://developers.cloudflare.com/durable-objects/api/state/#getwebsockets).

## Red, diagnosis, and revised observation

The first public test filled all 64 slots, ACKed one healthy reader, and
withheld the other 63 ACKs. Before the fix, waiting for those closes failed
after 25.106 seconds. The first implementation also failed that terminal-close
assertion after 25.219 seconds; those are not hidden as passing retries.

A single-reader probe distinguished close initiation from transport completion.
Targeted logs recorded deadline `1788567477962`, alarm time `1788567477966`,
and the outstanding attachment found by the alarm. Node's **client** WebSocket
was `CLOSING` by 25 seconds, proving the close frame reached it. The terminal
close event arrived at about 30 seconds with the correct code and reason.
A later idle probe against the final deadline state also closed at 30.047s.

The inspected workerd checkout is
`c4e03fa1d2a3f2607e2b79567076d5fdd5179d03` (3 September). Its legacy adapter
retains native ownership in `attachedForClose` after hibernatable release,
and the local actor container tears down idle actors after ten seconds:

- `src/workerd/api/web-socket.c++`: `initiateHibernatableRelease`,
  `Accepted::WrappedWebSocket::initiateHibernatableRelease`, `tryReleaseNative`.
- `src/workerd/server/server.c++`: `ActorContainer::handleShutdown`.

This is a source-backed explanation consistent with the observed tail, not a
proven exact-version upstream fix. The running binary is **workerd
1.20260828.1**, from Wrangler **4.127.1** / Miniflare **5.20260828.0-alpha**.
An attempted inspector GC command returned no response and is inconclusive.
Explicit `webSocketClose` completion handles client-initiated closes; it did
not eliminate the isolated server-initiated tail. No sleep or close retry was
added to the platform to mask it. All temporary diagnostic logs were removed.

The regression therefore tests both observable boundaries separately:

1. All 63 stalled clients leave `OPEN` within 25 seconds, retaining the hard
   assertion that the 20-second lease actually initiates a close.
2. The healthy reader stays open after ACKing offsets 1 and 2.
3. Before waiting for terminal transport close, 63 replacements can connect
   and replay exactly the second event from offset 1, then ACK offset 2.
4. Every stalled connection eventually closes with the exact policy code and
   reason, with a separate 35-second terminal-close bound.

Thus increasing the terminal wait does not allow a late lease or delayed slot
reuse to pass. Test timeout is 40 seconds; ordinary request timeouts remain
30 seconds. A focused run passed in 20.223 seconds; the fresh combined run's
lifecycle case passed in 30.212 seconds. This variation is retained evidence,
not a claim that all transports now finish closing at 20 seconds.

## Fresh combined proof

Use the synthetic fixture command in [local verification](local-verification.md),
then run:

```sh
WORKER_BASE_URL=http://localhost:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  pnpm --dir packages/v3/project-core test
```

Result: **33 passed, zero failed/cancelled/skipped**, **30.739 seconds**.
Alongside it, three additional runs of the four-project retry/halt case passed
in 3.184s, 3.247s, and 3.227s. Each project reached three attempts, retained its
terminal failure explanation, and produced exactly one idempotent derived event.
Fixture state: `/tmp/project-core-ack-final-Z7ixM9`.

Fresh debug log `wrangler-2026-09-05_00-23-49_073.log` contains 54 deliberate
fixture exceptions: 48 `deliberate failure`, three `broken`, and three
`fixture mounted rejection`. The 51 processor failures have matching classified
delivery records. Two peer-disconnect diagnostics are the existing deliberate
lending/disposal closures. There are **zero extra hung/async cancellations,
zero NOSENTRY alarm mismatches, and zero ACK debug logs**.

Type checking, scoped lint (20 files, 73 rules), and formatting pass. The
counter is **4,998 raw authored lines**, including tests/UI/config/scripts.
Shared HTTP assertions and public event-page types removed duplication; no
test case or runtime feature moved outside the counter.

## Remaining limits

No claim of an upper native-memory bound under sustained reconnect churn:
the transport tail still requires deployed measurement and, if reproduced,
runtime remediation. Twenty seconds is a deadline, not a realtime scheduling
guarantee under overload. No abrupt crash, forced hibernation, deployed alarm,
late-ACK race, or cross-runtime proof was added here. Pre-deadline live
attachments fail closed on the next scan, but an old wholly idle actor without
an alarm cannot wake itself solely because new code was deployed. Project
authentication and idle-reader admission remain separate decisions.
