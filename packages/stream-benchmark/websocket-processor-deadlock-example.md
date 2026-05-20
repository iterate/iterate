# WebSocket Processor Deadlock Example

This note captures the important protocol trap for stream processors that both
subscribe to a Durable Object stream and append follow-up events to the same
stream.

## The Concrete Timeline

Assume a processor is subscribed over one WebSocket connection. It has already
processed through offset `99`, and its live runner receives event `100`.

The stream now looks like this:

```text
99   last completed processor event
100  event currently being handled by afterAppend
101  already committed, waiting in the socket/client queue
102  already committed, waiting in the socket/client queue
103  already committed, waiting in the socket/client queue
```

The runner enters `afterAppend` for event `100`.

Inside that hook, the processor decides to append a follow-up event and needs the
server-assigned offset immediately:

```text
afterAppend(100)
  await streamApi.append(followUpEvent)
```

Because offsets are assigned by the Durable Object at commit time, the follow-up
event is not `101`. Offsets `101`, `102`, and `103` already exist. The follow-up
event becomes `104`.

The stream is now:

```text
100  event currently being handled by afterAppend
101  already committed backlog
102  already committed backlog
103  already committed backlog
104  follow-up event appended by afterAppend(100)
```

## The Deadlock

The broken implementation is:

```text
streamApi.append(event)
  send append command over WebSocket
  wait until subscribe() yields the committed event
  return that event
```

That deadlocks because the only consumer of `subscribe()` is still blocked inside
`afterAppend(100)`, awaiting `streamApi.append(...)`.

The runner cannot advance to `101`, `102`, `103`, or `104` until
`afterAppend(100)` completes. But `afterAppend(100)` cannot complete until
`streamApi.append(...)` resolves. If append resolution waits for the subscription
iterator to deliver `104`, nothing can move.

The already-committed backlog makes the bug more obvious: even if the WebSocket
has event frames buffered, the processor's ordered hook loop is deliberately not
allowed to process them while a previous `afterAppend` is pending.

## The Required Protocol Split

The WebSocket protocol needs two independent lanes on the same socket:

```text
Command/ack lane:
  client -> server: append request with request id
  server -> client: append ok/error with same request id

Event lane:
  server -> client: committed stream events for ordered consumption
```

For example:

```json
{ "id": "a1", "op": "append", "event": { "type": "follow-up" } }
```

The Durable Object commits immediately and replies on the command/ack lane:

```json
{
  "type": "append/ok",
  "id": "a1",
  "event": {
    "streamPath": "/example",
    "offset": 104,
    "createdAt": "2026-05-20T12:49:00.000Z",
    "type": "follow-up"
  },
  "committed": true
}
```

It may also broadcast the same committed event on the event lane:

```json
{
  "type": "event",
  "event": {
    "streamPath": "/example",
    "offset": 104,
    "createdAt": "2026-05-20T12:49:00.000Z",
    "type": "follow-up"
  }
}
```

The append promise resolves from `append/ok`, not from the `event` frame.

## Runner Invariant

The processor runner should keep `afterAppend` sequential:

```text
process event 100
  reduce 100
  save reduced state through 100
  await afterAppend(100)
  save afterAppend completed through 100

process event 101
  reduce 101
  save reduced state through 101
  await afterAppend(101)
  save afterAppend completed through 101
```

That invariant should hold even under load and even when many event frames are
already buffered.

The WebSocket reader can continue receiving frames while `afterAppend(100)` is
pending, but it must demultiplex them:

```text
append/ok frame for request a1 -> resolve that append promise immediately
event frame for offset 101      -> enqueue for ordered processor consumption
event frame for offset 102      -> enqueue for ordered processor consumption
event frame for offset 103      -> enqueue for ordered processor consumption
event frame for offset 104      -> enqueue for ordered processor consumption
```

This gives the processor the offset for its own append immediately, while still
preserving ordered `afterAppend` execution for committed stream events.

## Rule Of Thumb

Never implement `streamApi.append()` by waiting for the appended event to appear
from `subscribe()`.

`append()` is a correlated RPC that returns the committed event from an ack frame.
`subscribe()` is an ordered event delivery mechanism that drives processor
reduction and `afterAppend` execution. They can share one WebSocket, but they
cannot share one completion condition.
