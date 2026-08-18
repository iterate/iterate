# Kenton Varda on Cap'n Web — issues, PRs, design docs (Collector B)

Harvested 2026-08-18 from `cloudflare/capnweb` (origin/main @ `2de5871421d852c8d5a3db241ce6f5648db3104a`) and GitHub issue/PR threads where kentonv commented (112 threads searched, all kentonv comments dumped verbatim). All blockquotes are verbatim Kenton unless noted.

---

### The long-term hibernation design: three composable pieces, all in the Workers runtime, none in Cap'n Web

Source: https://github.com/cloudflare/capnweb/issues/36#issuecomment-4040638107 (2026-03-11)
Context: Issue #36 asks whether Cap'n Web handles DO WebSocket hibernation. A user built a protocol-change hack; Kenton lays out what he actually intends to build.

> In any case, this seems like a cool hack, though a bit different from what I intended as the long-term approach. The solution I'm hoping to build is:
>
> - You would terminate the Cap'n Web session from the browser in a Worker, not a DO. Then you do RPC to a DO on from there. So the DO perceives everything as regular Workers RPC, doesn't know anything about Cap'n Web. This part works great today -- but once you've passed through a stub to or from the DO, it can block the DO from hibernating.
> - A DO would be able to create and return RPC stubs that are marked in such a way that the system knows how to recreate them after hibernation, so their existence doesn't block hibernation.
> - A DO would also be able to store _outbound_ RPC stubs into a space that survives hibernation, e.g. to maintain a list of current subscriber callbacks.
>
> This would all compose nicely to allow hibernation with RPC in general, and Cap'n Web in particular.

Note: The architecture is: browser —Cap'n Web→ stateless worker —Workers RPC→ DO, with hibernatable inbound stubs and a persistent outbound-stub space.

---

### Hibernation is the runtime's job, not the library's

Source: https://github.com/cloudflare/capnweb/issues/36#issuecomment-3334955335 (2025-09-25)
Context: Earlier statement of the same principle.

> I don't think the solution is for Cap'n Web itself to try to support hibernation, but rather for us to extend the way hibernation works in the Workers Runtime, so that RPC stubs are hibernatable. What you'd do then is use Cap'n Web between a browser and a stateless worker, which in turn uses Workers built-in RPC from there to the DO. Workers RPC would then need to support hibernating RpcTargets and storing stubs through hibernation.

---

### What blocks a DO from hibernating (and what doesn't)

Source: https://github.com/cloudflare/capnweb/issues/36#issuecomment-3572361727 (2025-11-24)

> Holding a DO stub does not prevent hibernation. So if, in your stateless routing worker, you return the DO stub itself to the client over Cap'n Web, that in itself shouldn't prevent hibernation. It's only while calls are active that it won't be able to hibernate. Or if you hold stubs pointing at functions or RpcTarget objects in the DO's isolate.

---

### Reconnection: the unanswered design question is what happens to session state

Source: https://github.com/cloudflare/capnweb/issues/58#issuecomment-3341017635 and #issuecomment-3416909653 (2025-09/10)
Context: WebSocket transport aborts the session on close; user asks for healing connections.

> Hmm, what are you imagining should happen to the session state on a reconnect? That is, what happens to stubs that were passed over the connection before the disconnect?
>
> Possibilities include:
>
> - They are all just broken. Only the "main" stub is reconnected.
> - The client reconnects to the same server as before, where the session state still exists in memory, so that it can be resumed without losing anything.
> - On reconnect, the system automatically recreates all stubs by replaying the same calls that created them the first time.

> Yes, you can use `onRpcBroken()` to detect when the connection is lost. And from that you should be able to implement various approaches to handling this. I could imagine having something more batteries-included, but it's not entirely clear what the behavior should be (see my previous comment).

Note: Replay-on-reconnect (option 3) is the same shape as his hibernation plan: recreate stubs by replaying the calls that made them.

---

### Stub lifetimes through stateless hops: the dup() contract, and the Workers-RPC bridging bug

