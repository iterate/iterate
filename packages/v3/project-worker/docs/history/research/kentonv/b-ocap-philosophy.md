# Kenton Varda on object capabilities — Sandstorm-era and platform writing (Collector B)

Harvested 2026-08-18 from Hacker News (Algolia, `author_kentonv`) and Cloudflare blog posts he authored. All blockquotes verbatim.

---

### OOP patterns ARE security patterns — the core ocap argument

Source: https://news.ycombinator.com/item?id=10686990 (2015-12-06, "Capability Based Security")
Context: Probably his single best compact statement of the ocap worldview, written during the Sandstorm years.

> The brilliant thing about capability-based security is that it turns classic object-oriented programming patterns into security patterns.
>
> Access control is implemented by encapsulating private members behind a restricted public interface.
>
> Polymorphism allows you to add wrappers around an object implementing arbitrary security policies. E.g. want to revoke access to this object after some time? Add a wrapper where the methods forward to the real object until revoked, and then throw exceptions instead.
>
> What's interesting is that these are patterns we are doing anyway, in real code, not for the purpose of security but for the purpose of correctness and maintainability. Because we were doing these things anyway, our programming languages provide really good tools for making them work naturally, and we already know how to think about them.
>
> On the other hand, the competing model -- access control lists (ACLs), and other types of externally-specified policy -- are not things we were doing anyway. They're external concepts bolted into the system awkwardly. Because of this, they tend to be painful to maintain, which in turn means people often don't bother.
>
> One of the clearest examples of how ACLs go against the grain: An ACL is a list of entities who are allowed to access a resource. These are effectively pointers pointing in the opposite direction of all other pointers in the system: ACLs point from the callee to the caller. This creates all kinds of problem. Just try to imagine how, in a programming language, you would specify the allowed callers of your object.

---

### The Google Docs sharing example: grant should ride the notification

Source: https://news.ycombinator.com/item?id=10686990 (same comment, continued)

> This translates to UX, too: Say you are using Google Docs, and you want to "share" access to a document with Alice. Traditionally this is seen (by the implementers -- I was once on the Google Docs sharing team) as a two-step process:
>
> 1. Grant access: Add Alice to the access control list.
> 2. Notify: Send Alice an e-mail notifying her that she should open the document.
>
> Part 2 is obviously necessary and natural. You intuitively know you must tell Alice about your document. Part 1 may sound obvious to any techie, but it's not at all: Users regularly forget this step, and we build all kinds of UI to try to recover from this. [...]
>
> What we really want to do is eliminate part 1 and have only part 2: Abstractly, when you notify Alice of the document, that notification should itself contain the permission to access the document. [...] (This is analogous to sending a pointer in code -- receiving the pointer grants the recipient the ability to access the pointed-to object.)
>
> This is the essence of capability-based security at the UX level: Deriving access control from actions you were already doing. The user rarely needs to be confronted with a security action, yet the right people end up getting access.
>
> Some will argue that such implicit security is inherently dangerous because it's hard to audit and control. I argue that "explicit" security is dangerous because it's hard for users to understand and use correctly -- inevitably, many will simply turn the security off.
>
> But there's a compromise: If the underlying system deeply understands capabilities and knows when they are being passed, it can maintain an "access control list" on the side, automatically populating it based on the observed movement of capabilities. This pseudo-ACL can allow the user to audit who has access to their document and revoke people who shouldn't be there. It also offers a place to hook in policies: if the system observes a capability movement that is contrary to some explicit policy (say, "documents shall not be shared outside the organization"), then it can revoke that capability.

Note: The "pseudo-ACL populated by observed capability movement" idea is directly applicable to any platform that wants audit + revocation on top of ocap sharing.

---

### Capabilities vs. tokens vs. RBAC; confused deputies; Linux "capabilities" are misnamed

Source: https://news.ycombinator.com/item?id=10687278 (2015-12-06, same thread)
Context: Debating a proposal to merge "Capability Based Security" into "RBAC" on Wikipedia.

> A good capability system does not assign authority to a secret sequence of bits, but rather is based on communications protocols where capabilities are explicitly recognized as they pass between contexts. For example, a unix file descriptor is a sort of capability, but its numeric value is not a secret token. It's secure because only the process which possesses the descriptor can access it using that number. You can pass file descriptors between processes, and the OS knows that the transfer is happening and assigns a new number to the object in the new process.

