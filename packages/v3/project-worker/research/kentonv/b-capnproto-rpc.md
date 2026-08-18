# Kenton Varda on the Cap'n Proto RPC protocol (Collector B)

Harvested 2026-08-18. Primary source: `capnproto/capnproto` @ origin/master `b5c4cac871a978e85c02dfe72f62d84bf02a35a5`, file `c++/src/capnp/rpc.capnp` (1530 lines — the protocol doc comments are entirely his) and `doc/rpc.md` (the website RPC page). Plus his HN commentary on RPC design history. All blockquotes verbatim.

---

### The thesis: a surprisingly complicated protocol implementing a conceptually-simple object abstraction

Source: capnproto/c++/src/capnp/rpc.capnp @ b5c4cac8, lines 27–40

> # Recall also that Cap'n Proto RPC has the feature that when a method call itself returns a
>
> # capability, the caller can begin calling methods on that capability \_before the first call has
>
> # returned\_. The caller essentially sends a message saying "Hey server, as soon as you finish
>
> # that previous call, do this with the result!". Cap'n Proto's RPC protocol makes this possible.
>
> #
>
> # The protocol is significantly more complicated than most RPC protocols. However, this is
>
> # implementation complexity that underlies an easy-to-grasp higher-level model of object oriented
>
> # programming. That is, just like TCP is a surprisingly complicated protocol that implements a
>
> # conceptually-simple byte stream abstraction, Cap'n Proto is a surprisingly complicated protocol
>
> # that implements a conceptually-simple object abstraction.
>
> #
>
> # Cap'n Proto RPC is based heavily on CapTP, the object-capability protocol used by the E
>
> # programming language

Note: The same framing closes doc/rpc.md: "The protocol is complex, but the functionality it supports is conceptually simple."

---

### Vats, no client/server, and E-Order as a protocol invariant

Source: rpc.capnp @ b5c4cac8, lines 42–65

> # Cap'n Proto RPC takes place between "vats". A vat hosts some set of objects and talks to other
>
> # vats through direct bilateral connections. Typically, there is a 1:1 correspondence between vats
>
> # and processes [...]
>
> #
>
> # Cap'n Proto does not distinguish between "clients" and "servers" -- this is up to the application.
>
> # Either end of any connection can potentially hold capabilities pointing to the other end, and
>
> # can call methods on those capabilities. In the doc comments below, we use the words "sender"
>
> # and "receiver". [...] Documentation is generally written from the point of view of the sender.
>
> #
>
> # Unless otherwise specified, messages must be delivered to the receiving application in the same
>
> # order in which they were initiated by the sending application. The goal is to support "E-Order",
>
> # which states that two calls made on the same reference must be delivered in the order which they
>
> # were made:
>
> # http://erights.org/elib/concurrency/partial-order.html

---

### The level system: how to ship a partial implementation honestly

Source: rpc.capnp @ b5c4cac8, lines 67–110

> # Since the full protocol is complicated, we define multiple levels of support that an
>
> # implementation may target. For many applications, level 1 support will be sufficient.
>
> #
>
> # \* **Level 0:** The implementation does not support object references. [...] This level should be considered only
>
> # a temporary stepping-stone toward level 1 as the lack of object references drastically changes
>
> # how protocols are designed. Applications _should not_ attempt to design their protocols around
>
> # the limitations of level 0 implementations.
>
> #
>
> # \* **Level 1:** The implementation supports simple bilateral interaction with object references
>
> # and promise pipelining, but interactions between three or more parties are supported only via
>
> # proxying of objects. [...]
>
> #
>
> # \* **Level 2:** The implementation supports saving persistent capabilities [...] When a
>
> # capability is saved, the requester receives a `SturdyRef` [...]
>
> #
>
> # \* **Level 3:** The implementation supports three-way interactions. That is, if Alice (in Vat A)
>
> # sends Bob (in Vat B) a capability pointing to Carol (in Vat C), then Vat B will automatically
>
> # form a direct connection to Vat C rather than have requests be proxied through Vat A.
>
> #
>
> # \* **Level 4:** The entire protocol is implemented, including joins (checking if two capabilities
>
> # are equivalent).