Source: https://github.com/cloudflare/capnweb/issues/110 (comments 2025-11-07 through 2026-01-17)
Context: Bidirectional callbacks through worker→DO kept dying with "RPC stub used after being disposed" even after dup().

> Stubs received in the parameters of an RPC call are automatically disposed when the call returns. If you want to keep the stub around beyond that, you need to `.dup()` it and store the duplicate.

> You don't need `new RpcStub` here: `callback` is already an `RpcStub`. This is probably causing problems: you are creating a second `RpcStub` that wraps the original stub. Then you call `.dup()`, but only on the outer wrapper. This creates a duplicate of the wrapper, but not of the thing that it is wrapping. The inner callback still gets disposed when the method returns, and thus you still get the "stub used after being disposed" error.

> I believe the problem described in this thread is actually not a problem with Cap'n Web itself, but instead a bad interaction between Cap'n Web and Workers built-in RPC. The callback is being forwarded through a stateless worker which routes to the DO. At that stage it is being converted from Cap'n Web to built-in RPC. Currently there's a bug in the lifetimes here: the built-in RPC call does not know that it needs to dup() the Cap'n Web stubs that it receives.
>
> So why you are dup()ing the stub in the Durable Object, that stub is pointing to an object in the router worker, which is _not_ being duped, and so still gets disposed as soon as the call returns.

