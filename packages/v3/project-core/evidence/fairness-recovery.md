# Recovery with live readers on the retained source — 5 September 2026

**Two SIGKILL probes pass on the 4,999-line reader-aware-yield implementation.**
An interrupted processor resumes autonomously without duplicating its committed
effect. A pending retry resumes autonomously and halts at three attempts with
its durable explanation intact. Both had an OPEN, acknowledging reader through
the pre-kill append/effect boundary. Repository code and fresh stream connections
retain their public behavior.

No implementation change was needed. These are local operational probes,
separate from the preceding **34/34 public-network suite**, not new formal test
cases or deployed Cloudflare recovery evidence. They follow the
[retained scheduling change](live-reader-fairness.md) and refresh the processor
boundaries from the [earlier SIGKILL probe](abrupt-recovery.md).

## Failure boundary and observation discipline

Wrangler 4.127.1, workerd 1.20260828.1, Node 26.5.0, debug logging, original
core configuration, isolated port 8799, and synthetic encryption/admin bindings.
Persistence: `/tmp/project-core-fair-recovery-1RBesq`. The controller generates
the synthetic 32-byte key with `Buffer.alloc(32, 65).toString("base64url")`.

The Node controller imports only the public HTTP helpers in `e2e/support.ts`;
raw subscriptions use WebSocket. Each Wrangler starts as its own detached
process group. Before each stop, the controller reads `ps`, selects only that
actual new group, verifies its leader and workerd members, and signals it.
No database file is read and no product process or credential is involved.

| Boot | Owned process group | `/version` ready at |  Stop sent at | Exit           |
| ---- | ------------------: | ------------------: | ------------: | -------------- |
| 1    |               51114 |       1788573900419 | 1788573900561 | SIGKILL        |
| 2    |               51138 |       1788573901504 | 1788573901954 | SIGKILL        |
| 3    |               51164 |       1788573902858 | 1788573905237 | SIGINT, code 0 |

The controller verifies port 8799 absent between boots. Readiness requests
address only `/version`. After restart it waits for a generation-specific
dynamic-worker marker in that boot's newly captured stdout, then waits 200 ms,
before its **first project request**, an `inspect` assertion:

```js
await startRuntimeAndPollVersion(); // does not address a project
await waitForThisBootOnly(resumedMarker);
await delay(200);
const state = await call(projectId, ["inspect"], []);
assert.deepEqual(state.processors[0], expectedRecoveredProgress);
```

This ordering matters: even an ordinary project read or a new subscription can
re-arm an alarm in request cleanup, masking lost autonomous scheduling. The
claim rests on the controller's awaited ordering and separate per-boot buffers,
not on a post-restart read alone. Wrangler's retained debug files do not log
application request lines and cannot independently prove their absence.

Every pre-kill reader checks page/offset continuity, stores the full received
envelopes, and immediately sends the exact ACK. It remains OPEN with no prior
client error through offset 133. These are client-observed ACK sends, not an
inspection of server socket attachments. Both recoveries occur well before a
20-second stream ACK lease could expire, so a delayed lease expiry is not the
observed recovery trigger.

## 1. Committed effect, unadvanced cursor, live reader

Project: `fair-crash-inflight-mtnqpy0z-6c970b783bc2`.

The setup commits a repository, mounts its revision-pinned worker, installs
the processor, then opens a reader. A batch of 128 padding events, each with
1 KiB of text, brings the stream through offset 131. The reader acknowledges
those pages before the input at offset 132. The processor consumes only `input`:

```js
async processEvent(event) {
  const context = await this.env.ITX.get();
  const page = await context.readEvents({ afterOffset: event.offset, limit: 128 });
  const prior = page.events.some((row) => row.id === `once/${event.id}`);
  await context.append({
    id: `once/${event.id}`, type: "derived", data: { parent: event.id },
  });
  if (!prior) {
    console.log(STALLED_MARKER);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  } else {
    await context.append({
      id: `resumed/${event.id}`, type: "resumed", data: { parent: event.id },
    });
    console.log(RESUMED_MARKER);
  }
}
```

The marker strings are unique to this project. The existence check begins
after the input, with only its derived/resumed events in scope; this bounded
fixture is not a proposed general idempotency-query API.

Before the first kill, public replay and the live reader agree on all 133 full
envelopes. Their IDs are `repo`, `mount`, `install`, `pad-0` through `pad-127`,
`input`, and `once/input`. Inspection reports:

```json
{
  "name": "recovery",
  "setting_offset": 3,
  "cursor": 131,
  "attempts": 0,
  "retry_at": null,
  "error": null
}
```

The effect at offset 133 has timestamp `1788573900495`; SIGKILL occurs at
`1788573900561`, **66 ms later**, well before the 20-second delivery timeout.
The reader's last exact ACK send was for offset 133 at `1788573900495`.

On boot 2, the resumed marker is logged at `1788573901509`; the controller
observes it at `1788573901526`, **965 ms after the kill**, before addressing
the project. Its first inspection finds cursor **134**, attempts 0, and null
retry/error. Public replay contains exactly one new event, `resumed/input` at 134. All 133 pre-kill envelopes remain deeply equal, including timestamps and
verification. There is still exactly one `once/input`.

