# Delivery transport slice: implementation record

## Contract

`Subscription.delivery` is a required declaration on a configured row:

| Mode        | Progress owner                      | Runtime target requirement                                                  |
| ----------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `live`      | the connected pager-backed provider | `RpcStubHandle`                                                             |
| `processor` | the processor checkpoint            | `FacetHandle` and terminal `processEventBatch`                              |
| `durable`   | the stream cursor/fan-out engine    | any callable capability, including an arbitrary durable-object facet method |

Alias resolution may select the callable capability but never changes the acknowledgement model. This removes the prior disagreement between static target resolution and the value later produced by evaluation. It intentionally breaks literal configured events without `delivery`.

## Changes

- `stream/subscription-delivery.ts` branches on the row declaration in commit, alarm, resume, cursor, fan-out, and push paths. Processor and live target mismatches are refused as `INVALID_INPUT`; durable retains arbitrary capability RPC.
- A resumed live row has no cursor or checkpoint to replay, so it waits for the next matching append.
- `context/rpc-stub-relay.ts` gives every borrowed provider call a bounded lease. The default is five minutes, authoring may choose an integer lease from 20 seconds through 30 minutes, and live subscription callbacks use 20 seconds. A provider that answers liveness probes yet never settles the original call is disposed and returns `TIMEOUT`; a provider that stops answering probes retains `RPC_STUB_OFFLINE` behaviour.
  The lease covers one `invoke` or `fetch` call until its response settles. It does not limit a returned streaming response body; the existing fetch/body ownership and caller cancellation contract remains. Capabilities that legitimately await long work must set `callDeadlineMs` explicitly (up to 30 minutes); timed-out calls release the borrowed RPC answer and report a bounded `TIMEOUT` outcome rather than keeping an isolate pin indefinitely.

## Evidence

- `pnpm exec vitest run --configLoader runner --project unit --silent=passed-only src/context/rpc-stub-relay.test.ts`: 24 passed.
- `pnpm exec vitest run --configLoader runner --project unit --silent=passed-only src/stream/subscription-delivery.test.ts`: 277 passed.
- `git diff --check`: passed.

The subscription tests explicitly cover the formerly inferred aliases: a durable alias remains cursor-owned when it resolves first to a facet and then to a sink; a processor alias declares processor mode; a durable alias re-pointed to a facet retains its retry claim. The relay test covers responsive liveness probes plus a never-settling call and asserts its disposal, telemetry, and `TIMEOUT` outcome.

## Follow-up proof

The broader migration must cover raw literal configured events, React/SDK authoring, disconnect/redial under the 20-second live lease, and processor checkpoint/catch-up after a delivery mismatch. The generic durable engine remains deliberately intact until an SDK/user-space runner replaces it.

## External review

The local Opus invocation did not return JSON. The parent review is recorded at `/tmp/core-simplification-opus/round-1-result.md`: it confirms the explicit delivery declaration fixes repeated target inference; it also requires a bounded lease to remain configurable because the existing tunnel test deliberately answers after 35 seconds. This slice uses a five-minute generic default, a documented 20-second through 30-minute override, and a 20-second live-subscription lease. No concurrent or duplicate review process ran.
