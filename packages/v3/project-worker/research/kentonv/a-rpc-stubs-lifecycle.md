# Kenton Varda — JS RPC: stubs, lifecycle, dup/dispose, serialization, persistent stubs (Collector A)

Verbatim harvest from cloudflare/workerd + workers-sdk. workerd main @ `479771c30d10a04f468c68f80714cbf4c34b9d85` (2026-08-17).

### A stub pointing at a DO must never prevent it from hibernating

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1308030907
Context: Review of the original JS RPC PR; the foundational lifecycle rule for RPC-vs-hibernation.

> I think it's important that the existence of a stub object pointing at it doesn't prevent the DO from hibernating, even if that stub has been used for one or more RPC calls in the past.

### RPC should be designed for mutually distrusting parties: don't let clients probe private methods

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1307970467
Context: On what error to return when a client calls a private (`#`) method.

> IMO in this case we should return exactly the same error as if the method wasn't found. We should design the RPC mechanism to be usable even between workers owned by different people that can't see each other's code, so we should avoid letting the client probe what private methods the server has.
>
> That does mean the error message is not as helpful but I don't think people are likely to call private methods by accident, considering that they are prefixed with `#` in JavaScript syntax.

### Which methods are exposed over RPC: the whole `constructor` / Object-prototype doctrine

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1409945331
Context: Long clarifying comment on why `Object`-inherited properties are blocked but app-declared ones are allowed.

> There are two distinct concepts here:
>
> 1. A class's constructor, which is invoked when you create an instance of the class.
> 2. A regular method whose name happens to be "constructor", which would be invoked like `obj.constructor()`.
>
> [...]
>
> So:
>
> - We do not want to expose this `constructor` property that is inherited from the prototype of `Object`.
> - However, if the object for some reason has a direct property called `constructor`, we can allow this to be invoked.
> - The reason for this has nothing at all to do with constructors. The point here is that properties inherited from `Object` are properties that every object has whether it wants to or not. The application presumably does not intend for these to be exported over RPC. However, methods declared on the application's specific subclass are under the application's control. We are assuming any public method the application declares explicitly is intended to be exported over RPC.
> - This all applies to _all properties inherited from `Object`_ [...]. But only if the application does not override these methods with its own meanings.

### Methods of intermediate superclasses ARE callable — inheriting is the app's choice

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1409951375
Context: Same review, on prototype-walk semantics.

> And I think that we probably should allow methods of an inherited class (other than Object) to be invoked over RPC.
>
> The only reason we don't want to expose `Object`'s methods is because the application has no control over them. But it is the application's choice to inherit from any other class.

### Reserved names filtered server-side, not client-side; `fetch` and `connect` are reserved

Source: https://github.com/cloudflare/workerd/pull/1311#discussion_r1374749464 (and pull/1028#discussion_r1391787004)
Context: Review of the DO RPC stub client PR.

