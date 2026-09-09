# Kenton Varda — WebSockets, hibernation, sockets (Collector A)

Verbatim harvest from cloudflare/workerd. workerd main @ `479771c30d10a04f468c68f80714cbf4c34b9d85` (2026-08-17).

### Hibernatable RPC targets: acknowledged as a planned, big project

Source: https://github.com/cloudflare/workerd/issues/6087#issuecomment-3962391382
Context: Issue asking for `RpcTarget`s that survive DO eviction (capnweb hibernation inside DOs).

> Yes, this is something I plan to work on, perhaps next quarter. It's a big project, though.

Note: The issue body (by nwpr) is a good statement of the gap: capnweb listeners pin the isolate; client-held RPC references cannot survive DO hibernation; runtime must "bridge isolate lifecycle transitions without invalidating RPC targets."

### Outgoing WebSocket hibernation is not symmetric with incoming

Source: https://github.com/cloudflare/workerd/issues/4864#issuecomment-3215172889
Context: Feature request to make `ctx.acceptWebSocket()` work for outbound `new WebSocket(url)` connections.

> This is something we definitely want to support, but it requires some deep architectural changes. It's not a simple matter of applying the same logic from incoming connections to outgoing, unfortunately.

### allowHalfOpen belongs at creation time (constructor/accept), not a mutable property

Source: https://github.com/cloudflare/workerd/pull/6197#discussion_r2884868348
Context: Review of the PR making server WebSocket close fire a close event by default.

> I'm not sure this should be a property at all. It seems weird (and race-y, as noted) to be able to turn this on and off at arbitrary moments.
>
> Both Node's net API and Workers' Socket API present `allowHalfOpen` as an option specified at creation time (to the constructor, or to `connect()`).
>
> With WebSocket, of course, we have the problem that the app doesn't always get to control construction. But the app does always _either_ use the constructor directly _or_ call `accept()`. Perhaps the right API would be for this to be an option to both the constructor and to `accept()`?

### Standard behavior should be the default when an escape hatch exists

Source: https://github.com/cloudflare/workerd/pull/6197#discussion_r2884262057
Context: Same PR; on whether auto-close-reply should be the compat-date default.

> I think that as long as we provide the option to support half-open then the standard behavior should be the default.
>
> Also I think our Sockets API also only allows half-open when explicitly told, and all the same arguments apply there, so this is consistent.

### Pass-through proxying: the runtime, not the app, owns half-open behavior

Source: https://github.com/cloudflare/workerd/pull/6197#discussion_r2884876977
Context: Same PR.

> Note this implies also that if you are _not_ terminating the WebSocket in the worker but just passing it through, you don't get to control `allowHalfOpen`. That makes sense. The runtime should do the appropriate thing for proxying in the pass-through case.

### Compat flags should be non-disruptive: updating your compat date shouldn't create spurious errors

Source: https://github.com/cloudflare/workerd/pull/6197#discussion_r2895915928
Context: Same PR; asking for a test that a redundant close() after auto-reply is silently ignored.

