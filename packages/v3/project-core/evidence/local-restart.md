# Local process restart — 5 September 2026

**Passed through public HTTP and WebSocket interfaces.** This is a graceful
Wrangler/workerd process stop and restart with persisted Miniflare state, not a
Cloudflare eviction, machine crash, interrupted transaction, or deployment proof.
It is a one-off operational probe, not an additional test in the formal suite.

## Fixture and observations

Wrangler 4.127.1, original `wrangler.jsonc`, isolated port 8799, persistence
directory `/tmp/project-core-restart-bench-oW0ukx`, project
`recovery-20260905-01`. The tutorial process on port 8798 remained running.
Both boots used the synthetic bindings from [local verification](local-verification.md).
No product credentials or data were used.

| Public resource                    | Before stop                                                                             | After restart                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Root stream                        | Two notes, repo commit, mount, processor configuration, poison input, one derived event | Same seven IDs in order, offsets 1–7                                                  |
| Duplicate append                   | `one`, data `{ n: 1 }`, offset 1                                                        | Original offset **and timestamp** returned; different content gives `409 ID_CONFLICT` |
| Immutable repo `app`               | Revision `c68145bd9b7d3fb2c66a40bb8b6de7f0af5c1e1fe6ee6cbcae7af60daaecaede`             | Identical head revision                                                               |
| Revision-pinned worker mount `app` | `greet("before")` → `Hello, before`                                                     | `greet("after")` → `Hello, after`                                                     |
| `/signed` trust policy             | Minimum level 2, one configured Ed25519 key                                             | New unsigned append gives `403 SIGNATURE_REQUIRED`                                    |
| `/signed` historical event         | One signature, verification level 2, policy offset 1                                    | Signature and verification retained; context head remains 2                           |
| WebSocket replay                   | Last known root offset 5                                                                | Reconnect from 5 returns offsets 6 and 7; client ACKs 7                               |
| Retry processor                    | Attempt 1, future deadline, setting offset 5                                            | Attempts 2 and 3 run; terminal state retains explanation                              |

The retry worker deliberately appends an idempotent result, then throws:

```js
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Retry extends WorkerEntrypoint {
  async processEvent(event) {
    const context = await this.env.ITX.get();
    await context.append({
      id: "once/" + event.id,
      type: "once",
      data: { parent: event.id },
    });
    throw new Error("restart-probe");
  }
}
```

Only one `once/poison` event exists after all three deliveries. This proves
idempotent append for this deterministic output, not exactly-once arbitrary
external effects.

## Retry timeline

Public `inspect()` reported this immediately before stopping:

```json
{
  "name": "restart",
  "setting_offset": 5,
  "cursor": 5,
  "attempts": 1,
  "retry_at": 1788564576522,
  "error": "offset 6 (restart/poison): restart-probe"
}
```

The observation timestamp was `1788564575628`: 894 ms before the retry
deadline. Wrangler session 90389 was stopped immediately afterwards with
Ctrl-C and exited 0. A listener check showed port 8799 absent, while the same
port-8798 workerd PID 31438 remained alive. The old port-8799 workerd PID was 98585. A fresh Wrangler session 6139 then booted the same persistence directory.

Before any post-restart request to the context, the new runtime reported
attempt 2 and its next deadline `1788564586082`; it subsequently reported
attempt 3 and `retryAt: null`. Public inspection confirmed the same setting
offset and cursor with `attempts: 3`, `retry_at: null`, and the original error.
**No append was made after restart until after this terminal state was
verified.** Otherwise an append could mask a lost alarm by starting processing.

Logs in `~/Library/Preferences/.wrangler/logs/`:

- Before: `wrangler-2026-09-04_23-28-47_849.log` — one deliberate `restart-probe` failure.
- After: `wrangler-2026-09-04_23-29-43_752.log` — two deliberate `restart-probe` failures.

Verbose logging was enabled on both boots. The probe produced no additional
hung-session cancellations or alarm-manager mismatches. The post-restart log
also contains the separately described throughput experiment.

## Reproduce the lifecycle boundary

Use a fresh project and persistence directory. The setup and observation calls
use the same public payloads as [core](../e2e/core.test.ts),
[processor](../e2e/processors.test.ts), and [provenance](../e2e/provenance.test.ts)
tests; no SQLite files are queried or modified.

1. Append notes and a `repo.commit`; mount its pinned revision with `itx.set`.
2. In `/signed`, install a level-2 trust policy and append a trusted signed event.
3. Install the worker above as `processor/restart`, consuming `restart/poison`.
4. Append one poison event. Observe attempt 1 and a future deadline using `inspect`.
5. Allow about 100 ms for the alarm finalizer, then stop only this isolated
   Wrangler process. Verify its listener is gone. Restart with the exact same
   `--persist-to`, binding names, and synthetic encryption key.
6. Without appending, inspect until attempt 3, bounded by a 12-second deadline.
7. Read/replay both contexts, call the pinned worker, and test duplicate append
   and unsigned rejection through the public API.

The later [SIGKILL probe](abrupt-recovery.md) covers both a pending retry and
an in-flight delivery whose idempotent effect committed before its cursor advanced.
Outstanding: abrupt crash inside a synchronous commit, real Cloudflare eviction,
secret/approval state across restart, active-session reconnection semantics,
and a repeatable target-specific restart controller for deployed E2Es. A stored
stream cursor survives; a live Cap'n Web handle is not thereby made durable.