Note: Also the pragmatic escape hatch (lines 104–110): "New implementations of Cap'n Proto should start out targeting the simplistic two-party network type [...] When such an implementation is paired with a container proxy, the contained app effectively gets to make full use of the proxy's network at level 4."

---

### The Four Tables, and what dies on disconnect

Source: rpc.capnp @ b5c4cac8, lines 115–153

> # As in CapTP, for each open connection, a vat maintains four state
>
> # tables: questions, answers, imports, and exports. See the diagram at:
>
> # http://www.erights.org/elib/distrib/captp/4tables.html
>
> #
>
> # The question table corresponds to the other end's answer table, and the imports table corresponds
>
> # to the other end's exports table.
>
> [...]
>
> # IDs can be reused over time. To make this safe, we carefully define the lifetime of IDs. Since
>
> # messages using the ID could be traveling in both directions simultaneously, we must define the
>
> # end of life of each ID _in each direction_. [...]
>
> #
>
> # When a Cap'n Proto connection is lost, everything on the four tables is lost. All questions are
>
> # canceled and throw exceptions. All imports become broken (all future calls to them throw
>
> # exceptions). All exports and answers are implicitly released. The only things not lost are
>
> # persistent capabilities (`SturdyRef`s). The application must plan for this and should respond by
>
> # establishing a new connection and restoring from these persistent capabilities.

Note: Cap'n Web later collapsed four tables to two (see b-capnweb.md) — he calls the four-table split "a complete mistake on my part" (HN 45337147, below).

---

### Bootstrap: in an ideal world, DNS itself would return capabilities

Source: rpc.capnp @ b5c4cac8, lines 288–303

> # We call this a "bootstrap" because in an ideal Cap'n Proto world, bootstrap interfaces would
>
> # never be used. In such a world, any time you connect to a new vat, you do so because you
>
> # received an introduction from some other vat (see `ThirdPartyCapId`). Thus, the first message
>
> # you send is `Accept`, and further communications derive from there. `Bootstrap` is not used.
>
> #
>
> # In such an ideal world, DNS itself would support Cap'n Proto -- performing a DNS lookup would
>
> # actually return a new Cap'n Proto capability, thus introducing you to the target system via
>
> # level 3 RPC. Applications would receive the capability to talk to DNS in the first place as
>
> # an initial endowment or part of a Powerbox interaction. Therefore, an app can form arbitrary
>
> # connections without ever using `Bootstrap`.
>
> #
>
> # Of course, in the real world, DNS is not Cap'n-Proto-based [...] bootstrap
>
> # interfaces are used to "bootstrap" from other, non-Cap'n-Proto-based means of service discovery,
>
> # such as legacy DNS.

---

### The `Restore` post-mortem: why "well-known capabilities by string name" is a security trap

Source: rpc.capnp @ b5c4cac8, lines 323–386 (the `deprecatedObjectId` history)
Context: A design he shipped in 0.4 and then retracted, with full reasoning preserved as protocol comments — the Sandstorm supervisor case is a canonical ocap confused-deputy example.

> # - Overloading "Restore" also had a security problem: Often, "main" or "well-known"
>
> # capabilities exported by a vat are in fact not public [...] This can lead to trouble if
>
> # the client itself has other clients and wishes to forward some `Restore` requests from those
>
> # external clients -- it has to be very careful not to allow through `Restore` requests
>
> # addressing the default capability.
>
> #
>
> # For example, consider the case of a sandboxed Sandstorm application and its supervisor. The
>
> # application exports a default capability to its supervisor that provides access to
>
> # functionality that only the supervisor is supposed to access. Meanwhile, though, applications
>
> # may publish other capabilities that may be persistent [...] These requests of course have to
>
> # pass through the supervisor [...] But, the supervisor has to be careful not to honor an
>
> # external request addressing the application's default capability, since this capability is
>
> # privileged. Unfortunately, the default capability cannot be given an unguessable name, because
>
> # then the supervisor itself would not be able to address it!

And the SturdyRef-lifecycle advice (lines 377–386):