His interim workaround (subscription calls that don't return until disconnect):

> A hacky work-around I've been using is to have subscription functions not return until the client disconnects.
>
> ```
> async subscribe(callback) {
>   this.subscribers.add(callback);
>   return new Promise((resolve, reject) => {
>     callback.onRpcBroken(error => {
>       this.subscribers.delete(callback);
>       reject(error);
>     });
>   });
> }
> ```
>
> This way you don't have to dupe the callback. This is pretty ugly but it is getting the job done for the moment.

Note: The real fix landed in workerd PR #5733, gated behind compat flag `rpc_params_dup_stubs` / compat date 2026-01-20.

---

### Why args are auto-disposed and returns transfer ownership — and why he's "not thrilled"

Source: https://github.com/cloudflare/capnweb/pull/27#discussion_r2383704688 (2025-09-27)
Context: kumavis's failing test — returning a pipelined arg unchanged gives double-ownership.

> So, there's an ownership problem here:
>
> - Any stubs in an RPC's params are owned by the caller. They will be auto-disposed upon return.
> - Returning a stub from an RPC transfers ownership to the caller.
>
> But this means that when you `return arg` here, the caller now has double-ownership. What ends up happening is, the parameter is disposed upon return, but that means that the returned value is now invalid. You can solve this by: `return arg.dup();`
>
> I'll admit I'm not thrilled with this state of affairs. But I don't know what else we can do. It's important that args are auto-disposed upon return, because otherwise stubs that the callee wasn't expecting to receive will always be leaked. It's also important that returns transfer ownership, because otherwise it's difficult to dispose a stub _after_ returning it.

---

### Unawaited call promises are pipelining references — dispose them, and ALWAYS attach .catch()

Source: https://github.com/cloudflare/capnweb/pull/154#issuecomment-4263999446 (2026-04-16)
Context: A "memory leak" report that was really an unawaited callback invocation.

> It is very much an intentional part of the protocol design that if you don't await a call promise, the result is not "pulled", and so never proactively sent from the server. The idea is that you now have a reference to the remote result which you can do promise pipelining on, without actually having to transmit it back. You need to dispose your reference (which is the promise itself) when you are done with it.
>
> [...] However, this is still problematic, because in this usage pattern, you are ignoring errors. If you ignore errors, then there are all sorts of ways your callback _might not run at all_ without you realizing it. If there was a network error, or a serialization error, or any number of other bugs, these would all just be silently ignored.
>
> For this reason, you REALLY need to attach a `.catch()`:
>
> ```ts
> callback(Date.now()).catch((err) => console.error(err));
> ```
>
> This also has the side effect of pulling the callback result, so resolves your memory leak.

---

### The Promise.race() leak that ate whole messages ("O. M. G.")

Source: https://github.com/cloudflare/capnweb/issues/158#issuecomment-4264399539 and pull/154#issuecomment-4264422031 (2026-04-17)
Context: workerd OOMing under high payload volume on a shared WS session. Root cause: `Promise.race` never unregisters listeners.

> Opus 4.7 analyzed this and concluded it's actually due to the Promise.race() memory leak fixed by #154. Apparently, the leak actually leaks not just promise nodes but the entire received messages. OMG.

> The reason it works on Node and not workerd is only because Node doesn't use pointer compression and as such is able to reach larger heap sizes. If you make the test run longer it should eventually crash Node too.

> I'm sort of losing my mind over the Promise.race memory leak. It's actually leaking the entire messages!

Note: Session read loops that `Promise.race(receive(), abortPromise)` against a session-long abort promise accumulate listeners forever; use a fresh cancellation promise per read.

---

### HTTP batch sessions: build the whole batch with zero intervening awaits

Source: https://github.com/cloudflare/capnweb/issues/26#issuecomment-3331029843 (2025-09-24)

> The problem is when you use `newHttpBatchRpcSession()`, you must then construct your entire batch immediately, _without_ doing any awaits -- even unrelated awaits -- in the meantime. This is because the batch is sent on the next tick.
>
> In your second example, you awaited a promise from the WebSocket after creating the batch, but before using it. So what happened is, the batch was actually sent empty, and then your attempts to use it after that correctly threw "Batch RPC request ended.".

---

### Structuring a large API: nested RpcTargets, getter properties, and the `api.orders()` resource leak

Source: https://github.com/cloudflare/capnweb/issues/71#issuecomment-3356974011 (2025-10-01)

> Right, with Cap'n Web there's no need to have a single flat list of all methods. You can have a top-level class that contains properties or methods representing categories, each pointing at an inner object that implements that part of the API.
>
> PROTIP, though. [...] `api.orders()` returns a stub, and that stub is never being disposed. Instead you want to do:
>
> ```ts
> using orders = api.orders();
> await orders.newOrder();
> ```
>
> [...] But alternatively, you could use properties instead of methods [...] Note that when implementing the API, you MUST actually define these properties using property getters. This signals to the RPC system that these properties are actually intended to be exposed (they are not private internals) [...] And there's no resource leak, since accessing a property (as opposed to calling a method) does not created a stub.

---

### How "one round trip" works: messages don't take turns

Source: https://github.com/cloudflare/capnweb/issues/86#issuecomment-3416846018 (2025-10-17)

> `getByName()` sends a message, and then `hello()` seconds a second message, and the `await` sends a third message (to "pull" the result).
>
> These messages are all sent in rapid succession, without waiting for any response from the server in between. The two directions of a WebSocket stream are totally asynchronous; they do not need to "take turns".
>
> It's technically true that there is some small amount of time (maybe a microsecond) between the messages being sent [...] But these times are usually negligible compared to the network latency. So, when talking about "round trips", we round all this CPU time to zero.

---

### Custom serializers are "an enormous security footgun"

Source: https://github.com/cloudflare/capnweb/pull/155#issuecomment-4253959296 (2026-04-15)
Context: Suggestion to make custom serialization a public API before adding built-in types.

> No absolutely not. Lettings apps add custom serializers is an enormous security footgun that has been a disaster for e.g. Java serialization.

---

### Blob support: the e-order compromise, written into the code comments

Source: https://github.com/cloudflare/capnweb/pull/155#discussion_r3150626030 (2026-04-27); shipped comment now in src/serialize.ts @ 2de5871
Context: Blobs can only be read asynchronously; there's no API to construct a Blob from a stream.

> ```
> // Unfortuntaely, even though Blobs can only be read asynchronously, there is no way to create
> // a blob backed by an asynchronous source; the bytes MUST all be provided upfront. This
> // effectively makes it impossible to manitain e-order when sending Blobs.
> //
> // As a compromise, we deliver a message as if it contained an RpcPromise that resolves to the
> // Blob. This has the effect that the RPC system will wait for the whole Blob to stream in before
> // delivering the message -- reusing the existing machinery for handling promises.
> ```

And the review-level design ruling:

> This is too much complexity to support a relatively obscure type. I think we should simplify:
>
> - Don't optimize small blobs after all. It doesn't actually accomplish what I wanted anyway (maintaining e-order) [...]
> - Don't add special handling of blob promises, reuse RpcPromise infrastructure.

---

### Streams over RPC need real flow control — naive read()/write() RPCs cap you at 40kB/s

Source: https://github.com/cloudflare/capnweb/pull/94#issuecomment-3468353576 (2025-10-30)
Context: Rejecting a contributed streams implementation.

> In order to be efficient over a network connection, it's critical that streams implement flow control. In this implementation, you have converted read() and write() into RPCs that call to the other side. The problem with this is that it means every read and write call will require a network round trip.
>
> Imagine a connection with 100ms of latency (pretty common), and imagine that you are reading/writing 4k chunks (also pretty common). Then, this implementation would only be able to achieve 40kps total bandwidth -- extremely low. We need to arrange for multiple reads / writes to run concurrently. But it's also important not to create _too many_ concurrent requests as this can clog up the socket buffer, creating excessive latency for other RPCs on the same connection.

---

### The streams design he shipped (his own PR #132)

Source: https://github.com/cloudflare/capnweb/pull/132 (PR body, 2026-02)

> When you send a WritableStream over RPC, the remote side gets a WritableStream. They can write to it. If they write faster than the connection can handle, or faster than your app actually consumes the data, they'll experience backpressure.
>
> When you send a ReadableStream over RPC, the RPC system immediately begins reading from the stream and sending the chunks over the wire so that they are already ready for the remote end to read when it starts reading. This again applies backpressure appropriately. Under the hood, we ask the other end to create a "pipe" -- exposing a WritableStream back to us -- and then we pump chunks into that stream.
>
> The flow control is at present based on a fixed window size of 256kb per WritableStream.

Note: Follow-up comment: "Update: I went ahead and added adaptive window size adjustment!"

---

### Transport encoding levels: the four levels, in his words

Source: https://github.com/cloudflare/capnweb/pull/133#issuecomment-3892024290 (2026-02-12); final names in README.md @ 2de5871 lines 816–822
Context: Rejecting a `WireFormat` hook in favor of transports declaring how much encoding Cap'n Web should do.

> Instead of giving the system a `WireFormat` hook, what if you could declare that your transport wants to send and receive messages in JS object format rather than string format. [...] Actually I could imagine we have multiple levels of encoding:
>
> - string: JSON encoding applied already.
> - JSON-ready: JS object, but all contents are JSON-compatible.
> - JSON-ready + Uint8Array: JS object except bytes are kept in Uint8Array format, for encoders that support that.
> - Structured clone: JS object that is structured clonable. The system only applies encoding to RPC stubs. We could change the MessagePort transport to use this.

---

### Receiver-side resource limits: depth budgets must not reset, and hex bigints are O(n)

Source: https://github.com/cloudflare/capnweb/pull/185 review discussions (2026-06-02)

> I actually don't think call arguments should reset the limit. Otherwise that still allows a stack overflow with extremely nested calls. FWIW matching the sending side is not a priority. The sending side applies a limit only to catch cycles and avoid going into an infinite loop.

> Hmm, I'm tempted to allow, and maybe even _require_, the hex format, because it'll obviously be much more efficient to parse. Parsing hex is strictly O(n) so you might even argue we don't need a limit then (though we might as well keep it anyway).

> Feels like it would benefit the underlying transport to know about message size limits so that it could avoid even reading more bytes than the limit into memory.

---

### Serialization-type design review: Maps, Sets, identity, and pipelining

Source: https://github.com/cloudflare/capnweb/pull/99#issuecomment-3493964832 and #issuecomment-3523856124 (2025-11)

> - Map/Set: There are a couple issues to work through here:
>   - Object-typed keys are supposed to match by identity, not value. However, serialization loses identity. So an object-typed key becomes sort of nonsensical. Should we disallow them? [...]
>   - Should we support promise pipelining on maps and sets?
>   - If so, should we also support `.map()` on maps and sets?

> I actually don't think we necessarily have to support this! It's a bit weird in that you have to know, in advance, that the map will contain some particular key. [...] In fact, I'd argue that supporting `.map()` is much more useful than supporting pipelining on an individual key. It's the same for arrays -- you _can_ pipeline on an array element, but it's awkward to do so, since you usually don't know the size of the array until it has actually returned to you, so how do you know which indexes are valid? Usually, though, what you really want is to apply the same operation on every element -- hence, `.map()`.

And on map keys (PR #229, 2026-08-12):

> It makes very little sense to use map keys that use identity-equality since there is no way to pass identity over the wire (since we intentionally don't support aliasing or cycles). So it might make sense to say that map keys can only be primitives. [...] what if you have multiple promise-keys in the same set or map which subsequently resolve to the _same_ primitive value? Awkward! So yeah I think we definitely should not support promises in sets or as map keys.

---

### Third-party handoff: forward vs. reverse gifting, gift chains, and why it matters for DO routing

Source: https://github.com/cloudflare/capnweb/pull/43#issuecomment-3340913924 (2025-09-27)
Context: Response to kumavis's OCapN-style 3PH sketch. Long excerpt — this is the densest 3PH design text he's written publicly.

> But, we need to think carefully about the protocol design before jumping to an implementation. [...] First, Cap'n Proto also implements 3PH, and we'd like to bridge Cap'n Web to Cap'n Proto, so we'll want them to agree on how it works. [...]
>
> Third, sending the locator with the "gift" is not always ideal. Sometimes you want the capability's provider to be the one that initiates the connection to the recipient. In particular, this is commonly true in tail-calling scenarios [...]
>
> On the other hand, imagine we re-arrange the protocol such that instead of Alice sending "redeemGift" to Carol, we have Carol send "provideGift" to Alice. [...] In this case, we probably expect (b) is always greater that (a). But (b) is what we want. We win!
>
> But the standard gifting model is still best when sending a capability, as opposed to making a call. That is:
>
> - For "exports", the standard gifting model is best.
> - For "questions", the reverse gifting model is best.
>
> Fourth, there is an issue with gift chains. [...] Now our total time is the sum of round trips Alice<->Bob, Alice<->Carol, Alice<->Dave. Yuck! We want a single loop Alice->Bob->Carol->Dave->Alice. [...] We can optimize this: Bob can tell Alice: "Expect that _someone_ will give you a gift with this swissnum." And then Carol never contacts Alice at all, but rather instructs Dave to send the gift to Alice.
>
> This stuff actually matters for Cloudflare Workers, in particular for Durable Object routing. (Cap'n Proto's implementation of 3PH actually covers this already.)

---

### Native Promise should just become RpcPromise; the constructor is a local-loopback RPC

Source: https://github.com/cloudflare/capnweb/issues/146#issuecomment-4617900167 (2026-06-04) and pull/242#discussion_r3770837584 (2026-08-12)

> FWIW, I think we actually should support native Promise by just wrapping it in RpcPromise and then treating it like any other RpcPromise. Should be easy, possibly easier than actually fixing the types to reject native Promise...

His suggested README text for `new RpcPromise(promise)` (PR #242):

> Wrapping a `Promise<T>` in this way is semantically identical to creating a local-loopback RPC and then invoking it. That is:
>
> ```ts
> // this...
> let rpcPromise = new RpcPromise(myPromise);
>
> // is semantically the same as this...
> let rpcFunc = new RpcStub(() => myPromise);
> let rpcPromise = rpcFunc();
> ```
>
> In other words, this means:
>
> - The result of the promise must be serializable.
> - If the promise resolution contains `RpcTarget`s or `Function`s, the `RpcPromise`'s resolution will replace them with stubs.
> - Ownership of any stubs in the Promise result is transferred away. If you want to keep your own copies, you need to `dup()` them.
> - If the promise rejects, the rejection propagates to all pipelined calls.

---

### Validation: validate incoming only; plain TypeError; explicit validateStub

Source: https://github.com/cloudflare/capnweb/pull/169 comments (2026-06)

> We've always made clear that all public string-named prototype methods are available over RPC. If people want local-only methods they need to be symbol-named, but in practice I don't remember ever having a need for this.

> We might want to just use `TypeError` here as non-standard errors will lose their type when serialized and will end up being just `Error`. I don't really feel like custom errors are that useful anyway.

> I think in many cases this client-side validation is not really needed since the client fully trusts the server. So I'm not sure it's desirable to make it automatic. I would say we should give people an explicit way to add the validation, like: `let stub = validateStub<T>(newWebSocketRpcSession<T>(...))`

> I don't think we ever need to validate _outgoing_ values. This is redundant since the recipient will need to validate again on its end for security.

Note: Also (issue #39): "Ideally, what we're really hoping to do is auto-generate runtime type checks directly from TypeScript types."

---

### RpcTarget exposes prototype methods, not own properties; toString() can't cross RPC

Source: https://github.com/cloudflare/capnweb/issues/55#issuecomment-3334761694 (2025-09-25)

> In your code, `myProp` is an "own" property, and so per the policy, it is hidden. If you want it to be revealed over RPC, you can declare a getter [...]
>
> Unfortunately, we cannot support `toString()` over RPC, because `toString()` is not allowed to return a promise -- it must return a plain string. This method is special since it is called implicitly whenever you coerce a value to a string.

Note: The policy itself (README @ 2de5871 line 221): "they can access prototype properties but not instance properties. This policy is intended to 'do the right thing' for typical JavaScript code, where private members are typically stored as instance properties."

---

### The protocol: two tables instead of CapTP's four; IDs never reused; push/pull

Source: capnweb protocol.md @ 2de5871, lines 39–75

> For comparison, in CapTP and Cap'n Proto, there are four tables instead of two: imports, exports, questions, and answers. In this library, we have unified questions with imports, and answers with exports.

> Note that IDs are never reused. This differs from Cap'n Proto, which always tries to choose the smallest available ID. We assume no session will ever exceed 2^53 IDs, so simply assigning sequentially should be fine.

> - The client does not need to send a "pull" message if it doesn't care to receive the results. In practice, if the application never awaits the promise, then it is never pulled. The promise can still be used in pipelining without pulling.
> - Technically, the pushed expression can contain any number of calls, including none. A client could, for example, push a large data structure containing no calls, and then subsequently make multiple calls that use this data structure via "pipelining", to avoid having to send the same data multiple times.
> - [...] "resolve" and "reject" are the same messages used to resolve exported promises [...] Thus, calls and exported promises work the same. This differs from Cap'n Proto, where returning from a call and resolving an exported promise were entirely different messages (with a lot of duplicated semantics).

---

### Why JSON, not binary

Source: capnweb protocol.md @ 2de5871, line 7

> Why not a binary format? While the author is a big fan of optimized binary protocols in other contexts, it cannot be denied that in a browser, JSON has big advantages. Being built-in to the browser gives it a leg up in performance, code size, and developer tooling.

Note: Array escaping (must escape at every level) rationale, issue #68: "it is definitely necessary that arrays be escaped at every level. This is because special types can appear at every level, and are always represented as an array with a type name as the first member."

---

### Why explicit disposal instead of GC

Source: capnweb README.md @ 2de5871, lines 332–346

> Unfortunately, garbage collection does not work well when remote resources are involved, for two reasons:
>
> 1. Many JavaScript runtimes only run the garbage collector when they sense "memory pressure" -- if memory is not running low, then they figure there's no need to try to reclaim any. However, the runtime has no way to know if the other side of an RPC connection is suffering memory pressure.
> 2. Garbage collectors need to trace the full object graph in order to detect which objects are unreachable [...] the garbage collector can only see local objects; it has no ability to trace through the remote graph to discover cycles that may cross RPC connections.
>
> Both of these problems might be solvable with sufficient work, but the problem seems exceedingly difficult. We make no attempt to solve it in this library.

---

### The record-replay .map(): the DSL is the RPC protocol itself

Source: capnweb README.md @ 2de5871, lines 301–307; also the Cap'n Web launch blog (see below)

> Cap'n Web does NOT send arbitrary code over the wire!
>
> The trick here is record-replay: On the calling side, Cap'n Web will invoke your callback once, in a special "recording" mode, passing in a special placeholder stub which records what you do with it. During the invocation, any RPCs invoked by the callback (on _any_ stub) will not actually be executed, but will be recorded as an action the callback performs. [...]
>
> Since all of the not-yet-determined values seen by the callback are represented as `RpcPromise`s, the callback's behavior is deterministic. Any actual computation (arithmetic, branching, etc.) can't possibly use these promises as (meaningful) inputs, so would logically produce the same results for every invocation of the callback.

Blog version of the punchline (blog.cloudflare.com/capnweb-javascript-rpc-library/):

> And because the recording is based on promise pipelining, which is what the RPC protocol itself is designed to represent, it turns out that the "DSL" used to represent "instructions" for the map function is just the RPC protocol itself. 🤯

---

### E-order in the implementation: PromiseStubHook and the embargo TODO

Source: capnweb src/core.ts @ 2de5871 lines 2009–2027 and 2082–2086; src/rpc.ts @ 2de5871 lines 200–207
Context: The code comments that carry the e-order discipline from Cap'n Proto into a JS implementation.

> ```
> // StubHook derived from a Promise for some other StubHook. Waits for the promise and then
> // forward calls, being careful to honor e-order.
> [...]
>   call(path: PropertyPath, args: RpcPayload): StubHook {
>     // Note: We can't use `resolution` even if it's available because it could technically break
>     //   e-order: A call() that arrives just after the resolution could be delivered faster than
>     //   a call() that arrives just before. Keeping the promise around and always waiting on it
>     //   avoids the problem.
> ```

> ```
>   pull(): RpcPayload | Promise<RpcPayload> {
>     // Luckily, resolutions are not subject to e-order, so it's safe to use `this.resolution`
>     // here. In fact, it is required to maintain e-order elsewhere: If this promise is being used
>     // as the input to some other local call (via promise pipelining), we need to make sure that
>     // other call is not delayed at all when this promise is already resolved.
> ```

> ```
>     // TODO: Need embargo handling here? PayloadStubHook needs to be wrapped in a
>     // PromiseStubHook awaiting the embargo I suppose. Previous notes on embargoes:
>     // - Resolve message specifies last call that was received before the resolve. The introducer is
>     //   responsible for any embargoes up to that point.
>     // - Any further calls forwarded by the introducer after that point MUST immediately resolve to
>     //   a forwarded call. The caller is responsible for ensuring the last of these is handed off
>     //   before direct calls can be delivered.
> ```

Note: Also core.ts deliverCall (lines 1220–1226): "WARNING: It is critical that if the promises list is empty, we do not await anything, so that the function is called immediately and synchronously. Otherwise, we might violate e-order."

---

### RpcPayload is a linear type — the copy-avoidance design

Source: capnweb src/core.ts @ 2de5871, lines 679–737 (excerpt)

> ```
> // `RpcPayload` is a linear type -- it is passed to or returned from a call, ownership is being
> // transferred. The payload in turn owns all the stubs within it. Disposing the payload disposes
> // the stubs.
> [...]
> // On the receiving end, when an RpcPayload is deserialized from the wire, the payload can safely
> // be delivered directly to the app without a copy. However, if the app makes a loopback call to
> // itself, the payload may never cross the wire. In this case, a deep copy must be made before
> // delivering the final message to the app. There are really two reasons for this copy:
> // - We obviously don't want the caller and callee sharing in-memory mutable data structures, as
> //   this would lead to vasty different behavior than what you'd see when doing RPC across a
> //   network connection.
> // - Before delivering the message to the application, all promises embedded in the message must
> //   be resolved. This is what makes pipelining possible [...]
> ```

---

### OpenAPI/REST is the wrong model for an ocap API; TypeScript (or Cap'n Proto) is the schema

Source: https://github.com/cloudflare/capnweb/issues/33 (comments 2025-09-23/24/25)

> As I understand it [...] OpenAPI is intended to describe REST APIs. That probably makes it a poor fit for describing object-capability RPC APIs.
>
> Cap'n Web is currently designed to play particularly well with TypeScript, so TypeScript is a natural format for describing it. [...] With that said, if you're really looking for a language-neutral schema format for describing a Cap'n-Web-style API, I have another suggestion: Cap'n Proto. :)

> Hmm, the thing is, Cap'n Web APIs are generally designed and organized completely differently from REST APIs at a deep level, so it seems hard to design a single API that is somehow automagically offered across both protocols. Instead I think you need to design your Cap'n Web API and your REST API as two independent APIs that happen to expose the same functionality. Perhaps the REST API can be implemented on top of the Cap'n Web one (since Cap'n Web is strictly more expressive) [...]

---

### Misc engineering judgments worth keeping

Source: various capnweb threads

On disposal-error allocation cost (PR #245): "This is too expensive. It means every disposal will allocate several objects and acquire a stack trace."

On ownership consistency (PR #241): "When `hook.call()` throws, is disposal of the args the caller's or callee's responsibility? [...] We should be consistent. I think it should always be the callee's responsibility."

On inlining (PR #242): "This one-liner function is only called in one place. Should be inline." / "This function is only called in one place and is not that long. I think the logic should just be inlined. It's easier to read that way."

On trusted publishing (PR #100): "Maybe we can use the new trusted publishing stuff? [...] Then we have no secrets, which feels nice. No secrets = nothing to leak."

On `let` vs `const` (issue #44): "The word 'const' implies 'constant', which is the opposite of a variable, so it weirds me out [...] Meanwhile I don't feel like prohibiting reassignment of a local is all that valuable -- it's a local, the usage is contained to a single function, so who cares really?"

On back-compat traps (PR #139, rejecting a `default`-export probe): "I'm uncomfortable with this fix as it means that if `cloudflare:workers` would never be able to add a `default` export without breaking Cap'n Web users in the wild. We cannot force-update Cap'n Web [...]"

On AI-generated docs (PR #242): "Delete this paragraph. What it's describing is not specific to the RpcPromise constructor [...] Also the way the AI has described it here is probably inscrutable to most humans."

On design-first contribution (PR #94): "For future contributions, I recommend starting by opening a discussion where we can make sure we're on the same page on design details, before writing code."

---

### Cap'n Web launch blog: why RPC's bad reputation is outdated

Source: https://blog.cloudflare.com/capnweb-javascript-rpc-library/ (2025-09, Kenton Varda and Steve Faulkner)

> The merits of RPC have been subject to a great deal of debate. RPC is often accused of committing many of the fallacies of distributed computing. But this reputation is outdated. When RPC was first invented some 40 years ago, async programming barely existed. We did not have Promises, much less async and await. Early RPC was synchronous: calls would block the calling thread waiting for a reply. At best, latency made the program slow. At worst, network failures would hang or crash the program. No wonder it was deemed "broken".
>
> Things are different today. We have Promise and async and await, and we can throw exceptions on network failures. We even understand how RPCs can be pipelined so that a chain of calls takes only one network round trip. Many large distributed systems you likely use every day are built on RPC. It works.
>
> The fact is, RPC fits the programming model we're used to. Every programmer is trained to think in terms of APIs composed of function calls, not in terms of byte stream protocols nor even REST. Using RPC frees you from the need to constantly translate between mental models, allowing you to move faster.

---

### Cap'n Web launch blog: the export-table mechanics, in prose

Source: https://blog.cloudflare.com/capnweb-javascript-rpc-library/ ("RPC protocol" section)

> Each entry in the export table has a signed integer ID, which is used to reference it. You can think of these IDs like file descriptors in a POSIX system. Unlike file descriptors, though, IDs can be negative, and an ID is never reused over the lifetime of a connection.
>
> [...] Each "push" is assigned a positive ID on the export table, starting from 1 and counting upwards. Since positive IDs are only assigned as a result of pushes, Alice can predict the ID of each push she makes, and can immediately use that ID in subsequent messages. This is how promise pipelining is achieved.
>
> [...] In fact, the Cap'n Web implementation will only send a "pull" message if the application has actually awaited the returned promise.
