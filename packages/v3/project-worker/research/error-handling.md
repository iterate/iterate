# How cloudflare/os manages errors — and what the clean room should steal

Research question (owner): "How does cloudflare/os manage errors? tagged classes? json? what? can we steal it?"

**"cloudflare/os" identified as:** [`github.com/cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os)
(there is no repo literally named `cloudflare/os`). A full checkout lives vendored inside the
starter at `~/src/github.com/cloudflare/cloudflare-os-starter/cloudflare-os/` (its git remote is
the `iterate/cloudflare-os` fork; upstream `cloudflare/cloudflare-os` exists and is public,
HEAD `3562627e`). It's the Kenton-style "Workshop/Gadgets/Gatekeepers" agent platform.
`cloudflare/workspace` is a different thing (a virtual-filesystem-in-a-DO preview) and is not it.

All paths below are relative to that checkout unless absolute.

---

## 1. How cloudflare/os does it

Summary: **plain `Error`s with human messages by default; expected, machine-readable failures are
plain `Error`s with a `code` own-property attached via `Object.assign`, defined once in a shared
module with a `create*`/`get*Code` helper pair.** Tagged subclasses exist but are used _only
in-isolate_ where `instanceof` is safe. There is no JSON error envelope and no HTTP-status
taxonomy for API errors, because the API is capnweb-over-WebSocket — errors propagate as RPC
rejections, not HTTP responses.

### 1a. The load-bearing pattern: `code` own-property, shared-module helpers

`packages/workshop-shared/src/api.ts:254-286`:

```ts
/** Stable error codes attached to expected failures from `AuthenticatedApi.openGadget()`. */
export const OPEN_GADGET_ERROR_CODES = {
  workspaceNotFound: "WORKSPACE_NOT_FOUND",
  workspaceAccessDenied: "WORKSPACE_ACCESS_DENIED",
} as const;

/** Creates an expected `openGadget()` error with a machine-readable code. */
export function createOpenGadgetError(
  code: OpenGadgetErrorCode,
): Error & { code: OpenGadgetErrorCode } {
  return Object.assign(new Error(OPEN_GADGET_ERROR_MESSAGES[code]), { code });
}

/** Reads the machine-readable code from an expected `openGadget()` error. */
export function getOpenGadgetErrorCode(error: unknown): OpenGadgetErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = "code" in error ? error.code : undefined;
  return isOpenGadgetErrorCode(candidate) ? candidate : undefined;
}
```

Key properties of the reader: checks `"code" in error` — **never `error.name`, never
`instanceof`, never message text**. The human message lives in a table next to the codes
(single source for both), so the message stays consistent/greppable but carries no semantics.

This crosses **two hops** and stays classifiable at both ends:

- Thrown in the Overseer **Durable Object** (`packages/workshop-backend/src/overseer.ts:6352`):
  `throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);`
- Read after the **native workers-RPC hop** in the server worker
  (`packages/workshop-backend/src/server.ts:249`):
  `if (getOpenGadgetErrorCode(err) === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied) { ... }`
- Read again in the **browser** after the capnweb WebSocket hop
  (`packages/workshop-frontend/src/components/WorkspaceOpenErrorPage.tsx:33`):
  `switch (getOpenGadgetErrorCode(error)) { case OPEN_GADGET_ERROR_CODES.workspaceAccessDenied: ... }`

### 1b. Tagged subclasses — in-isolate only, with a retry-safety taxonomy

Where a whole error family lives inside one worker, they do use subclasses + `instanceof`,
and the classes carry structured data. `packages/mcp-shared/src/client.ts:111-165`:

```ts
export class McpAuthRequiredError extends Error {
  readonly resourceMetadataUrl: string | null;   // structured payload on the error
  ...
}

// What a failed call is known to have done to the server. ...
export type CallOutcome = "declined" | "unknown";

export class McpProtocolError extends Error {
  readonly code: number | undefined;
  // Defaults to `"unknown"`, so a throw site that has not thought about it is treated as
  // unsafe to retry rather than silently assumed harmless.
  readonly outcome: CallOutcome;
  ...
}