> # [A "delete" operation's] utility is questionable. You wouldn't be able to rely on it for
>
> # garbage collection since a client could always disappear permanently without remembering to
>
> # delete all its SturdyRefs, thus leaving them dangling forever. Therefore, it is advisable to
>
> # design systems such that SturdyRefs never represent "owned" pointers.
>
> #
>
> # For example, say a SturdyRef points to an image file hosted on some server. That image file
>
> # should also live inside a collection (a gallery, perhaps) hosted on the same server, owned by
>
> # a user who can delete the image at any time. If the user deletes the image, the SturdyRef
>
> # stops working. On the other hand, if the SturdyRef is discarded, this has no effect on the
>
> # existence of the image in its collection.

---

### `sendResultsTo.yourself`: tail calls without the extra hop

Source: rpc.capnp @ b5c4cac8, lines 452–488

> # Don't actually return the results to the sender. Instead, hold on to them and await
>
> # instructions from the sender regarding what to do with them. [...]
>
> #
>
> # This feature can be used to implement tail calls in which a call from Vat A to Vat B ends up
>
> # returning the result of a call from Vat B back to Vat A.
>
> #
>
> # In particular, the most common use case for this feature is when Vat A makes a call to a
>
> # promise in Vat B, and then that promise ends up resolving to a capability back in Vat A.
>
> # Vat B must forward all the queued calls on that promise back to Vat A, but can set `yourself`
>
> # in the calls so that the results need not pass back through Vat B.

---

### Default-true release flags: design so that level-0 implementations fail loudly, not leakily

Source: rpc.capnp @ b5c4cac8, lines 513–521 (`Return.releaseParamCaps`)
Context: A tiny masterclass in defaults chosen for failure-mode asymmetry.

> # If true, all capabilities that were in the params should be considered released. The sender
>
> # must not send separate `Release` messages for them. Level 0 implementations in particular
>
> # should always set this true. This defaults true because if level 0 implementations forget to
>
> # set it they'll never notice (just silently leak caps), but if level >=1 implementations forget
>
> # to set it to false they'll quickly get errors.

Note: Same pattern on `Finish.releaseResultCaps` (lines 592–597). Also `unimplemented` (lines 216–232): echo misunderstood messages back so the sender can recover without leaks.

---

### Resolve: once a promise resolves to R, forward to R forever

Source: rpc.capnp @ b5c4cac8, lines 656–667

> # The sender promises that from this point forth, until `promiseId` is released, it shall
>
> # simply forward all messages to the capability designated by `cap`. This is true even if
>
> # `cap` itself happens to designate another promise, and that other promise later resolves --
>
> # messages sent to `promiseId` shall still go to that other promise, not to its resolution.
>
> # This is important in the case that the receiver of the `Resolve` ends up sending a
>
> # `Disembargo` message towards `promiseId` in order to control message ordering -- that
>
> # `Disembargo` really needs to reflect back to exactly the object designated by `cap` even
>
> # if that object is itself a promise.

---

### Embargoes and Disembargo: enforcing E-order across promise resolution

Source: rpc.capnp @ b5c4cac8, lines 688–729

> # Embargos are used to enforce E-order in the presence of promise resolution. That is, if an
>
> # application makes two calls foo() and bar() on the same capability reference, in that order,
>
> # the calls should be delivered in the order in which they were made. But if foo() is called
>
> # on a promise, and that promise happens to resolve before bar() is called, then the two calls
>
> # may travel different paths over the network, and thus could arrive in the wrong order. In
>
> # this case, the call to `bar()` must be embargoed, and a `Disembargo` message must be sent along
>
> # the same path as `foo()` to ensure that the `Disembargo` arrives after `foo()`. Once the
>
> # `Disembargo` arrives, `bar()` can then be delivered.
>
> [...]
>
> # An alternative strategy for enforcing E-order over promise resolution could be for Vat A to
>
> # implement the embargo internally. When Vat A is notified of promise resolution, it could
>
> # send a dummy no-op call to promise P and wait for it to complete. Until that call completes,
>
> # all calls to the capability are queued locally. This strategy works, but is pessimistic [...]
>
> # The `Disembargo` message allows latency to be reduced.

---

### The Tribble 4-way race condition — and the rule that sidesteps it

Source: rpc.capnp @ b5c4cac8, lines 731–758

