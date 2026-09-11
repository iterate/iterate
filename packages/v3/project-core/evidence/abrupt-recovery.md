# Abrupt local recovery — 5 September 2026

**Two SIGKILL recovery probes passed through public HTTP/WebSocket interfaces.**
One killed a pending retry; the other killed a delivery after its idempotent
effect committed but before its cursor advanced. No source change was needed.
These are operational probes, not two additional cases in the 33-test suite,
and not Cloudflare deployment or machine/power-loss evidence.
The [later live-reader recovery probe](fairness-recovery.md) repeats these
processor boundaries on the retained reader-aware-yield/consolidation source.

## Controlled failure boundary

Wrangler 4.127.1, workerd 1.20260828.1, Node 26.5.0, original core configuration,
synthetic encryption/admin bindings, isolated port 8799, persistence directory
`/tmp/project-core-crash-l3b4ZL`. A Node controller spawned each Wrangler as its
own detached process group and captured its stdout/stderr. Before each kill,
`ps` verified the group's membership, including its workerd processes. Only
that owned group received SIGKILL. Both child exits reported `[null, "SIGKILL"]`;
the controller verified port 8799 absent before starting the next runtime.

The relevant controller shape was:

```js
const child = spawn(pnpm, ["exec", "wrangler", "dev" /* fixture arguments */], {
  cwd: coreDirectory,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
// After verifying this new group's actual members, never a guessed/shared PID:
process.kill(-child.pid, "SIGKILL");
await once(child, "exit");
```

Process groups were **20417**, **20451**, then **20489**. The third boot was
stopped normally with SIGINT after verification, exit 0. The tutorial on port
8798 stayed available. No product process, data, credentials, or deployment
was involved. The persisted fixture remains on disk.

Boot readiness used only `/version`. Crucially, after each restart the
controller waited for an autonomous processor log marker **before making any
request to either recovery project**. Even a read or `inspect` would be a
weaker proof: request cleanup can arm an alarm and mask lost scheduling.
All state assertions below used the public API; no SQLite files were inspected.

## 1. Pending retry survives SIGKILL

Project: `crash-retry-mtnnd714-aae79536f920`. The worker was:

```js
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Retry extends WorkerEntrypoint {
  async processEvent(event) {
    const context = await this.env.ITX.get();
    await context.append({ id: `once/${event.id}`, type: "derived", data: {} });
    throw new Error("crash-probe-retry");
  }
}
```

It consumes only `poison`. Its configuration event is offset 4, poison input
offset 5, and its one derived event offset 6. Public inspection just before
the kill returned:

```json
{
  "name": "retry",
  "setting_offset": 4,
  "cursor": 4,
  "attempts": 1,
  "retry_at": 1788568267762,
  "error": "offset 5 (poison): crash-probe-retry"
}
```

Observed at `1788568266767`; SIGKILL was sent at `1788568266799`, **963 ms
before the retry deadline**. On the second boot, the runtime logged attempts
2 and 3 autonomously. The controller observed attempt 3 at `1788568269793`
before any project request. Public inspection then confirmed:

```json
{
  "setting_offset": 4,
  "cursor": 4,
  "attempts": 3,
  "retry_at": null,
  "error": "offset 5 (poison): crash-probe-retry"
}
```

The cursor correctly remains before the poison event, with a durable terminal
explanation. Readback contained exactly these IDs, at consecutive offsets 1–6:

```text
one → repo → mount → install-retry → poison → once/poison
```

Additional public assertions after recovery passed:

- Duplicate `one` returned the complete original receipt, including offset 1
  and timestamp `1788568266717`; changed content returned `409 ID_CONFLICT`.
- Repository `app` retained revision
  `20356ae4865721181e47e080c9ee8921879ddd07e1224e866ca5a1238c02c874`,
  and its revision-pinned mounted worker returned `Hello, after`.
- `/signed` retained its level-2 policy; a fresh unsigned write returned
  `403 SIGNATURE_REQUIRED`. The historical signed receipt was deeply equal,
  including its signature, verification level, policy offset, and timestamp.
- A fresh WebSocket connected from offset 4 and replayed `poison` and
  `once/poison`, through offset 6, which the client acknowledged.

## 2. Committed effect, unadvanced cursor

Project: `crash-inflight-mtnnd9gz-da54d2de9922`. This worker deliberately waits
after its first effect but completes when that effect already exists:

```js
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Inflight extends WorkerEntrypoint {
  async processEvent(event) {
    const context = await this.env.ITX.get();
    const page = await context.readEvents();
    const resumed = page.events.some((row) => row.id === `once/${event.id}`);
    await context.append({ id: `once/${event.id}`, type: "derived", data: {} });
    if (!resumed) await new Promise((resolve) => setTimeout(resolve, 60_000));
    else {
      await context.append({ id: `resumed/${event.id}`, type: "resumed", data: {} });
      console.log("crash-probe-inflight-resumed");
    }
  }
}
```

The fixture has only four eventual events, so its one-page existence check is
intentional test logic, not a recommended general-purpose idempotency lookup.
The platform's 20-second delivery timeout never elapsed before the kill.

| Boundary                   | Public observation / controller timestamp         |
| -------------------------- | ------------------------------------------------- |
| First effect committed     | `once/input`, offset 3, timestamp `1788568269890` |
| Delivery not advanced      | Input offset 2; cursor 1, attempts 0, error null  |
| SIGKILL sent               | `1788568269940`, 50 ms after the effect timestamp |
| Autonomous resume observed | `1788568270825`, before any project request       |
| Completed state            | Cursor 4, attempts 0, retry_at null, error null   |

Final readback was exactly `install-inflight`, `input`, `once/input`,
`resumed/input` at offsets 1–4. The `once/input` receipt was deeply equal to
the pre-kill receipt: retry neither duplicated nor rewrote the committed fact.
The explicit `resumed/input` event proves a second invocation, rather than
mistaking the original effect for completion of the interrupted delivery.

This demonstrates at-least-once replay with a deterministic, idempotent stream
effect. It does **not** promise exactly-once arbitrary external effects.

## Logs and acceptance scope

Logs under `/Users/jonastemplestein/Library/Preferences/.wrangler/logs/`:

| Boot | Log                                    | Expected diagnostics                                       |
| ---- | -------------------------------------- | ---------------------------------------------------------- |
| 1    | `wrangler-2026-09-05_00-31-06_384.log` | One `crash-probe-retry` exception and classified attempt 1 |
| 2    | `wrangler-2026-09-05_00-31-07_355.log` | Two such exceptions and classified attempts 2 and 3        |
| 3    | `wrangler-2026-09-05_00-31-10_493.log` | One autonomous resumed marker; no uncaught exception       |

All three retained logs have zero extra hung/async cancellations, zero
NOSENTRY alarm mismatches, and no peer-disconnect exception. A killed process
cannot promise to flush every diagnostic; the durable state assertions and
autonomous post-boot observations are the primary evidence.

No runtime, test, or configuration file changed. The strict authored-code
count remains **4,998**; the preceding full suite remains **33/33**. This probe
adds a stronger lifecycle checkpoint alongside [graceful restart](local-restart.md).

Still unproven: process death inside a synchronous commit, actual machine or
storage failure, Cloudflare eviction/deployment, remote-effect reconciliation,
and automatic reconstruction
of live capability sessions. A deployment-specific kill/restart controller is
still needed for repeatable deployed acceptance.

The later [approval/secret recovery probe](egress-recovery.md) separately
verifies pending decisions, consumed approvals, and secret revisions across
two SIGKILL restarts on the subsequent 4,999-line source.