> Can we verify that if the client attempts to call `close()` after the automatic close handshake has already occurred, it is silently ignored (doesn't throw an error)?
>
> I think this is what the spec says is supposed to happen [...]
>
> I think it's important because otherwise this compat flag may be disruptive for people who are already manually handling close replies today -- I don't want them to start getting spurious exceptions. Yes, it's guarded by a compat flag, but even so we ideally want it to be non-disruptive to update your compat date most of the time.

### Constructor args vs accept() options for non-standard extensions

Source: https://github.com/cloudflare/workerd/pull/6197#discussion_r2895961173
Context: Same PR; whether the `allowHalfOpen` opt-out should also exist on `new WebSocket()`.

> Argument against:
>
> - Probably people using the constructor aren't doing proxying and have little reason to keep the WebSocket half-open.
> - Probably people using the constructor expect standard behavior in general.
> - If someone is actually stuck in this case, the solution is for them to switch to using fetch() and then accept() the resulting webSocket, which is not _that_ bad. (We definitely need to document this carefully though.)
> - It's weird to put a non-standard argument on the constructor which could conflict with future standards changes adding a new argument.
>
> I guess I lean towards not adding a constructor param, but again, we need to document carefully. Let's make sure we have a documentation PR lined up before landing this.

### `whenWriteDisconnected()` is not guaranteed to resolve — cancel it or it pins the IoContext

Source: https://github.com/cloudflare/workerd/pull/5650#discussion_r2600058674
Context: Community PR fixing DOs taking ~2 minutes to shut down after TCP socket use; Kenton corrects the TIME_WAIT theory.

> Are you sure the 2 minutes is from TCP TIME_WAIT and not simply the DO eviction timeout? A DO will shut down automatically when it has had no clients for 70s-140s (the exact timeout varies). So if `whenWriteDisconnected()` simply never resolved at all, you'd presumably expect to see the DO shut down after 1-2 minutes. I also would not expect `whenWriteDisconnected()` to be affected by TIME_WAIT since TIME_WAIT is handled entirely in the kernel and not normally exposed to the application at all.
>
> [...] I suspect this actually isn't TIME_WAIT and what the comment should really say is:
>
> > `whenWriteDisconnected()` is not guaranteed to return. Since we've closed the socket we might as well cancel waiting on it, so that it doesn't hold open the IoContext.

### Discovered in the same thread: socket.close() didn't actually close the socket

Source: https://github.com/cloudflare/workerd/pull/5650#issuecomment-3628981959 and #issuecomment-3662754093
Context: Kenton auditing the Socket implementation while reviewing.

> Actually it strikes me that `close()` doesn't appear to be dropping the underlying KJ stream, and so the underlying socket presumably _isn't being closed_?
>
> [...] AFAICT the `connectionStream` member of `Socket` isn't nulled out anywhere or anything like that, so it'll live until either the `Socket` is GC'd or the `IoContext` shuts down (since it's an `IoOwn`. Does that mean that sockets simply don't get closed at all until one of those things happen, regardless of whether the user calls close()?

> Actually not just a test. Per my comments above, it looks like `socket.close()` _does not actually close the socket_. The change in this PR helps but doesn't fully fix the issue.

### WebSocket send-failure state must be set synchronously, before another pump can start

Source: workerd@029973ceee19f35c1c52b3b8087e33315d00b2f3 (commit message, 2025-01-20)
Context: 'Fix Sentry error: "expected !currentlySending; another message send is already in progress"' — a model example of async state-machine hygiene.

> If writing to the underlying KJ WebSocket throws an exception or is canceled, then the WebSocket is left in an inconsistent state and no further messages can be sent. [...]
>
> The problem is, we weren't actually setting `outgoingAborted = true` until `reportError()` was invoked, which is a few microtasks after the point where `pump()` ended. In the meantime, a new `send()` could be invoked, starting a fresh `pump()`, which would then fail with the `expected !currentlySending` error.
>
> [...] I was unable to reproduce the problem in a test, though [...] Nevertheless, it is quite clear that we need to set `outgoingAborted = true` promptly when a send fails, before anyone else could possibly begin another pump. So, this commit does that.

### 101-status Responses: allow exactly when a webSocket is attached

Source: https://github.com/cloudflare/workerd/issues/3047#issuecomment-2468719265
Context: Rewriting a WebSocket Response threw "status codes must be 200-599".

> @jasnell the ask is NOT to support 1xx in general. The problem here is that `fetch()` itself returns a `Response` with status 101 when the response is a WebSocket response, and attempts to rewrite that response (e.g. change a header) fail because we throw an exception about not supporting 1xx status codes.
>
> This is a bug which we should fix. We should simply say that if the `Response` is specifically a WebSocket response (its `webSocket` property is non-null), then we allow it to have status 101.

### bufferedAmount: trivially the sum of queued outgoing messages

Source: https://github.com/cloudflare/workerd/issues/988#issuecomment-1673291731
Context: Backpressure feature request for WebSocket.

> I think `bufferedAmount` could trivially be implemented to add up the size of all messages in [`outgoingMessages`]. [...]
>
> WebSocketStream seems like a good idea, and given that it reuses the Streams API it might not be too difficult to implement? [...] But I guess it's not a standard yet.

### Undocumented compat-flag change → CI now blocks default-on dates without an approved docs PR

Source: https://github.com/cloudflare/workerd/issues/6615#issuecomment-4289731646
Context: Outbound WS binary frames silently became Blob; user pipelines broke.

> Sorry about that. This actually is guarded by a compat flag (default-on as of `compatibility_date = "2026-03-17"`), but it failed to get documented. [...]
>
> Since this failure to document changes has happened several times, we recently added a new CI check that blocks landing a PR to add a default-on date to a new compat flag unless a corresponding documentation PR is approved for merge. Unfortunately this particular change happened before we added the check.
>
> From what I can tell the `binaryType` property is implemented and should work for opting into ArrayBuffer behavior.