> # Any implementation of promise resolution and embargos must be aware of what we call the
>
> # "Tribble 4-way race condition", after Dean Tribble, who explained the problem in a lively
>
> # Friam meeting.
>
> #
>
> # Embargos are designed to work in the case where a two-hop path is being shortened to one hop.
>
> # But sometimes there are more hops. Imagine that Alice has a reference to a remote promise P1
>
> # that eventually resolves to _another_ remote promise P2 (in a third vat), which \_at the same
>
> # time\_ happens to resolve to Bob (in a fourth vat). In this case, we're shortening from a 3-hop
>
> # path (with four parties) to a 1-hop path (Alice -> Bob).
>
> #
>
> # Extending the embargo/disembargo protocol to be able to shorted multiple hops at once seems
>
> # difficult. Instead, we make a rule that prevents this case from coming up:
>
> #
>
> # One a promise P has been resolved to a remote object reference R, then all further messages
>
> # received addressed to P will be forwarded strictly to R. [...]
>
> #
>
> # This rule does not cause a significant performance burden because once P has resolved to R, it
>
> # is expected that people sending messages to P will shortly start sending them to R instead and
>
> # drop P. P is at end-of-life anyway, so it doesn't matter if it ignores chances to further
>
> # optimize its path.
>
> #
>
> # Note well: the Tribble 4-way race condition does not require each vat to be _distinct_; as long
>
> # as each resolution crosses a network boundary the race can occur -- so this concerns even level
>
> # 1 implementations, not just level 3 implementations.

---

### PromisedAnswer.Op: the famous "probably not a good idea" pre-rejection

Source: rpc.capnp @ b5c4cac8, lines 1120–1141
Context: The transform ops applied to pipelined results. He pre-rejects a script language — then Cap'n Web's `remap` (the `.map()` DSL) built exactly the narrow version he sketched, "designed as if this were the eventual goal."

> ```
>   struct Op {
>     union {
>       noop @0 :Void;
>       # Does nothing.  This member is mostly defined so that we can make `Op` a union even
>       # though (as of this writing) only one real operation is defined.
>
>       getPointerField @1 :UInt16;
>       # Get a pointer field within a struct.  The number is an index into the pointer section, NOT
>       # a field ordinal, so that the receiver does not need to understand the schema.
>
>       # TODO(someday):  We could add:
>       # - For lists, the ability to address every member of the list, or a slice of the list, the
>       #   result of which would be another list.  This is useful for implementing the equivalent of
>       #   a SQL table join (not to be confused with the `Join` message type).
>       # - Maybe some ability to test a union.
>       # - Probably not a good idea:  the ability to specify an arbitrary script to run on the
>       #   result.  We could define a little stack-based language where `Op` specifies one
>       #   "instruction" or transformation to apply.  Although this is not a good idea
>       #   (over-engineered), any narrower additions to `Op` should be designed as if this
>       #   were the eventual goal.
>     }
>   }
> ```

---

### The vine: how level-1 peers survive a level-3 world

Source: rpc.capnp @ b5c4cac8, lines 1152–1167

> # A proxy for the third-party object exported by the sender. In CapTP terminology this is called
>
> # a "vine", because it is an indirect reference to the third-party object that snakes through the
>
> # sender vat. This serves two purposes:
>
> #
>
> # \* Level 1 and 2 implementations that don't understand how to connect to a third party may
>
> # simply send calls to the vine. Such calls will be forwarded to the third-party by the
>
> # sender.
>
> #
>
> # \* Level 3 implementations must release the vine only once they have successfully picked up the
>
> # object from the third party. This ensures that the capability is not released by the sender
>
> # prematurely.

---

### Exception philosophy: no checked exceptions; error type = how the client should respond

Source: rpc.capnp @ b5c4cac8, lines 1174–1246

> # Cap'n Proto exceptions always indicate that something went wrong. In other words, in a fantasy
>
> # world where everything always works as expected, no exceptions would ever be thrown. Clients
>
> # should only ever catch exceptions as a means to implement fault-tolerance [...]
>
> #
>
> # Exceptions should NOT be used to flag application-specific conditions that a client is expected
>
> # to handle in an application-specific way. Put another way, in the Cap'n Proto world,
>
> # "checked exceptions" (where an interface explicitly defines the exceptions it throws and
>
> # clients are forced by the type system to handle those exceptions) do NOT make sense.