A duplicate input returns the exact original receipt; changed input content
returns `409 ID_CONFLICT`. A new WebSocket opened from the client's saved
cursor 133 receives exactly `resumed/input`, through/head 134, and ACKs it.

## 2. Pending retry, live reader, terminal explanation

Project: `fair-crash-retry-mtnqpz3u-20ec5b70064f`.

Boot 2 sets up a separate project with the same repository/mount/processor
and 128-event prefix, again with an OPEN acknowledging reader. Its worker
consumes only `poison`, at offset 132:

```js
async processEvent(event) {
  const context = await this.env.ITX.get();
  await context.append({
    id: `once/${event.id}`, type: "derived", data: { parent: event.id },
  });
  console.log(DELIVERED_MARKER);
  throw new Error(FAILURE_MARKER);
}
```

The first attempt commits `once/poison` at 133. Full replay and the reader
agree on all 133 envelopes. Before SIGKILL, inspection reports cursor 131,
attempts 1, retry deadline `1788573902893`, and the classified error for input
offset 132. The kill at `1788573901954` is **939 ms before that deadline**.

Boot 3 logs two deliveries and their expected failures, attempts 2 and 3.
The controller observes both at `1788573904916`, **2,962 ms after the kill**,
before making any project request. Its first inspection then finds:

```json
{
  "name": "recovery",
  "setting_offset": 3,
  "cursor": 131,
  "attempts": 3,
  "retry_at": null,
  "error": "offset 132 (poison): fair-recovery-retry:fair-crash-retry-mtnqpz3u-20ec5b70064f"
}
```

All 133 pre-kill envelopes replay identically. The deterministic effect ID
produces one durable event across three deliveries. A duplicate poison input
returns its original full receipt without clearing the terminal failure.

A fresh WebSocket connects from offset 133; a new `post-restart` checkpoint
append returns offset 134 and the same full envelope arrives live and is ACKed.
The halted processor is not claimed to consume later events. This last fresh
append is receipt/live checked; it was not part of the preceding replay pass.

## Repository and transport checks

For both projects, post-restart `repos.head`, `repos.list`, and pinned
`repos.read` deeply equal their pre-kill values. The repository-backed mounted
worker still returns `Hello, after` through the public `app.greet("after")`
method. The revisions are:

```txt
inflight edf8cae2374710980363a24c43388d6b3882ada78b322c221d4489e3f8b63ac9
retry    184d21b4afe7167ad10ad43bca141f60da07ccfc2f92972210feb7fbebc0f380
```

Both original client sockets close with code 1006 and a blank-message error
event, within three milliseconds of the intentional group kills. These are
controller-side transport observations, not unexpected application failures
in the Wrangler logs. The old sockets do **not** resume across process death;
new sockets explicitly reopen from the saved cursor. Both reopened readers
close normally after their checks.

## Logs, exact source, and remaining scope

Logs in `/Users/jonastemplestein/Library/Preferences/.wrangler/logs/`:

| Boot | Log                                    | Classified diagnostics                                                             |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| 1    | `wrangler-2026-09-05_02-05-00_001.log` | One stalled marker; no exception/warning                                           |
| 2    | `wrangler-2026-09-05_02-05-01_085.log` | One resumed marker; then deliberate retry exception and matching attempt-1 warning |
| 3    | `wrangler-2026-09-05_02-05-02_444.log` | Two deliberate retry exceptions with matching attempt-2/3 warnings                 |

An independent log audit finds zero extra hung/async cancellations,
`NOSENTRY`, alarm/scheduler errors, subscription-callback failures, or socket
and inspector error diagnostics. Inspector setup/open messages are normal
per-boot initialization. A killed process cannot guarantee flushed log buffers;
public durable-state assertions and the autonomous marker ordering are the
primary evidence.

The controller completes with exit 0. All owned fixture processes are stopped;
port 8799 is no longer listening. The separate tutorial on 8798 remains HTTP 200. No fixture data was deleted, and no deployment, commit, push, or PR occurred.

Source SHA-256 values are unchanged before/after the probes:

```txt
src/worker.ts abdc28fdbb6bc257b07b96878b55bc9e141fd8555bcbf747b69a9fc36f61046d
src/stream.ts 974318f88e41a7e87a38197adc70b1d1e7484c5090655f8b26915b157f5da211
src/processors.ts baf0ca392e86975fe47d14fcac0b0656d2199771c9ecabeaa73c202f3d59a624
src/repositories.ts 3d2f6c9eb5b6d5df5cd333f92554078e074cbc2395cc348ad68f5e5d67098ba9
```

The count remains **4,999 raw authored lines**. The temporary controller was a
command, not retained uncounted runtime/test functionality. The formal suite
was not rerun for this documentation-only checkpoint.

This proves local at-least-once processor replay with idempotent stream effects,
repository reconstruction, and explicit reader reconnect on the retained
source. It does not prove exactly-once arbitrary external effects, machine or
storage loss, a kill inside a synchronous commit, Cloudflare eviction or
deployment, automatic capability/session reconstruction, hostile-load memory
bounds, or current-source secret/approval crash behavior. The latter still has
only the [preceding checkpoint's evidence](egress-recovery.md).