> I think that filtering for reserved names should happen on the server side, not the client. The client should go ahead and send the RPC even for these reserved names, but the server side should act as if the method doesn't exist if it's a known reserved name.
>
> (Note that it's important that the server block `fetch` for this purpose -- an RPC call trying to invoke `fetch` should not be permitted, the client needs to make an HTTP request instead.)

And from #1028: "We should also block `connect`, in order to reserve it for later use with sockets."

### Don't detect async by declaration — call the function and check for a Promise

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1391780083
Context: The server must await results whether or not the method was declared `async`.

> I suspect that using `IsAsyncFunction()` will not work in the case that the user gives us a function which is not declared `async` but happens to return a `Promise`. In this case, we still do want to wait for the `Promise` to resolve (we cannot serialize a `Promise` after all).
>
> [...]
>
> So instead of using `IsAsyncFunction()`, we need to just call the function, and then check if the result is a `Promise`, and if so, wait on it.

### Exceptions over RPC: don't special-case, rely on one tunneling mechanism for everything

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1425843033 and #discussion_r1427131878
Context: After discovering V8 serialization preserves nothing extra for Errors.

> Another line of argument here might be: We have talked about making regular exception tunneling itself use v8 serialization. If we did that, then the JS RPC protocol's explicit representation of exceptions becomes redundant, we can entirely rely on tunneling. Given that, I am now leaning towards: We should not explicitly handle exceptions in the JS RPC protocol. We should just throw tunneled exceptions. We can separately improve tunneled exceptions to use v8 serialization if we want to, but that's a separate matter from JS RPC.

> This problem already exists today for regular fetch() requests: If the DO's fetch() handler throws the `number` 10, the client will instead catch an `Error` whose description is `10`. I don't see any reason why we should solve this _specifically_ for RPC and not for all use cases. So I think RPC should depend on the same exception tunneling logic as everyone else, and separately later on we can improve that logic.

### The promise-fulfiller trick: hand back the capability before the event completes (pipelining)

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1298885739
Context: Core mechanism enabling zero-round-trip call initiation; also a lifetime-safety convention.

> Generally, the convention is that methods of WorkerInterface return promises, and the promise resolves when the event is done. Various parts of the stack may assume that the client is no longer connected to the server at this point. [...] I think we need to keep that convention here or we risk creating a lot of UAFs.
>
> Here's what I think you should do instead: When `JsRpcServiceCustomEventImpl` is constructed, it immediately creates the `JsRpcTarget::Client` from a `kj::Promise<JsRpcTarget::Client>`, which is itself the promise end of a promise-fulfiller pair. Once the real capability is known, the fulfiller is fulfilled with it, connecting the client to the server.
>
> This is also advantageous in that it means the client JavaScript can immediately begin expressing calls on this capability without having to await anything, and without dropping and re-taking the isolate lock.

### Don't stringify unserializable values into error messages

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1414319389
Context: On error messages when serialization of an RPC result fails.

> I am not sure it's a good idea to stringify the unserializable value and try to include that in the error. That value could include PII, or it could be giantic, or quite likely it cannot be stringified anyway.

### RPC belongs on the generic remote-endpoint type, not a DO-specific subclass

Source: https://github.com/cloudflare/workerd/pull/1311#discussion_r1376868110
Context: Pushing back on `DurableObjectRpcStub` as a new type; explains what `Fetcher` really is.

> Moreover, I am worried that if we focus too hard on the Durable Object use case we might accidentally create something that only really works for Durable Objects. We know that we do not want this to be DO-specific so I'd like to make sure we don't paint ourselves into that corner.
>
> The `Fetcher` type is badly-named, it is really the catch-all type for a remote endpoint that supports various comment request types -- currently HTTP and sockets. It seems natural to extend this for RPC.
>
> That said I could maybe be convinced that `Fetcher` should remain the type used for non-Workers remote endpoints, and we should really have a subclass called something like `WorkerRpc` which represents a remote Worker/DO. This type would extend `Fetcher` and add protocols that only work within the Workers network, namely JS RPC. [...] But I think we should not name this in a way that is specific to durable objects.

### Property access is just awaiting; implemented as custom thenables

Source: https://github.com/cloudflare/workerd/pull/1729 (PR body) and workerd@a25a3f8e21ff66c50aecc0c91b7e036ff80bc3ad
Context: Promise pipelining + property access design, in Kenton's own words.

> You can now access properties on an RPC object by just awaiting them:
>
>     let value = await stub.someProperty;
>
> And you can access properties on a _promise_ returned by an RPC call, in order to make speculative calls on stubs that you expect to be returned:
>
>     await stub.someMethod().someOtherMethod();
>
> Both of these are achieved via custom thenables rather than regular promises. This allows us to return a value that can be awaited, but which also has a wildcard property.

From the commit: "The system only attempts to fetch the property if you await it. This is accomplished by implementing a custom thenable that only actually initiates the fetch when `.then()` is called. [...] As always, for classes, only properties declared on the class are allowed, not instance properties. (For regular objects, any property can be fetched.)"

### RpcTarget as a marker; why non-RpcTarget classes are rejected; Proxy = explicit opt-in

Source: workerd@36d0b8056ab42edc68cf7357f0e430e642b6d2bb (commit message, 2024-12-05)
Context: "JSRPC: Allow wrapping RPC targets in Proxy objects." The clearest statement of the RPC access-control model.

> A `Proxy` can even be used to cause an object of class type that is _not_ derived from `RpcTarget` behave as if it were, by overriding `getPrototypeOf()` to return `RpcTarget.prototype`. This is a feature, not a bug! The reasons we don't normally support non-RpcTarget classes by default are (1) we want to reserve the right to add by-value serialization to existing API types in the future, without breaking compatibility, and (2) classes not explicitly written for RPC may not have been written with the understanding that their public API is a security boundary. However, if the developer uses a `Proxy` to fake that the object is an `RpcTarget`, then the developer is "opting in" to `RpcTarget` behavior, namely (1) the object is strictly pass-by-stub, and (2) they are comfortable with exposing the class's public interface.

Note: also states the model that plain objects expose "own" properties while RpcTargets expose only prototype properties.

### `new RpcStub(plainObject)` — forcing pass-by-stub

Source: workerd@8e4f3ed698db74a5ba8b91803d2481c7d2745096 (commit message, 2025-08-07)
Context: "JSRPC: Allow passing plain objects and Proxies to `new RpcStub`."

> Additionally, this change permits an `RpcStub` to be created from a plain object. This is a new feature, but I think it makes sense as a way to force an object to be passed by stub rather than by value. Previously, we exposed similar functionality when you wrapped a plain object in a `Proxy`, but (per the comment in this commit) in retrospect that seems like the wrong way to do it.

### params stubs are dup()ed, not ownership-transferred — the proxying double-dispose bug

Source: workerd repo, `src/workerd/io/compatibility-date.capnp` @ 479771c30, `rpcParamsDupStubs` flag doc (flag added in workerd@d05081ba, 2025-12-20)
Context: The compat-flag documentation explaining why Workers RPC switched to Cap'n Web's ownership semantics.

> Changes the ownership semantics of RPC stubs embedded in the parameters of an RPC call.
>
> When the RPC system was first introduced, RPC stubs that were embedded in the params or return value of some other call had their ownership transferred. That is, the original stub was implicitly disposed, with a duplicate stub being delivered to the destination.
>
> This turns out to compose poorly with another rule: in the callee, any stubs received in the params of a call are automatically disposed when the call returns. These two rules combine to mean that if you proxy a call -- i.e. the implementation of an RPC just makes another RPC call passing along the same params -- then any stubs in the params get disposed twice. Worse, if the eventual recipient of the stub wants to keep a duplicate past the end of the call, this may not work because the copy of the stub in the proxy layer gets disposed anyway, breaking the connection.
>
> For this reason, the pure-JS implementation of Cap'n Web switched to saying that stubs in params do NOT transfer ownership -- they are simply duplicated. This compat flag fixes the Workers Runtime built-in RPC to match Cap'n Web behavior.

### Every RPC-returned object gets a disposer — because types aren't known

Source: https://github.com/cloudflare/workers-sdk/issues/10030#issuecomment-3099389033 and #issuecomment-3152808775
Context: User complained that `{ greeting: string }` results are typed `& Disposable`.

> No, this is correct. Any time an RPC method returns an object, the system automatically adds a disposer to it.
>
> This is necessary because the RPC system does not know the types, so it does not know if the RPC might sometimes return an object containing stubs. It can only see whether the result _actually_ contains stubs, for any particular call. But you might have an RPC that sometimes returns an object containing stubs, and sometimes doesn't. It's bad if the result is only sometimes disposable, because if you store the result into a `using`-declared variable, and it isn't disposable, an exception will be thrown.
>
> So we are stuck with the rule that results _always_ get a disposer added (unless it's a primitive, in which case that's not possible).

> There's no overhead on the wire. The RPC system determines whether a disposer is actually needed or not when it deserializes the result. If no actual disposal logic is needed, the disposer is an empty function.

### Custom disposers fire on client dispose(), not GC

Source: workerd@5a49eb65a49323a296df027f833c1e24a27e9e48 (commit message, 2024-03-08)
Context: "JSRPC: Correctly handle custom disposer on returned object, and disposing promises."

> 1. When dispose() is invoked an a JsRpcPromise, we want this to be equivalent to awaiting the result and calling `dispose()` on that.
> 2. If an RPC returns an object which has a `dispose()` method, we really want to call that that only when the client calls `dispose()` on the client-side return value. Prior to this commit, the server-side disposer would be called when the JsRpcPromise on the client was GC'd, which could be either before or after `dispose()` was called on the client-side result.

### No custom pass-by-value deserializers — they caused security bugs elsewhere; the toJSON debate

Source: https://github.com/cloudflare/workerd/issues/6358#issuecomment-4331870213
Context: Feature request to serialize class instances over RPC via toJSON().

> We pretty intentionally made the decision not to support custom pass-by-value types, due to the fact that they've led to a lot of security bugs in other languages (e.g. Java).
>
> But I guess you aren't really proposing custom deserializers. Once the type has become JSON, it's just a JS object?
>
> Hmm, I can't think of a clear problem, but a lot of things make me uneasy:
>
> - Are we sure that falling back to toJSON() won't ever violate the developer's intent? [...] Falling back to toString() would be a bad idea since _everything_ has a toString() [...] but `toJSON()` is pretty explicitly designed with the intent of being in network messages, so maybe it is more reasonable?
> - Can this be typed? [...]
> - If someone implements a Proxy that pretend to have every method, will they accidentally appear to implement `toJSON()`? I think our own RPC stubs may have this problem -- if you call `stub.toJSON()` you are actually making an RPC call and you get back a promise. [...]
>
> If we do support this, I'd probably want to do it in [Cap'n Web](https://github.com/cloudflare/capnweb) first, followed by workerd. (Eventually, workerd and Cap'n Web should support exactly the same types.)

### Channel tokens: serializing service bindings without letting anyone forge authority

Source: workerd@e1c36e54be1a119c177f6fe36bc229425105fcec (commit message, 2025-12-06; same text in PR #5693 body)
Context: "Introduce 'channel tokens', a mechanism for serializing Fetchers." The security design for sending bindings over RPC and into storage.

> A channel token encodes a (service name, entrypoint name, props) triplet. Note that it would be very bad if an attacker were able to specify such a triplet directly, particularly as `props` usually contains authorization details that we don't want an attacker to be able to forge!
>
> To that end, the channel token format is conservatively-designed at present:
>
> For RPC, the token is encrypted and MAC'd using an AES key which is generated uniquely for each process. This means that tokens are only valid within the same process where they were created, and there's no way to forge such a token unless you can see into the process's memory. In the future, we may loosen things to allow sending tokens between processes somehow. For now, though, this format has the nice side property that there is no backwards-compatibility expectation at all, so we're free to change it later.
>
> This commit also defines a format for tokens intended for long-term storage, e.g. to store in DO KV storage. Such tokens obviously cannot be signed by a per-process key since we want them to survive through process reloads. For the time being, we don't enrypt such tokens at all, but the feature will be hidden behind a new compat flag [...] which will remain strictly experimental. This feature will eventually be replaced with a system that actually stores information about known "grants" in some separate storage, so that they can be audited and revoked.

### Irrevocable stub storage: loud warnings, both ends must opt in

Source: workerd repo, `src/workerd/io/compatibility-date.capnp` @ 479771c30, `allowIrrevocableStubStorage` flag doc
Context: The compat flag guarding persistent stubs / stored bindings.

> Permits various stub types (e.g. ServiceStub aka Fetcher, DurableObjectClass) to be stored in long-term Durable Object storage without any mechanism for the stub target to audit or revoke incoming connections. This is intended as a temporary measure to enable apps to experiment with stub storage, but long-term it will be replaced with a mechanism that allows stubs to be auditable and revocable.
>
> Also enables persistent stubs via the `[restore]()` mechanism.
>
> Both the Worker storing the stub and the Worker that the stub points to (as well as any members of the restore chain in between) must opt into the flag. If the target Worker later turns the flag off, existing stored stubs pointing at it will stop working.
>
> IRREVOCABLE STUB STORAGE IS INHERENTLY INSECURE. We strongly recommend against using this flag when passing stubs over real trust boundaries.
>
> THIS FEATURE IS EXPERIMENTAL AND TEMPORARY. Cloudflare WILL retract this feature and WILL break all stored stubs at some point in the future, as soon as an auditable and revocable alternative is available.

### Persistent stubs: only ctx.exports / ctx.restore() loopbacks can be persistent, and why

Source: workerd@d9094ff3e805875a145e76aae8ecd9049fa3475c (commit message, 2026-06-21)
Context: "Require allow_irrevocable_stub_storage on persistent stub _target_."

> Until now, storing stubs to DO storage was allowed as long as the storer had `allow_irrevocable_stub_storage` enabled. This is not safe enough to make generally available. This commit makes it so that the _target_ of the stub must _also_ have the flag, both at the time that the stub is minted and at the time that it is used. As long as both caller and callee are opting into the kinda-insecure behavior, there's no reason we can't make this available to everyone.
>
> Moreover, we only allow stubs created through either `ctx.exports` or `ctx.restore()` to be persistent. Regular service bindings in env, or actor stubs constructed through an actor namespace binding in env, are never able to be persisted. This adds a lot of complexity in this commit (lots of passing along `Persistent` flags), but is necessary because in the edge runtime, we don't have any way to inspect a remote worker's compat flags. Hence, we necessarily cannot know whether a stub is persistent unless it was created by the worker that is also the target of the stub, that is, it must be from a ctx.exports loopback binding.

### Multi-hop restore chains: the bug class where "we tested each half but not the composition"

Source: workerd@f58c99c05465e7dbfb624e4770bd1d63385d2196 (commit message, 2026-07-18)
Context: "Fix multi-hop persistent stub restore chains through RPC." Useful both for restore-chain mechanics and as a testing lesson.

> [The dispatcher] itself failed to implement the two new persistent-stub-restore-chain RPCs, `restoreService()` and `restoreRpcStub()`.
>
> Because of this, multi-hop restore chains where the first hop crossed an RPC boundary (particularly, Durable Objects in the production implementation) would fail. This slipped by testing because we tested single-hop restore chains over RPC, and we tested multi-hop restore chains not over RPC.
>
> None of this applies in `workerd` since, at present, it never uses the RPC interface here, only local calls.

### Bindings passed across machines must be reloadable from scratch — so dynamic-worker stubs can't transfer

Source: workerd@156304264961a2dc8d89e5007d414a8dbbf24e8c (commit message, 2025-08-19)
Context: "Don't allow transferring of SubrequestChannels for dynamic entrypoints."

> In production, when we transfer a Fetcher binding to another worker, the second worker might run on an entirely different machine, maybe on the other side of the world. It's important that any bindings passed to it can be loaded from scratch locally, without calling back to the original Worker that made the introduction. But we can't possibly support this for dynamically-loaded workers because we don't know how to reload them without the app's help. So, let's enforce that entrypoint stubs to dynamically-loaded workers cannot be transferred.

### ctx.props: bindings as capabilities, authentication without cryptography

Source: workerd@e34ab7e73effe3fd0ab12e11e148b8005a038912 (commit message, 2024-11-29)
Context: "Implement connection props." The capability-security story for service bindings.

> Note that "caller" is just an example. The props can contain anything. Use cases include:
>
> - Authentication of the caller's identity.
> - Authorization / permissions (independent of caller identity).
> - Specifying a particular resource. For example, if the `WorkerEntrypoint` represents a chat room, `props.roomId` could be the ID of the specific chat room to access.
>
> This allows service bindings to implement a deeper capability-based security model, where bindings point to specific resources with specific permissions, instead of general APIs.
>
> On Cloudflare, only users who have permission to modify your worker will have permission to create a binding containing arbitrary metadata. Meanwhile we will be creating a mechanism by which you can grant a service binding to your worker to someone, but where you specify the metadata. Thus, you can use the metadata to authenticate requests, without the need for any cryptography.

### Opt-in server-side: RPC enabled by extending the new base classes, not by default on old code

Source: workerd@e02bc6d2307b998b9cf631825196369473af12ad (commit message, 2024-02-10)
Context: "JSRPC: Allow RPC without `js_rpc` flag if extending new classes."

> We will automatically enable JS RPC on the server side if the entrypoint class extends `DurableObject` or `StatelessService`. We'll also allow it for bare object entrypoints, because this seems harmless.
>
> Historical Durable Object classes which did not extend `DurableObject` will not accept RPC, for fear of exposing methods that weren't intended to be exposed.

### Class-based entrypoints: ctx/env in the constructor so RPC methods get clean signatures

Source: workerd@2c8b6b2ec2fbcde0c43040b585b77c0014fd08e9 (commit message, 2024-02-10)
Context: "Support class-based stateless entrypoints" — the origin of WorkerEntrypoint.

> For every request, a new instance of the class will be constructed. Since `env` and `ctx` are passed to the constructor, they do not need to be passed to individual methods.
>
> This means in particular that JSRPC methods can have multiple arguments without awkwardly inserting `env` and `ctx` between them.
>
> The constructor argument order is `ctx, env` in order to be consistent with Durable Object classes, which use that ordering.

### RPC ordering across code paths is fragile — fetch vs RPC took different paths

Source: https://github.com/cloudflare/workerd/issues/2246#issuecomment-2158352964
Context: threepointone showed E-order isn't preserved when mixing un-awaited RPC and fetch on a DO stub.

> Ugh. I guess this is probably because fetch() goes through a very different code path compared to RPC. Might be tricky to fix.

### ctx.exports: automatic self-referential bindings

Source: workerd@6caa936adadf81b8a766b5ab541d0764a27d6794 (commit message, 2025-01-31)
Context: "Implement automatic self-referential bindings via ctx.exports." Load-bearing for facets and persistent stubs.

> For every top-level export, `ctx.exports` will contain a corresponding property which acts as a binding to that export. If the export is a simple object or `WorkerEntrypoint`, then the `ctx.exports` property is a service binding. If the export is a Durable Object class (and it has been configured with storage), the `ctx.exports` property is a DO namespace binding.
>
> So you can do: `ctx.exports.MyEntrypoint.someRpc()`
>
> And it calls `someRpc()` on the entrypoint named `MyEntrypoint`, as if you had called it over a service binding.

### Coroutines + isolate locks don't mix: JsValue may not live on the heap

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1411181266
Context: Deep review teaching moment about V8 handle lifetimes vs C++ coroutine frames; a recurring workerd implementation invariant.

> The problem is that you're in a coroutine here, and the compiler is therefore free to store local variables and even temporaries on the coroutine frame instead of on the stack. The coroutine frame lives on the heap. But `JsValue` is not allowed to be stored on the heap, only on the stack. This is because a `JsValue` is invalidated as soon as we exit the innermost `v8::HandleScope`, so we want to make sure people don't try to store them long-term.
>
> In a coroutine, whether the compiler decides to store any particular value on the stack vs. the coroutine frame is completely up to the compiler, and the decision can and does change between compiler versions, optimization levels, and probably even based on seemingly unrelated changes to the function. Because of this, you cannot use `JsValue` inside a coroutine.

### Avoid redundant isolate lock churn: stay in JS land when chaining promises

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1411172743
Context: Same review; the KJ-vs-V8 event loop cost model.

> The pattern `co_await ctx.awaitJs(` implies that we're dropping the isolate lock and then taking it again when we don't really have to. That is: `ctx.awaitJs()` converts a JS promise (which normally runs on the V8 mircotask loop, which is pumped with the isolate lock held continuously) into a KJ promise (which runs on the KJ event loop, which can only be pumped after we've released all locks).
>
> If you instead use `promise.then()` here, you can stay entirely in JS land, using the V8 microtask loop, so you don't have to drop to KJ and unnecessarily release the isolate lock.
