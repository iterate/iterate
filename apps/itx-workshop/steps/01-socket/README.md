# Step 01 — a method call over a socket

**Adds:** the irreducible primitive. A Cap'n Web session over a WebSocket: the
client holds a typed stub, and calling a method on it runs that method on the
server and returns the result.

```ts
using itx = newWebSocketRpcSession<Server>("wss://.../steps/01-socket");
await itx.whoami(); // → "the itx server"   (ran on the server)
await itx.greet("ada"); // → "hello, ada"   (argument crossed the socket)
```

`using` (TS explicit resource management) disposes the session — closing the
socket — at end of scope.

**The failure it buys you out of:** nothing yet — this is the floor. Everything
from here makes this one socket **bidirectional** (Step 02), **dynamic** (03),
**shared** (04), and so on.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/01-socket/intent.test.ts`.