> # type @3 :Type;
>
> # The type of the error. The purpose of this enum is not to describe the error itself, but
>
> # rather to describe how the client might want to respond to the error.

The `disconnected` doc doubles as his revocation/reconnect doctrine:

> # - The capability has been revoked. Revocation does not necessarily mean that the client is
>
> # no longer authorized to use the capability; it is often used simply as a way to force the
>
> # client to repeat the setup process, perhaps to efficiently move them to a new back-end [...]
>
> #
>
> # A client should normally respond to this error by releasing all capabilities it is currently
>
> # holding related to the one it called and then re-creating them by restoring SturdyRefs and/or
>
> # repeating the method calls used to create them originally. In other words, disconnect and
>
> # start over.

---

### Time Travel: the canonical promise-pipelining pitch (the Filesystem example)

Source: capnproto doc/rpc.md @ b5c4cac8 (website "RPC Protocol" page)
Context: The most-quoted API-design argument he's written: pipelining is what lets you keep object-oriented interfaces instead of flattening them into path-string batch APIs.

> In such a high-latency scenario, making your interface elegant is simply not worth 4x the latency. So now you're going to change it. You'll probably do something like:
>
> - Introduce a notion of path strings, so that you can specify "foo/bar" rather than make two separate calls.
> - Merge the `File` and `Directory` interfaces into a single `Filesystem` interface, where every call takes a path as an argument.
>
> We've now solved our latency problem... but at what cost?
>
> - We now have to implement path string manipulation, which is always a headache.
> - If someone wants to perform multiple operations on a file or directory, we now either have to re-allocate resources for every call or we have to implement some sort of cache, which tends to be complicated and error-prone.
> - We can no longer give someone a specific `File` or a `Directory` -- we have to give them a `Filesystem` and a path.
>   - But what if they are buggy and have hard-coded some path other than the one we specified?
>   - Or what if we don't trust them, and we really want them to access only one particular `File` or `Directory` and not have permission to anything else. Now we have to implement authentication and authorization systems! Arrgghh!
>
> Essentially, in our quest to avoid latency, we've resorted to using a singleton-ish design, and singletons are evil.
>
> **Promise Pipelining solves all of this!**
>
> With pipelining, our 4-step example can be automatically reduced to a single round trip with no need to change our interface at all. We keep our simple, elegant, singleton-free interface, we don't have to implement path strings, caching, authentication, or authorization, and yet everything performs as well as we can possibly hope for.

---

### "Didn't CORBA prove this doesn't work?" — No.

Source: capnproto doc/rpc.md @ b5c4cac8 ("Distributed Objects" section)

> CORBA failed for many reasons, with the usual problems of design-by-committee being a big one.
>
> However, the biggest reason for CORBA's failure is that it tried to make remote calls look the same as local calls. Cap'n Proto does NOT do this -- remote calls have a different kind of API involving promises, and accounts for the presence of a network introducing latency and unreliability.
>
> As shown above, promise pipelining is absolutely critical to making object-oriented interfaces work in the presence of latency. If remote calls look the same as local calls, there is no opportunity to introduce promise pipelining, and latency is inevitable. Any distributed object protocol which does not support promise pipelining cannot -- and should not -- succeed.

Note: Also "Handling disconnects": "when all references to an object have been 'dropped' [...] the object will be closed [...] This allows servers to easily allocate per-client resources without having to clean up on a timeout or risk leaking memory."

---

### Why COM/CORBA/SOAP failed and Cap'n Proto doesn't — the five reasons

Source: https://news.ycombinator.com/item?id=45473473 (2025-10-04, "Ask HN: Why did COM/SOAP/other protocols fail?")
Context: His most complete retrospective on distributed-object history. Excerpted; reasons 3–5 are the load-bearing ones.

