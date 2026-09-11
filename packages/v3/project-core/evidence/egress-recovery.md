# Approval and secret recovery — 5 September 2026

**Passed across two SIGKILL restarts using public HTTP interfaces.** Pending
requests, signed decisions, consumed approvals, and secret revisions survived.
Permitted HTTPS echoes verified decryption after restart. No source change
was needed; this is an operational probe, not a new formal test or deployed
Cloudflare recovery evidence.

## Fixture and failure boundary

The then-current **4,999-line** core, including the transaction-local trust read,
ran under Wrangler 4.127.1 / workerd 1.20260828.1 / Node 26.5.0. The fixture
used port 8799, original core configuration, the usual synthetic encryption
and admin bindings, and persistence `/tmp/project-core-egress-crash-Jj1Vju`.
Project: `crash-egress-mtnnzcgq-e451a9fd7eb5`.

A Node controller imported only the public HTTP/signing helpers from
`e2e/support.ts`. It spawned each Wrangler in a new detached process group,
verified the actual group leader and workerd members with `ps`, then signaled
only that owned group. Both interrupted children exited `[null, "SIGKILL"]`.
Port 8799 was verified absent before each boot. No SQLite files were examined.

| Boot | Owned process group |      Ready at | Stop signal sent at | Result         |
| ---- | ------------------: | ------------: | ------------------: | -------------- |
| 1    |               26477 | 1788569301160 |       1788569301249 | SIGKILL        |
| 2    |               26601 | 1788569302312 |       1788569303190 | SIGKILL        |
| 3    |               26720 | 1788569304334 |       1788569305049 | SIGINT, exit 0 |

The last runtime was stopped normally after all assertions. Port 8799 is no
longer listening; the tutorial on 8798 remained HTTP 200. Only synthetic
values were sent to the already-permitted `https://httpbin.org/headers` echo
endpoint. No deployment or product credentials were involved.

## Public setup

Root configuration installed one generated Ed25519 trusted signer, permissive
ordinary appends (`minLevel: 0`), required egress approval with a five-minute
expiry, and a mounted native worker. Approval decisions independently require
verification level 2. The worker's relevant behavior was:

```js
const path = new URL(request.url).pathname;
const target = new URL(path === "/origin" ? "https://example.com/" : "https://httpbin.org/headers");
target.searchParams.set("case", path);
const headers = new Headers({
  "x-synthetic-token": path === "/rotate" ? "{{secret:ROTATE_TOKEN}}" : "{{secret:TEST_TOKEN}}",
});
const approval = request.headers.get("x-project-core-approval");
if (approval) headers.set("x-project-core-approval", approval);
return fetch(new Request(target, { headers }));
```

The `case` query distinguishes the exact plans; retries preserve URL, method,
ordinary headers, and empty body. Both secret origins are `https://httpbin.org`.
`TEST_TOKEN` stays at revision 1. `ROTATE_TOKEN` is initially revision 1 and
rotates to revision 2 before the first kill. Secret writes return only
`{name, origin, revision}` receipts.

## Observed transitions

Before the first kill, public history had exactly 13 events: three settings,
two secret writes, four pending-request facts, three signed decisions, and the
secret rotation. Decisions at offsets 10/11/12 denied `/denied`, allowed
revision-1 `/rotate`, and allowed `/approved`. `/pending` was undecided.
There were no released-effect facts.

| Request         | Before first kill                                  | After first restart                                                                                                 | After second restart                                                         |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/pending`      | Undecided                                          | Same 202 response, including ID/fingerprint/expiry; unsigned decision rejected; signed allow committed at offset 18 | Releases once with revision-1 secret; immediate retry is `409 APPROVAL_USED` |
| `/denied`       | Signed deny                                        | `403 APPROVAL_DENIED`                                                                                               | Still `403 APPROVAL_DENIED`                                                  |
| `/approved`     | Signed allow                                       | Returns 200 and echoes revision-1 secret; approval consumed                                                         | `409 APPROVAL_USED`                                                          |
| Old `/rotate`   | Signed allow for revision 1; secret now revision 2 | `409 APPROVAL_MISMATCH`; no release                                                                                 | Still `409 APPROVAL_MISMATCH`                                                |
| Fresh `/rotate` | Not yet created                                    | Different fingerprint; signed allow; returns 200 and echoes revision-2 secret                                       | `409 APPROVAL_USED`                                                          |

All expiry timestamps were at least `1788569601184`; the final assertions
finished at `1788569305009`, almost five minutes earlier. Denial, rotation,
and consumption outcomes therefore were not confused with expiry.

Additional assertions:

- History immediately after each restart was deeply equal to the complete
  pre-kill history: IDs, offsets, timestamps, signatures, and verification.
- Re-reading an undecided request returned its original 202 response exactly,
  without adding another requested fact. Denial, mismatch, and origin checks
  also left the history unchanged.
- `/origin` failed `403 SECRET_ORIGIN` after restart; the other HTTPS origin
  could not obtain the stored secret.
- The unsigned approval failed `403 APPROVAL_SIGNER` and left no event behind.
- A duplicate of the signed decision at offset 18 returned the original full
  receipt even after its approval had been consumed. It did not reapply the
  decision or make another release possible.
- Final history had 19 consecutive events, including exactly three
  `itx.system.egress.released` facts at offsets **14, 17, 19**. Their
  fingerprints matched only `/approved`, fresh revision-2 `/rotate`, and
  `/pending`. The denied and old-revision plans had no release.
- Neither complete event replay nor public `inspect()` contained any of the
  three synthetic plaintext values. Event replay contained no ciphertext field.

Unlike the processor recovery probe, these operations intentionally require a
caller after restart. An approval is permission to retry an exact request,
not an instruction to dispatch it automatically on boot.

## Logs and scope

All logs are in the usual local Wrangler log directory:

- `wrangler-2026-09-05_00-48-20_744.log`
- `wrangler-2026-09-05_00-48-21_892.log`
- `wrangler-2026-09-05_00-48-23_922.log`

Each has zero uncaught exceptions, zero hung/extra async cancellations, zero
alarm-manager mismatches, zero peer-disconnect exceptions, and zero occurrences
of the fixture plaintext values. SIGKILL cannot guarantee that every log
buffer flushes; public durable-state assertions are the primary evidence.

This proves local persistence and one-use authorization, not exactly-once
remote effects. All three allowed echoes completed before their runtime was
stopped. A crash between consuming an approval and observing the provider's
response remains a separate reconciliation problem. “Write-only” is an API
property: a trusted recipient can reflect the credential, as this test does;
the core does not implement response taint tracking.

Other outstanding boundaries include machine/storage loss, deployed eviction,
encryption-key rotation, and long-lived pending-request retention. Expired or
superseded pending rows are not currently purged. Invalidating a fingerprint
does not delete its row; this probe is not a storage-growth acceptance test.

No runtime, test, or configuration file changed. The formal suite remains the
preceding **33/33** checkpoint and the count remains **4,999**. See
[local verification](local-verification.md) and the earlier
[processor SIGKILL evidence](abrupt-recovery.md).