// Whether a failed call might already have taken effect on the server.
// Fails safe: anything this cannot positively identify as declined is treated as possibly
// performed.
export function callMayHaveTakenEffect(err: unknown): boolean {
  if (err instanceof McpAuthRequiredError) return false;
  if (err instanceof McpSessionExpiredError) return true;
  if (err instanceof McpProtocolError) return err.outcome !== "declined";
  return true;
}
```

Two ideas worth keeping even if the classes aren't: (1) the _write-safety_ taxonomy
(`declined` vs `unknown` — "retrying the second kind is how one approval becomes two
writes"), and (2) the fail-safe default in the classifier. Similar in-isolate specimens:
`AgentTurnError` with a `statusCode` field (`workshop-backend/src/ai-invoke.ts:21`) and the
marker class `AiGatewayLogRetryableError extends Error {}` (`ai-gateway.ts:107`).

### 1c. HTTP statuses and retry semantics

- HTTP statuses appear **only at genuine HTTP endpoints** (the non-RPC browser error-report
  endpoint maps to 405/403/415/413/400/204 — `workshop-backend/src/client-errors.ts:95-151`;
  asset serving 404s — `server.ts:593`). There is no error→status mapping layer for the API.
- Retry is **channel-level, not error-payload-level**: the frontend registers
  `stub.onRpcBroken(handleBroken)` and reconnects with capped exponential backoff
  (`workshop-frontend/src/main.tsx:77-119`); the server side detects DO disconnects by
  disposal of a `notifyClosed` callback stub and aborts the session so the client's
  reconnect logic engages (`server.ts:217-241`).
- Observability is a **separate lane**: arbitrary thrown values are folded into a bounded,
  vendor-neutral JSON shape `{type, message?, stack?, truncated?}`
  (`packages/error-reporting/src/serialize-exception.ts:23-68`) for reporting only — never
  for control flow.
- They have exactly one message-sniffing site, and it's apologetic about it: pulling a
  leading HTTP status code out of provider-SDK error text
  (`ai-invoke.ts:35-43`, "the provider SDKs' error messages conventionally begin with the
  status code ... which is enough for the overseer's triage").

---

## 2. How workerd does it (the platform convention)

Two mechanisms, both relevant:

### 2a. Machine-readable prefixes _inside the message_ (the kj tunnel)

The classic tunnel encodes the error type and routing flags as **stable prefixes in the
kj::Exception description**, parsed with `startsWith` — the platform itself does the
"stable prefix in message text" trick. `src/workerd/jsg/exception.c++:20-133`:

```c++
constexpr auto ERROR_PREFIX_DELIM = "; "_kj;
constexpr auto ERROR_REMOTE_PREFIX = "remote."_kj;
constexpr auto ERROR_TUNNELED_PREFIX_JSG = "jsg."_kj;
constexpr auto ERROR_INTERNAL_SOURCE_PREFIX_JSG = "jsg-internal."_kj;
...
// Remove `remote.` (if present). ... allow for multiple "remote." prefixes.
while (internalMessage.startsWith(ERROR_REMOTE_PREFIX)) { properties.isFromRemote = true; ... }
...
while (internalMessage.startsWith("broken.")) { properties.isDurableObjectReset = true; ... }
```

So `remote.remote.jsg.TypeError: msg` = a TypeError tunneled across two hops; a `broken.*; `
prefix = "Durable Object reset". Only a whitelist of types tunnels (Error, RangeError,
TypeError, SyntaxError, ReferenceError, DOMException — `util.c++:181-193`); anything
unrecognized becomes `"internal error; reference = <id>"` (`util.c++:318-351`) so internals
never leak.

### 2b. Stamped boolean own-properties on the JS surface

When a tunneled exception is rehydrated for JS, workerd stamps flags **as own properties on
the error object** — this is the platform's caller-facing taxonomy.
`src/workerd/jsg/util.c++:130-165` defines the setters; `util.c++:220-236` applies them:

```c++
if (result.isFromRemote)                                  setRemoteError(...);        // .remote = true
if (exception.getType() == kj::Exception::Type::DISCONNECTED) setRetryableError(...); // .retryable = true
else if (exception.getType() == kj::Exception::Type::OVERLOADED) setOverloadedError(...); // .overloaded = true
if (result.isDurableObjectReset)                          setDurableObjectResetError(...); // .durableObjectReset = true
KJ_IF_SOME(durableObjectId, ...)                          setDurableObjectIdError(...);    // .durableObjectId = "..."
```

And the **reverse** mapping honors the same props when a JS error crosses back into kj land
(`src/workerd/jsg/value.h:1428-1440`): an error you throw with `.overloaded = true` becomes
`kj::Exception::Type::OVERLOADED`; `.retryable = true` becomes `DISCONNECTED` (the retryable
kind). So the props are readable _and writable_ platform signals.

### 2c. `enhanced_error_serialization` — native RPC preserves own props

Under the `enhanced_error_serialization` compat flag (**default on from compat date
2026-04-21**; `src/workerd/io/compatibility-date.capnp` @115), errors crossing
structuredClone/native-RPC are serialized as host objects carrying tag + custom name (only
when the tag is unknown) + message + **a bag of all own properties**
(`src/workerd/jsg/ser.c++:236-286` write side, `ser.c++:518-581` read side). The read side
even restores a custom `name` via `defineProperty`, with this comment (`ser.c++:544-550`):

```c++
// ... It is not possible for us here to clone the exact error class that was used,
// so instanceof checks will not work as expected. But, that's ok.
```

Stacks are deliberately **not** restored across untrusted boundaries
(`preserveStackInErrors`, `util.c++:272-277`).

Note for cloudflare-os itself: workshop-backend pins `compatibility_date: 2026-02-02`
(before the flag's default date, flag not set explicitly), so its `.code` read after the
native DO hop technically depends on behavior that predates full own-prop transport. **Our
clean room pins `2026-07-01`** (`packages/v3/*/wrangler.jsonc`), so enhanced serialization
is on and own props definitively survive native hops.

---

## 3. What capnweb preserves in transit (verified from source + runtime)

Checked in `@iterate-com/capnweb@0.10.0` — both the source
(`~/src/github.com/cloudflare/capnweb-authoritative/src/serialize.ts`, v0.10.0) and the
**published dist actually installed in this repo**
(`node_modules/.pnpm/@iterate-com+capnweb@0.10.0/.../dist/index.js` — contains the same
`captureProp` code). Wire form (`serialize.ts:522-591`):

```
["error", name, message]                    // legacy, no extras
["error", name, message, stack|null, props] // when own props exist
```

- Serialize side captures **all own enumerable properties except name/message/stack**, plus
  the (normally non-enumerable) `cause`, plus AggregateError `errors` — each recursively
  devaluated, unserializable ones silently dropped per-property (`serialize.ts:546-577`).
- Deserialize side re-attaches every props-bag key as an own enumerable property, skipping
  `name`/`message`/`stack` and `Object.prototype`-colliding keys/`toJSON`
  (`serialize.ts:917-937`). The class is chosen from a **null-prototype whitelist**
  `{Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
AggregateError}`; unknown names fall back to `Error` (`serialize.ts:212-219, 908-913`).

Runtime round-trip proof (real MessagePort session, this exact package version, a custom
`ConflictError extends Error` with `name`, `code`, `data`, `cause`):

```
constructor      : Error                          <- subclass identity LOST
name             : Error                          <- custom name LOST (coerced to builtin)
message          : idempotency key already used   <- preserved
code             : IDEMPOTENCY_CONFLICT           <- PRESERVED
data             : {"retryable":false,"existingId":"evt_123"}  <- PRESERVED, recursively
cause            : RangeError: inner cause        <- PRESERVED (rehydrated as builtin)
stack transmitted: false                          <- NOT sent (opt-in via onSendError only)
own keys         : code,data,cause
```

Exact survival list, in one line: **message ✓, own enumerable props ✓ (recursive, may
contain nested errors/stubs), `cause` ✓, AggregateError `errors` ✓; custom `name` ✗
(coerced to a builtin), subclass identity ✗, stack ✗ by default (send-side `onSendError`
hook can opt a redacted stack in).**

This confirms the earlier finding ("capnweb drops error.name") _and_ overturns its
implication: the `name` channel is dead, but the **own-property channel is fully open**.

---

## 4. Recommendation for the clean room

Steal cloudflare-os's `code`-property pattern verbatim. It is the only convention in this
survey that is (a) already proven in cloudflare-os across the same two hops we have
(DO —native RPC→ worker —capnweb→ client), (b) verified above to survive our exact capnweb
0.10 dist, and (c) blessed by workerd itself ("instanceof checks will not work ... that's
ok"). Concretely, and small:

1. **One shared module** (e.g. `src/core/errors.ts`), mirroring `workshop-shared/api.ts`:

   ```ts
   export const ERROR_CODES = {
     noCapabilityMatch: "NO_CAPABILITY_MATCH",
     idempotencyConflict: "IDEMPOTENCY_CONFLICT",
   } as const;
   export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

   /** Plain Error + code own-property; `data` for structured extras (both survive both hops). */
   export function codedError(code: ErrorCode, message: string, data?: Record<string, unknown>) {
     return Object.assign(new Error(message), { code, ...(data && { data }) });
   }

   export function errorCode(error: unknown): ErrorCode | undefined {
     if (typeof error !== "object" || error === null) return undefined;
     const c = "code" in error ? (error as { code?: unknown }).code : undefined;
     return (Object.values(ERROR_CODES) as unknown[]).includes(c) ? (c as ErrorCode) : undefined;
   }
   ```

   No subclasses across hops; no error registry framework; codes are SCREAMING_SNAKE string
   literals. Human message text stays exactly as it is today (still greppable) — it just
   stops being the classification channel.

2. **Replace the two regex sites:**
   - `stream-durable-object.ts:138` — throw
     `codedError("IDEMPOTENCY_CONFLICT", idempotencyConflictMessage(...), { existingOffset })`
     instead of `new Error(idempotencyConflictMessage(...))`. Callers that today grep the
     message switch to `errorCode(err) === "IDEMPOTENCY_CONFLICT"` and can read
     `err.data.existingOffset` structurally.
   - `iterate-context-stream-processor.ts:159` — same message, wrapped in
     `codedError("NO_CAPABILITY_MATCH", ...)`.
   - `processor-facet.ts:185` — replace
     `/no capability matches/.test(message) ? 404 : 500` with a tiny code→status map at the
     door: `{ NO_CAPABILITY_MATCH: 404 }`, default 500. HTTP mapping lives **only** at this
     HTTP boundary, matching cloudflare-os (statuses only at genuine HTTP endpoints).

3. **Honor workerd's stamped flags on the read side** instead of inventing our own retry
   taxonomy: `err.retryable` (disconnected — retry), `err.overloaded` (back off),
   `err.durableObjectReset` (+ `err.durableObjectId`), `err.remote` are already stamped by
   the runtime on native-RPC errors. Bonus: if we ever need to _signal_ retryability from
   our own throws over native RPC, setting `.retryable = true` / `.overloaded = true` maps
   back into the kj exception type (`value.h:1428-1440`) — it's a two-way platform channel.
   (Caveat: these flags are workerd-native-RPC semantics; across the capnweb client hop they
   travel only as ordinary own props — still readable, just not runtime-interpreted.)

4. **Do not** rely on `error.name`, subclass identity, or message regex across any hop
   (all proven lossy). `instanceof` stays fine strictly in-isolate, as in `mcp-shared`.
   If a write-path error family ever appears (webhook/side-effect dispatch), copy the
   `outcome: "declined" | "unknown"` fail-safe taxonomy from
   `mcp-shared/src/client.ts:128-165` as a `data` field rather than a class hierarchy.

Nothing else from cloudflare-os is needed: no JSON envelope, no status-code enum, no error
base class. The whole steal is ~30 lines in one module plus three call-site edits.