> 3. Lack of promise pipelining. This sort of follows from #2 (at least, I don't know how you'd express promise pipelining if you don't have promises to start with). Without promise pipelining, it's incredibly hard to design composable interfaces, because they cannot be composed without adding a round trip for every call. So instead you end up pushed towards big batch requests, but those don't play well with object-oriented API design.
> 4. Poor lifecycle management. An object reference in CORBA was (I am told) "just data", which could be copied anywhere and then used. The server had no real way of being notified when the object reference was no longer needed [...] Cap'n Proto ties object lifetime to connections, so when a connection is lost, all the object references held across it are automatically disposed. Cap'n Proto's client libraries are also designed to carefully track the lifecycle of a reference within the client app, so that as soon as it goes out-of-scope (GC'd, destructor runs, etc.), a message can be sent to the server letting it know. This works pretty well.
> 5. Bad security model. All objects existed in a global namespace and any client could connect to any object. Access control lists had to be maintained [...] Cap'n Proto implements an object-capability model, aka capability-based security. There is no global namespace of objects. To access one, you have to first receive an object reference from someone who already has one. Passing someone an object reference implies giving them permission to use it. This may at first sound more complicated, but in practice it turns out to map very cleanly to common object-oriented API design patterns.
>
> As a result of all this, in Cap'n Proto (and Cap'n Web), you can pretty much use the exact same API design patterns you'd use in a modern programming language, with lots of composable objects and methods, and it's all safe and efficient.

Note: Also from the same thread: "Many people have joined the team, initially thought 'what is this weird thing? Why don't we just use gRPC instead?', and then after a few months of using it decided it's actually a superpower."

---

### Splitting call-return from promise-resolve was "a complete mistake"

Source: https://news.ycombinator.com/item?id=45337147 (2025-09-22, Cap'n Web launch thread)

