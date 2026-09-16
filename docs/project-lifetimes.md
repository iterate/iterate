# Project lifetimes — review implementation

A project may have a deadline for recurring background work. Expiry keeps its
data and deployed application available; it does not delete resources or kill
finite work already running. Projects without a lifetime behave as before.

This is a fresh alternative to `codex/preview-run-retirement`, based on `main`
after the Playwright parallelisation work merged in PR #2659. **The CI experiment is off. No live environment
was changed.**

## Start here

1. [`Lifetime`](../packages/shared/src/lifetime.ts): creation metadata and its
   immutability rule.
2. [`ProjectLifetime`](../apps/os/src/lib/project-lifetime.ts): read the policy,
   check expiry/group retirement, remember expiry. No alarm deletion and no
   knowledge of environments, CI or tests.
3. [`PreviewLifetimes`](../scripts/lib/preview-lifetimes.ts): CI is one caller;
   all attempt bookkeeping and predecessor retirement live here.

## Ordinary project creation

```ts
await session.projects.get("temporary-demo").create({
  metadata: {
    lifetime: {
      expiresAt: Date.now() + 3 * 60 * 60 * 1000,
      group: "demo-session-42", // Optional; omit for deadline-only expiry.
    },
  },
});
```

Auth already supports metadata on creation. OS now passes it through and
preserves it in its existing project directory, including projects created
first by Auth's signup UI. Generated IDs and DO names are unchanged.

Lifetime is creation metadata, not a renewable lease. Auth rejects changes to
it on creation retries and metadata updates. Other metadata remains editable.
OS rejects bootstrapping an expired lifetime or using one without its policy
binding configured. DOs remember a discovered lifetime and expiry durably.

The runtime decision is:

```text
no lifetime                            → keep running
now >= lifetime.expiresAt              → stop recurring work
lifetime.group is marked retired       → stop recurring work
otherwise                              → keep running
```

Group retirement writes `"retired"` at `lifetime:group:<group>` in the policy
KV. It only shortens lifetimes. It cannot unretire a group or extend a deadline.
A privileged control-plane caller writes this marker; project creators cannot
retire other projects merely by choosing a group name.

Compared with the proposed generation/cutoff pair, this version uses a fresh
group for each lifetime cohort. CI never shares one mutable cutoff across run
attempts: each finalizer always writes the same value to its own group. This
avoids read-modify-write races and backwards cutoffs in KV.

## Runtime effects

| Object                   | Effect after observing expiry                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Stream                   | Stop alarm work, constructor rearming and wake recovery. Late work cannot rearm it.                                |
| Scheduler                | Stop recurring schedule/heartbeat alarms.                                                                          |
| Stateful Worker          | Stop forwarding or scheduling user-code alarms.                                                                    |
| Sandbox                  | Disable keepalive at idle expiry, then use its existing backup/shutdown path. Its shutdown alarm stays functional. |
| Shared build coordinator | Finish its finite build.                                                                                           |

The optional `PROJECT_LIFETIMES` binding supplies the policy store. Deployment
configuration can provide it in any environment; the runtime never checks an
environment name. Without the binding there are no policy KV reads. The review
CI switch supplies it through `ENABLE_PROJECT_LIFETIMES=1`, pointing at the
existing project-directory KV, with no new namespace.

KV propagation can delay retirement until a subsequent alarm. A remembered
expiry cannot be undone by a stale read or eviction. Ownership records and
retirement markers must remain until full environment erasure. This does not
promise that an indefinitely busy user program will stop, or that data storage
itself has zero cost.

## CI lifecycle

With `PROJECT_LIFETIMES_EXPERIMENT` enabled in `preview-run.yml`:

- Prepare deploys all apps with lifetime support, retires the predecessor group,
  and publishes one fixed deadline/group for every consumer of the attempt.
- Test helpers pass ordinary project metadata. Browser fixtures add it to the
  real Auth create request; there is no test header or special server endpoint.
  The streams playground uses an isolated namespace with the same metadata.
- Finish waits for all consumers, then retires that exact group. Report merging
  remains parallel. The deployment and data remain available for inspection;
  new human-created projects continue to work normally.
- A later run may skip pre-deploy erase only on a live same-owner lease with
  this protocol's marker. Legacy slots, expired leases and handovers still erase.
- Lease release/sweeping still performs full resource cleanup. Failed preparation
  retains the existing erase fallback. A killed run also has its fixed deadline.

The many small test-file changes explicitly opt project creation into the same
metadata API. They replace the previous draft's implicit connection-wide header.

## Before enabling

- [ ] Prove real browser onboarding carries metadata through Auth, directory
      caching and OS birth. The route fixture targets the existing oRPC create
      request; its live wire format still needs verification.
- [ ] Audit all creation paths: tests using custom clients, CLI scripts, seeds,
      script strings, and explicit playground namespace IDs may bypass the
      common helpers. Existing projects must not be silently relabelled.
- [ ] Prove warm/cold Streams, Schedulers, stateful Workers and keepalive
      containers go quiet; audit shared/global subscriptions to expired projects.
- [ ] Run two successive attempts, cancellation and a stale finalizer against a
      preview. Check traces and retained state, not only test results.
- [ ] Prove suites tolerate retained Auth/global state. Bump the reuse protocol
      or explicitly erase when retained storage becomes incompatible.
- [ ] Measure policy reads and lifecycle latency. Check admin-created projects
      with explicit reused IDs: their directory is KV-backed rather than Auth D1,
      so concurrent recreation must not overwrite lifetime metadata.

Local tests cover policy decisions, remembered expiry, Stream eviction/rearming,
Auth-first directory propagation, immutable creation retries and stale finalizers.
They do not replace the deployed acceptance checks above.
