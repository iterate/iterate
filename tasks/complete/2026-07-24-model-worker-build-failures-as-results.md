status: complete
size: medium

# Model worker source-build failures as results

Status: Complete. Source failures stay as plain data through both RPC hops, successful live capabilities pass through without wrapping or property probes, and final-head verification is running.

## Plan

- [x] Define a JSON-safe discriminated build result for either a completed artifact or a deterministic source failure. _`WorkerBuildResult` is the coordinator contract; the bundler adapter uses the same failure shape._
- [x] Return source failures as data from the keyed build coordinator; keep infrastructure failures and programming defects throwing. _Coordinator source outcomes resolve; transport and storage errors still reject._
- [x] Carry the result through worker loading and the outer stateful-worker invocation boundary before interpreting it. _The stateful host returns a nonce-matched failure envelope; successful user values stay untouched._
- [x] Remove the name/property reconstruction used to preserve `retryable: false` across lossy RPC errors. _A local terminal error is created once, after the final hop._
- [x] Prove a source failure parks its stream subscription on attempt one with the exact compiler message. _Runner and delivery-spine tests cover the final error and immediate park._
- [x] Prove an infrastructure failure still enters bounded delivery backoff. _Coordinator and existing delivery tests retain the throwing path._
- [x] Preserve timeout/alarm terminal-failure receipts and successful build coalescing. _Focused coordinator tests cover timeout, eviction, receipt replay, coalescing, and retry._
- [x] Run focused worker/stream tests, OS typecheck and lint, then production-shaped preview CI. _Focused tests, all 2,337 OS unit tests, typecheck, lint, Knip, and preview deploy/e2e pass._

## Design notes

Expected compiler rejection is a domain outcome, not an exception:

```ts
type WorkerBuildResult =
  | { ok: true; artifact: WorkerBuildArtifact }
  | { ok: false; failure: { kind: "source"; message: string } };
```

The outcome must remain plain data until it has crossed the final stateful-worker RPC hop. Unavailable Durable Objects, repo/KV failures, compiler transport failures, and unexpected defects continue to throw so existing retry and observability behavior stays intact.

## Implementation log

- 2026-07-24: Converted worker-bundler source rejection, coordinator flights, durable receipts, source resolution, and stateful invocation to discriminated results.
- 2026-07-24: Kept the public capability API unchanged: source failures become a local `WorkerBuildFailedError` with `retryable: false` only after the final stateful RPC hop. A private nonce distinguishes that failure data without wrapping successful values or changing live-stub ownership.
- 2026-07-24: Documented the internal result boundary and verified focused tests, the full OS unit suite, OS typecheck, and repository lint.
- 2026-07-24: Review follow-up uses a nonce-tagged array for the private failure envelope, so it can be detected with `Array.isArray` without starting an orphaned property pipeline on object- or function-shaped RPC stubs; removed the redundant error factory.