> Now, to be fair, Cap'n Proto has a lot of features that Cap'n Web doesn't have yet. But Cap'n Web's high-level design is actually a lot simpler.
>
> Among other things, I merged the concepts of call-return and promise-resolve. (Which, admittedly, CapTP was doing it that way before I even designed Cap'n Proto. It was a complete mistake on my part to turn them into two separate concepts in Cap'n Proto, but it seemed to make sense at the time.)
>
> What I'd like to do is go back and revise the Cap'n Proto protocol to use a similar design under the hood. This would make no visible difference to applications (they'd still use schemas), but the state machine would be much simpler, and easier to port to more languages.

---

### Streaming flow control (0.8): the Return message is the application-level ack

Source: https://news.ycombinator.com/item?id=22978938 (2020-04-25, Cap'n Proto 0.8 thread)

> Yes, Cap'n Proto has knowledge from both sides. The "Return" message from each call serves as an application-level acknowledgment that the message has been received and processed. This is enough information for the sender to maintain a send window that places an upper bound on buffer bloat. Calculating an ideal window size is tricky and the current solution of stealing the OS's choice is, as admitted in the post, a hack. But all the necessary information is there to do something better in the future.

Note: This is the mechanism Durable Objects inherit — his DO-beta HN answer says "this is exactly why we added streaming flow control to Cap'n Proto" (see b-durable-objects-design.md).

---

### The cancellation lesson: he was told cancellation is dangerous; practice proved the opposite

Source: https://news.ycombinator.com/item?id=36910007 (2023-07-28, Cap'n Proto 1.0 thread)

> When originally designing Cap'n Proto, I was convinced by a capabilities expert I talked to that cancellation should be considered dangerous, because software that isn't expecting it might be vulnerable to attacks if cancellation occurs at an unexpected place. [...] I found the argument compelling.
>
> In practice, though, I've found the opposite: In a language with explicit lifetimes, and with KJ's particular approach to Promises [...] cancellation safety is a natural side-effect of writing code to have correct lifetimes. You have to make cancellation safe because you have to cancel tasks all the time when the objects they depend on are going to be destroyed. Moreover, in a fault-tolerant distributed system, you have to assume any code might not complete, e.g. due to a power outage or maybe just throwing an unexpected exception in the middle, and you have to program defensively for that anyway. This all becomes second-nature pretty quick.
>
> So all our code ends up cancellation-safe by default. We end up with way more problems from cancellation unexpectedly being prevented when we need it, than happening when we didn't expect it.

---

### vs gRPC: the two key differences

Source: https://news.ycombinator.com/item?id=14244540 (2017-05-02, Cap'n Proto 0.6 thread)

> If you read the Cap'n Proto RPC docs, everywhere where it mentions "traditional RPC", I specifically had Google's internal RPC in mind (having previously been the maintainer of Protobufs at Google). So, you can more-or-less substitute gRPC in there for a direct comparison.
>
> There are two key differences:
>
> 1. Cap'n Proto treats references to RPC endpoints as a first-class type. So, you can introduce a new endpoint dynamically, and you can send someone a message containing a reference to that endpoint. Only the recipient of the message will be able to access the new endpoint, and when that recipient drops their reference or disconnects, you'll get notified so that you can clean it up. This is incredibly useful for modeling stateful interactions, where a client opens an object, performs a series of operations on it, then finally commits it. Put another way, this allows object-oriented programming over RPC. [...]
> 2. Relatedly, Cap'n Proto supports "promise pipelining" [...]

---

### The First Law of Distributed Objects, answered

Source: https://news.ycombinator.com/item?id=8175714 (2014-08-14, on Fowler's "Microservices and the First Law of Distributed Objects")

> With promise pipelining, if you need to make two RPCs to the same server, and the result of the first is going to be an input to the second, you can actually do it in one network round trip. [...]
>
> With this, fine-grained calls no longer imply an enormous latency expense compared to course-grained. Meanwhile, fine-grained APIs are cleaner and more composable [...]
>
> It's unfortunate that CORBA gave distributed objects a bad name. Just like object-oriented design within a program is more expressive than procedural design, object-oriented network protocols are more expressive than the flat protocols we tend to see today. [...]
>
> CORBA only messed up in trying to make remote objects look the same as local objects. Everyone now agrees that was a terrible mistake. But making distributed objects work does not in any way require making them look exactly like local objects. Calls to a Cap'n Proto object look quite different from local calls, because you need to be aware of the network issues implied by the call. But I've found that the same higher-level OO design principles you might use locally translate remarkably well to Cap'n Proto interfaces.

---

### Stateless-everything is a symptom of missing protocols for state

Source: https://news.ycombinator.com/item?id=36911688 (2023-07-28)

> If you're thinking strictly about stateless backends that just convert every request into a SQL query, then yeah, promise pipelining might not be very helpful.
>
> I think where it shines is when interacting with stateful services. I think part of the reason everyone tries to make everything stateless is because we don't have good protocols for managing state. Cap'n Proto RPC is actually quite good at it.

---

### Cap'n Proto is not a product

Source: https://news.ycombinator.com/item?id=40391670 (2024-05-17)

> But keep in mind Cap'n Proto is not something I put out as a product. This confuses people a bit, but I don't actually care about driving Cap'n Proto adoption. Rather, Cap'n Proto is a thing I built initially as an experiment, and then have continued to develop because it has been really useful inside my other projects. [...] My main project (for the past 7 years and foreseeable future) is Cloudflare Workers [...] To be blunt, Workers' success pays me money, Cap'n Proto's doesn't. So I primarily care about Cap'n Proto only to the extent it helps Cloudflare Workers.

Note: Same thread: "the runtime itself is written in C++ [...] We did recently introduce an RPC system, and again it's built on Cap'n Proto under the hood, but the API exposed to JavaScript is schemaless, so Cap'n Proto is invisible to the app."

---

### On HTTP as a substrate: fundamentally one-way FIFO vs multi-directional async

Source: https://news.ycombinator.com/item?id=22962210 (2020-04-23)

> If it supports WebSocket, it should be relatively easy to layer Cap'n Proto RPC on top of that. [...] Otherwise, that's tough. HTTP is fundamentally a one-way, FIFO request-response protocol, whereas Cap'n Proto is multi-directional and asynchronous. Starting a separate HTTP connection for each call -- with connections initiated in both directions -- would be pretty ugly and have lots of issues with synchronization and routing.

---

### The time-travel demotion (a small piece of history)

Source: https://news.ycombinator.com/item?id=6897598 (2013-12-12, "Cap'n Proto 0.4: Time-traveling RPC")

> Someone with moderator rights must have read the summary, not read the documentation in detail, and decided that I had only implemented regular old promises/futures and was calling this "time travel". They probably missed the point of promise pipelining -- which is something that no mainstream RPC system implements to my knowledge, only research systems like CapTP. So they demoted it for making what they assumed to be a ridiculous claim about a mundane piece of software.
>
> Sigh.
