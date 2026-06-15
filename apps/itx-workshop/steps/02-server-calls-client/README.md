# Step 02 — the server calls the client

**Adds:** bidirectionality. Cap'n Web stubs pass as arguments in _either_
direction, so the client can hand the server a live object and the **server**
calls methods on it, back across the same socket.

```ts
using server = newWebSocketRpcSession<RegisterServer>(url);
await server.register({ compute: async (a, b) => a * b });
// server runs: laptop.compute(6, 7) → "the laptop computed: 42"   (ran on the client)
```

A capability is just an object reference that happens to point across a socket —
and it points both ways.

**The failure it buys you out of:** with only client→server calls you can't model
a daemon that _offers_ tools the server invokes. Now you can.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/02-server-calls-client/intent.test.ts`.
