# Step 04 — a Durable Object to live in

**Adds:** rendezvous. The registry moves into a Durable Object addressed by a
constant name, so every connection meets the _same_ registry — and a **live**
capability one client provided is held in the DO, callable by another client on a
different socket and edge isolate.

```ts
// client A: provides a live cap, stays connected
await a.provideCapability("ping", async () => "pong from A");
// client B: a SEPARATE socket, same DO
await b.invoke("ping", []); // → "pong from A"   (A's code ran, called via the DO)
```

Two non-obvious things make the live cross-client cap survive (both in `worker.ts`):

- **`dup()` the stub at the Worker layer** before forwarding to the DO — Cap'n Web
  disposes the argument stub when the `provide` call returns;
- **`ctx.waitUntil`** holds the provider's Worker invocation open for the socket's
  lifetime, so A's stub is still callable when B invokes it later.

`RegistryDO` (`registry-do.ts`) is shared by steps 04–06 — the simple
pre-StreamProcessor registry. Step 07 upgrades this same idea to a StreamProcessor
over a durable event log.

**The failure it buys you out of:** Step 03's per-connection registry — a second
client couldn't see the first's caps. Now they rendezvous in the DO.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/04-durable-object/intent.test.ts`.
