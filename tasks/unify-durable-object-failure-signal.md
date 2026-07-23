---
title: Unify the "retryable Durable Object failure" signal (three representations → one)
status: open
severity: low
area: streams / error-handling
owner: unassigned
created: 2026-07-23
relates:
  - docs/flake-athon-refactor-options.md (Round 3 — the deeper clutter)
  - tasks/preview-rollout-do-reset-gate.md
---

# Unify the DO-failure signal

## Why this is a task and not part of the lean fix

Surfaced during the flake-athon round-3 review. It is **real mental clutter but
NOT low-faff**, so it is deliberately *not* bundled with the preview-gate deletion
or the `waitForEvent` reset-gap fix. It changes no runtime behaviour and does not
move robustness — it must never gate those changes. Do it on its own when someone
wants to reduce conceptual weight in the streams error path.

## The clutter

A single concept — "this Durable Object call failed transiently; an idempotent
caller may retry" — has **three different representations** in the codebase, and
`isRetryableDurableObjectAvailabilityError` has to union them via a cause-chain
walk:

1. **Raw workerd flags**, present only at the DO-stub caller inside the worker:
   `error.durableObjectReset | .overloaded | .retryable`
   (`apps/os/src/domains/streams/stream-unavailable.ts:38-46`,
   `isDurableObjectLifecycleError`).
2. **A magic message-string tag** for the capnweb → browser hop:
   `STREAM_UNAVAILABLE_MESSAGE_PREFIX = "stream-unavailable: "`
   (`stream-unavailable.ts:23`), minted by `rethrowStreamUnavailable`
   (`:96-102`) at ~11 sites in `rpc-targets.ts` (572, 593, 608, 639, 658, 665,
   691, 716, 733, 751, 6404) and `agent-collection-durable-object.ts:88`, and
   re-detected by substring match in `isStreamUnavailableError` (`:110-112`),
   consumed at `stream-browser-store.ts:2203`, `onboarding-agent.ts:94`,
   `itx-observability.ts:75`.
3. **A hand-serialized payload** across the native Worker→Worker wake-delivery
   hop: `{ name, message, durableObjectReset, overloaded, retryable }` is
   serialized on one side and rebuilt with `Object.assign(new Error(...), {...})`
   on the other (`stream-subscribers.ts:1586-1596`, plus its serialize
   counterpart).

## The constraint that makes it non-trivial (read before starting)

You cannot just "replace the string tag with a clean `retryable: true`
own-property," even though it looks like the obvious cleanup:

- **capnweb (browser hop):** the `@iterate-com/capnweb@0.10.0` fork this repo
  runs **does** preserve own-enumerable Error properties and the `cause` chain
  (verified by round-trip; note the comment at `stream-unavailable.ts:6-13`
  claiming otherwise is **stale and wrong** — fix it regardless of this task).
  So an own-property works here.
- **native Workers RPC (Worker→Worker hop):** Cloudflare **preserves `message`
  but strips own properties and `cause`**
  (https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/).
  This is exactly why the wake hop (#3) hand-serializes the flags. An
  own-property-only scheme would **regress** every native-RPC hop unless each is
  taught to re-serialize — which is what turns this into a ~7-site refactor with
  a serialization-dependency test, not a one-liner.
- **custom Error subclass name** does NOT survive capnweb (downgrades to
  `Error`), so `instanceof` a custom class is not a usable primitive.

So the honest design space is: pick one internal representation (own-property
`retryable`/`reset`/`overloaded` flags is the natural choice — it's what #1 and
#3 already are), and ensure it is explicitly (re)serialized at **every**
boundary that strips it (the native-RPC hops), keeping `message` human-readable
but no longer *the contract*. The string prefix can then be deleted. Also fold in
audit finding **B2**: split `overloaded` out so it is a distinct
"do-not-retry" signal, never unioned into the retryable set
(Cloudflare: retrying overload worsens it).

## Scope

- Define one small helper set (e.g. `markDurableObjectFailure(error, kind)` /
  `classifyDurableObjectFailure(error): "reset" | "retryable" | "overloaded" |
  null`) that reads/writes own-properties.
- Replace the string-prefix mint/detect (`rethrowStreamUnavailable`,
  `isStreamUnavailableError`, `STREAM_UNAVAILABLE_MESSAGE_PREFIX`) with it.
- Audit every hop where such an error crosses **native Workers RPC** and ensure
  each explicitly serializes/rebuilds the flags (like the wake hop already does);
  add a helper so there is exactly one serialize/rebuild pair.
- Simplify `isRetryableDurableObjectAvailabilityError` — with own-props +
  capnweb's `cause` rehydration, the manual cause-walk shrinks or disappears.
- Add a **round-trip test** pinning that the chosen representation survives BOTH
  the capnweb hop and a native-RPC hop, so a future capnweb/workerd bump can't
  silently regress it.
- Fix the stale comment at `stream-unavailable.ts:6-13`.

## Explicitly out of scope

- The preview-gate deletion and the `waitForEvent` reset-gap fix (their own
  task/PR). This task must not block them.
- Any change to the four retry *shapes* — they are already minimal and correct.

## Exit criteria

- [ ] One own-property-based representation of a retryable DO failure; the
      `stream-unavailable: ` message prefix and its substring detector are gone.
- [ ] `overloaded` is a distinct never-retry signal, not unioned into retryable.
- [ ] Every native-RPC hop that carries the signal (re)serializes it through one
      shared helper; no hop relies on the message string as the contract.
- [ ] A round-trip test pins survival across capnweb AND native Workers RPC.
- [ ] The stale `stream-unavailable.ts:6-13` comment is corrected.
- [ ] Net LOC is negative or flat, and no retry behaviour changed (pure
      representation refactor).
