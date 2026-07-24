status: in-progress
size: medium

# Model worker source-build failures as results

Status: Planning complete; implementation has not started. The target is to carry expected source-build failures as plain data across both Workers RPC boundaries while leaving infrastructure failures exceptional and retryable.

## Plan

- [ ] Define a JSON-safe discriminated build result for either a completed artifact or a deterministic source failure.
- [ ] Return source failures as data from the keyed build coordinator; keep infrastructure failures and programming defects throwing.
- [ ] Carry the result through worker loading and the outer stateful-worker invocation boundary before interpreting it.
- [ ] Remove the name/property reconstruction used to preserve `retryable: false` across lossy RPC errors.
- [ ] Prove a source failure parks its stream subscription on attempt one with the exact compiler message.
- [ ] Prove an infrastructure failure still enters bounded delivery backoff.
- [ ] Preserve timeout/alarm terminal-failure receipts and successful build coalescing.
- [ ] Run focused worker/stream tests, OS typecheck and lint, then production-shaped preview CI.

## Design notes

Expected compiler rejection is a domain outcome, not an exception:

```ts
type WorkerBuildResult =
  | { ok: true; artifact: WorkerBuildArtifact }
  | { ok: false; failure: { kind: "source"; message: string } };
```

The outcome must remain plain data until it has crossed the final stateful-worker RPC hop. Unavailable Durable Objects, repo/KV failures, compiler transport failures, and unexpected defects continue to throw so existing retry and observability behavior stays intact.