> A capability is both a pointer to a resource and a grant of access to that resource. A capability is the subject of an operation. [...]
>
> A fundamental difference between capability systems and identity systems is "ambient authority". In an identity system, you are authorized to perform a request simply because of who you are. It's "ambient".
>
> Consider how you delegate access to someone else in the two systems:
>
> - In an ACL system, Alice adds Bob to the ACL for a resource, and then asks that Bob to perform an operation on her behalf. However, if Alice is malicious she could request that Bob perform an operation on some other resources which Alice never had access to but Bob did. This is called a confused deputy attack. Bob must carefully check that Alice has the correct permissions on the resource before acting on her behalf.
> - In a capability system, Alice sends Bob her capability and then asks Bob to access it. There is no risk of confused deputy because there is no way for Alice to instruct Bob to use a capability that he has but Alice doesn't.

> Linux OS-level capabilities are NOT capability-based security. This is a common misconception -- Linux/POSIX capabilities were misnamed by people who didn't understand the capability-based security model which predated them.

---

### What a capability is, and the Sandstorm Powerbox

Source: https://news.ycombinator.com/item?id=7462713 (2014-03-24, Sandstorm launch thread)

> A "capability" is just an object reference, like a pointer in your favorite programming language, except that a capability not only identifies the object it points to, but also confers permission to use the object. So if you receive a capability, you can use it. If you don't have the capability, you can't use it.
>
> [...] In terms of Sandstorm, an app will be able to say "Hey platform, I have an object here that implements this Cap'n Proto interface 'Foo'. Here's a capability (pointer) to it. The user may redistribute this capability at their discretion." Later on, another app may say "Hey platform, I need a capability that implements interface 'Foo'." Then, the platform presents the user with a UI listing all of their matching capabilities and asking them which one to use.
>
> The brilliant bit here is that when the user makes a choice, the platform then hands that capability to the app, and all of the access control _just works_. No need for an OAuth dance, no need to ask the user "Do you want to permit this?" -- obviously they do, otherwise they wouldn't have made the choice. From the point of view of both apps and the user, the whole interaction is trivial. And, critically, the permissions transferred were only for the specific object the user chose, as opposed to broad permissions for the second app to manipulate the first. No "I need access to your contact list, so that I can display a picker for you to choose which friends to invite", instead it's just "Please use the system picker to choose which friends to invite, and I'll never see anyone you didn't select in the first place."

---

### Live refs vs. sturdy refs; why Sandstorm rejected offline attenuation (macaroons)

Source: https://news.ycombinator.com/item?id=9499800 (2015-05-06, "Delegation Is the Cornerstone of Civilization")

> When you have an open Cap'n Proto RPC connection and have received a capability (object reference) over that connection, that's called a "live ref". Cap'n Proto allows live refs to be passed from machine to machine (delegated) in RPC messages. But if the connection dies, all live refs are lost. So, to keep it long term, you want to convert it to a "study ref", which is a byte string you can save to disk.
>
> A sturdy ref, however, can only be restored to a live ref by the same entity who saved it, where "entity" is some course-grained authenticatable identity. The idea here is that if a hacker manages to obtain a raw copy of your database, you don't want to have to revoke every sturdy ref contained therein. A course authentication component prevents them from doing anything with any of those tokens.
>
> [...] Macaroons are also a byte string that grant access to a resource, with a format that allows you to attenuate the capability offline. [...] For Sandstorm, we actually don't quite want that, because we want the document owner to be able to see how their document has been shared. So, to share a sturdy ref, we require you to restore it to a live ref and delegate that. The recipient can save a new sturdy ref tied to them.

Note: "Delegation is even more important between apps than it is between users, because we want to be able to write small, modular apps that work together rather than monolithic apps." (same comment)

---

### SturdyRefs don't belong in the RPC protocol — persistence is platform-specific

Source: https://news.ycombinator.com/item?id=45334797 (2025-09-22, Cap'n Web launch thread)

> SturdyRefs are tricky. My feeling is that they don't really belong in the RPC protocol itself, because the mechanism by which you restore a SturdyRef is very dependent on the platform in which you're running. Cloudflare Workers, for example, may soon support storing capabilities into Durable Object storage. But the way this will work is very tied to the Cloudflare Workers platform. Sandstorm, similarly, had a persistent capability mechanism, but it only made sense inside Sandstorm – which is why I removed the whole notion of persistent capabilities from Cap'n Proto itself.
>
> The closest thing to a web standard for SturdyRefs is OAuth. I could imagine defining a mechanism for SturdyRefs based on OAuth refresh tokens, which would be pretty cool, but it probably wouldn't actually be what you want inside a specific platform like Sandstorm or Workers.

---

### Bindings: designation + permission in one move; "there is no step 2"

Source: https://blog.cloudflare.com/workers-environment-live-object-bindings/ ("Why Workers environment variables contain live objects", Kenton Varda)
Context: The Workers-platform incarnation of the ocap philosophy — how env bindings kill SSRF, API keys, and ACL management at once.

> Much of this pain comes about because connecting a server to a resource today involves two steps that should really be one step:
>
> - Configure the server to point at the resource.
> - Configure the resource to accept requests from the server.
>
> Developers are primarily concerned with step 1, and forget that step 2 exists until it blows up in their faces. [...]
>
> What if step 1 just implied step 2? Obviously, if you're trying to configure a service to access a resource, then you also want the resource to allow access to the service. As long as the person trying to set this up has permissions to both, then there is no reason for this to be a two-step process.
>
> But in typical platforms, the platform itself has no way of knowing that a service has been configured to talk to a resource, because the configuration is just a string.
>
> Bindings fix that. When you define a binding from a Worker to a particular KV namespace, the platform inherently understands that you are telling the Worker to use the KV namespace. Therefore, it can implicitly ensure that the correct permissions are granted. There is no step 2.
>
> And conversely, if no binding is configured, then the Worker does not have access. That means that every Worker starts out with no access by default, and only receives access to exactly the things it needs. Secure by default.

On SSRF:

> But using bindings, this is impossible: There is no URL that the attacker can specify to reach the auth service. The application must explicitly use the binding env.AUTH_SERVICE to reach it. The global fetch() function cannot reach the auth service no matter what URL it is given; it can only make requests to the public Internet.

On keys:

> With Workers bindings, we endeavor for bindings to be live objects, not secret keys. For instance [...] when using a Workers KV binding, you never see a key at all. It's therefore impossible for a Worker to accidentally leak access to a KV namespace.

---

### "Is this capability-based security?" — his own honest scoring of bindings

Source: https://blog.cloudflare.com/workers-environment-live-object-bindings/ (Q&A section)

> Bindings are very much inspired by capability-based security.
>
> At present, bindings are not a complete capability system. In particular, there is currently no particular mechanism for a Worker to pass a binding to another Worker. However, this is something we can definitely imagine adding in the future.
>
> Imagine, for instance, you want to call another Worker through a service binding, and as you do, you want to give that other Worker temporary access to a KV namespace for it to operate on. Wouldn't it be nice if you could just pass the object, and have it auto-revoked at the end of the request? [...]
>
> For the time being, bindings cannot really be called object capabilities. However, many of the benefits of bindings are the same benefits commonly attributed to capability systems. This is because of some basic similarities:
>
> - Like a capability, a binding simultaneously designates a resource and also confers permission to access that resource, without referencing any separate ACL.
> - Like capabilities, bindings do not exist in any global namespace: they are scoped to the env object passed to a specific Worker.
> - Like a capability, to use a binding, the application must explicitly specify which binding it is trying to use [...] In particular, the application does not separately specify the name of the resource in any other namespace (no URL, no global ID, etc.).

---

### The ACL-management rant (why "allow all" always wins)

Source: https://blog.cloudflare.com/workers-environment-live-object-bindings/ ("No frustrating ACL management" section)

> Many platforms use ACLs for security, but have you ever noticed how everyone hates them? You end up with two choices:
>
> - Tediously maintain ACLs on every resource. Inevitably, this is always a huge pain. First you deploy your code, which you think is properly configured. Then you discover that it's failing with permissions errors causing a production outage! So you go fiddle with the IAM system. There are 533,291 roles to choose from and none of them are actually what you want. [...] (Why yes, all this did in fact happen to me, while using a cloud provider that shall remain nameless.)
> - Give up and grant everything access to everything. Just put all your services in a single VPC where they can all freely talk to each other. This is what most developers are inclined to do, if their security team doesn't step in to stop them.

---

### The authenticate() pattern: security you cannot forget to apply

Source: https://blog.cloudflare.com/javascript-native-rpc/ ("Did you spot the security?") — same pattern restated in the Cap'n Web launch post

> But there's another extremely important property that the AuthService API has which you may have missed: As designed, you cannot perform any operation on a user without first checking the cookie. This is true despite the fact that the individual method calls do not require sending the cookie again, and the User object itself doesn't store the cookie.
>
> The trick is, the initial checkCookie() RPC is what returns a User object in the first place. The AuthService API does not provide any other way to obtain a User instance. The RPC client cannot create a User object out of thin air, and cannot call methods of an object without first explicitly receiving a reference to it.
>
> This is called capability-based security: we say that the User reference received by the client is a "capability", because receiving it grants the client the ability to perform operations on the user. [...]
>
> Capability-based security is often like this: security can be woven naturally into your APIs, rather than feel like an additional concern bolted on top.

Cap'n Web blog variant adds the WebSocket-auth angle:

> This is a common pain point for WebSockets in particular. Due to the design of the web APIs for WebSocket, you generally cannot use headers nor cookies to authorize them. Instead, authorization must happen in-band [...] The authenticate() pattern shown above neatly makes authentication fit naturally into the RPC abstraction. It's even type-safe: you can't possibly forget to authenticate before calling a method requiring auth, because you wouldn't have an object on which to make the call.

---

### Named entrypoints: deploy-time topology instead of in-app auth

Source: https://blog.cloudflare.com/javascript-native-rpc/ ("More security: Named entrypoints")

> A named entrypoint is only accessible to Workers which have explicitly declared a binding to it. By default, only Workers on your own account can declare such bindings. Moreover, the binding must be declared at deploy time; a Worker cannot create new service bindings at runtime.
>
> Thus, you can trust that requests arriving at a named entrypoint can only have come from Workers on your account and for which you explicitly created a service binding. [...] With these tools, there is no need to write code in your app itself to authenticate access to internal APIs; the system does it for you.

---

### RPC as trust boundary: the bindings marketplace idea

Source: https://blog.cloudflare.com/javascript-native-rpc/ ("The future: Custom Bindings Marketplace?")

> Previously, we thought this would require creating a way to automatically load client libraries into the calling Workers. That seemed scary: it meant using someone's binding would require trusting their code to run inside your isolate. With RPC, there's no such trust. The binding only sees exactly what you explicitly pass to it. It cannot compromise the rest of your Worker.
>
> Could Workers RPC provide the basis for a "bindings marketplace", where people can offer rich JavaScript APIs to each other in an easy and secure way? We're excited to explore and find out.

---

### Most successful sandboxes are capability systems (you just don't hear about it)

Source: https://news.ycombinator.com/item?id=47556408 (2026-03-28, "Capability-Based Security for Redox")

> Cloudflare Workers is a big on capabilities.
>
> The recently released Dynamic Workers directly provides an API for capability-based sandboxing [...] But the platform has used caps internally all along. Cloudflare makes heavy use of Cap'n Proto [...] a capability-based RPC protocol, and recently released Cap'n Web [...] The "Cap'n" in both is short for "Capabilities and". (Dynamic Workers sandboxing is based around Cap'n Web capabilities.)
>
> Most successful sandboxes use capabilities, though it's not often something you hear about. Android's IPC system, Binder, is a capability system. And Chrome has a capability-based IPC system called "Mojo".
>
> Capabilities really shine when used for sandboxing, but here's a blog post I wrote that tries to explain the benefits beyond sandboxing: https://blog.cloudflare.com/workers-environment-live-object-bindings/

---

### Ocap people are event-loop people

Source: https://news.ycombinator.com/item?id=45346437 (2025-09-23, Cap'n Web launch thread)

> Almost all ocap systems seem to use event loops -- and many of the biggest ocap nerds I know are also the biggest event loop nerds I know. I'm not actually sure if this is a coincidence or if there's something inherent that makes it necessary to pair them.
>
> But one thing I can't figure out: What would be the syntax for promise pipelining, if you aren't using promises to start with?

---

### On remote object identity (it's harder than it looks)

Source: https://news.ycombinator.com/item?id=46302100 (2025-12-17, D-Bus thread)

> FWIW Cap'n Proto objects can implement multiple interfaces. That said, identity of remote objects is a surprisingly complicated subject, and at present it's not necessarily possible to tell whether two references point to the same object.

Note: The full solution is Level 4 `Join` in rpc.capnp — capability equality via key-part XOR across paths (see b-capnproto-rpc.md context; rpc.capnp lines 886–954).
