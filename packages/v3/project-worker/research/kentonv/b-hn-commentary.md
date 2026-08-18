# Kenton Varda — Hacker News commentary on Workers, isolates, serialization, platform design (Collector B)

Harvested 2026-08-18 via HN Algolia (`author_kentonv`, topic queries; ~1150 comments scanned, longest/most substantive selected). All blockquotes verbatim. DO-specific comments live in `b-durable-objects-design.md`; ocap comments in `b-ocap-philosophy.md`; Cap'n Proto/RPC history in `b-capnproto-rpc.md`.

---

### V8 isolates vs process isolation: the trade-off, stated fully

Source: https://news.ycombinator.com/item?id=31759342 (2022-06-15, "Ask HN: Pros and cons of V8 isolates?")

> When it comes to Cloudflare Workers, the performance penalty for strict process isolation is much higher than it is for a browser, due to the finer-grained nature of our compute. (Imagine a browser that has 10,000 tabs open and all of them are regularly receiving events, rather than just one being in the foreground...) But we have some advantages: we were able to rethink the platform from the ground up with side channel defense in mind, and we are free to reset the state of any isolate's state any time we need to. That lets us implement a different set of defense-in-depth measures, including dynamic process isolation.
>
> I may be biased, but to be perfectly honest, the security model I find most terrifying is the public clouds that run arbitrary native code in hardware VMs. The VM software may be a narrower attack surface than V8, but the hardware attack surface is gigantic. One misimplemented CPU instruction allowing, say, reading physical addresses without access control could blow up the whole industry overnight and take years to fix. Spectre was a near miss / grazing hit. M1 had a near miss with M1racles. I think it's more likely than not that really disastrous bugs exist in every CPU, and so I feel much, much safer accepting customer code as JavaScript / Wasm rather than native code.

---

### There is no "secure enough" threshold — only trade-offs

Source: https://news.ycombinator.com/item?id=32297368 (2022-07-31, "Hello Isolates" thread)

> This question assumes that there exists some threshold of "rigorous security standards" which clearly separates "secure" from "insecure". There's no such threshold. We know that risks always exist. No one can precisely quantify those risks. We can only sort of abstractly debate about which risks might be large, and take precautions by addressing those risks with defense-in-depth measures. Each such measure must, of course, be weighed against the costs [...]
>
> In Cloudflare Workers' case, the cost of isolating every Worker in its own process would be much higher. We actually have the ability to do such isolation, and we selectively apply it in cases where we have other signals to suggest that risk may be elevated (such as when the Worker's performance characteristics suggest it may be engaging in a Spectre attack). But because Workers are designed to handle fine-grained events and often run for less than a millisecond at a time, the overhead of this isolation is much higher than in Chrome's case. The exact overhead depends on what the Worker is doing, but 5x-10x is typical (both for CPU and memory). [...]
>
> Some people respond to this with "You can't sacrifice security for performance!!!", but this is naive. Again, all of the big cloud providers are trading off a whole lot of security risk for performance when they choose to run untrusted native code. In the real world we always make trade-offs.

---

### Determinism as a side-channel defense (2017, before Spectre)

Source: https://news.ycombinator.com/item?id=15365494 (2017-09-29, Workers launch thread)

> There is a theoretical solution that we might be able to explore at some point: If compute is deterministic -- that is, always guaranteed to produce the same result given the same input -- then it can't possibly pick up side channels. It's possible to imagine a Javascript engine that is deterministic. The fact that Javascript is single-threaded helps here. In concrete terms, this would mean hooking Date.now() so that it stays constant during continuous execution, only progressing between events.

Note: This became the shipped design (frozen clocks during execution) — stated here months before Spectre was public.

---

### How the runtime attributes I/O to requests — and why "script will never generate a response" exists

Source: https://news.ycombinator.com/item?id=34990668 (2023-03-02)
Context: The definitive explanation of Workers' request-context model; "I'm the tech lead for Workers and this strange behavior is my fault."

> Whenever a Worker initiates some sort of external I/O -- such as invoking `fetch()` -- the I/O task is associated with the incoming request that was running at the time. If the incoming request is canceled, then all outgoing I/O tasks associated with it are also canceled. [...]
>
> Related: The way the runtime knows which request is running is that it always knows what I/O event caused it to start executing JavaScript, and every time it starts executing JavaScript, it always keeps running until either the microtask queue is empty, or the time limit is hit [...] All these microtasks are necessarily downstream effects of the original I/O event that started them [...]
>
> These assumptions break, though, when requests share Promises via the global scope. If request A awaits a promise, and request B later resolves that promise, the code in request A continues running... but the runtime still thinks it is running on behalf of request B. [...]
>
> "The script will never generate a response" happens when the runtime sees that it has finished executing all the JavaScript microtasks for a particular request, and no I/O operations have been scheduled. In this case, the runtime correctly concludes that there is no possible way for new microtasks to be executed on behalf of this request ever again [...]
>
> The easiest and best way to avoid it is to never modify anything in the global scope. If a request never modifies global scope, then there's no way another request could get ahold of its objects, particularly its promises.
>
> That said, the situation obviously isn't intuitive and we'd like to improve here. What I'm really hoping is that we can find a way to efficiently run every request in a "fresh state", so requests cannot see each other's effects at all. But, literally creating an isolate per request would be too expensive; we need something a bit more clever than that.

---

### One isolate, many concurrent requests

Source: https://news.ycombinator.com/item?id=23969326 (2020-07-27, Workers Unbound thread)

> JavaScript is inherently single-threaded, so an isolate can only be executing code on behalf of one request at a time. That said, it is already the case that multiple concurrent requests may be handled by the same isolate (one request may be executing while another is e.g. waiting for a response from a remote server).

Note: Same comment reveals WebSocket support was blocked on billing, not tech: "the only reason we haven't rolled out WebSocket support already is because it's not very useful without long-running CPU."

---

### Workers Cache redesign: entrypoints, ctx.exports, and channel tokens

Source: https://news.ycombinator.com/item?id=48806343 (2026-07-06, Workers Cache thread)
Context: Why the standard Cache API was wrong, and the architecture that finally enabled the fix — directly relevant to worker-composition design.

> We implemented the "standard" Cache API back in the early days because it was a standard [...] But it was never a good fit. The get/put API was designed for a local browser cache, not a distributed cache like Cloudflare's. [...]
>
> Gory details for the curious: We've been improving the infrastructure around the notion of workers having multiple "entrypoints", with the ability to parameterize those entrypoints. ctx.props and ctx.exports are part of this. A lot of this was motivated by Dynamic Workers sandboxing, but the concept also presents a clean way to inject a cache between two parts of the same worker, by applying it to the entrypoint and having the worker call itself using ctx.exports.
>
> Moreover, the introduction of "channel tokens" made a big difference. Essentially I created a way to encode a token (bytes) representing an arbitrary entrypoint to a Worker, complete with its serialized parameters. I did this to enable these entrypoint stubs to be passed over RPC, which is again useful for sandboxing use cases, but it also created a convenient, encapsulated way to pass information through our cache infrastructure about what worker should run at the other end.

Note: Pricing companion comment (48807399): "in terms of our costs, it's often cheaper for us to run your Worker than to serve from cache. [...] we've built an architecture such that running a Worker is extremely cheap, almost free."

---

### The `required` lesson: validation must happen at the point of consumption

Source: https://news.ycombinator.com/item?id=32818948 (2022-09-12, Protobuf spec thread)
Context: From the ex-maintainer of Protobuf v2 — the origin story of "required considered harmful", generalized into a schema-evolution principle.

> I would argue that a much more important power of these systems is their ability to manage change. It's extremely hard to fully test what happens when two different versions of your code interact. [...]
>
> The genius of Protobuf (which Cap'n Proto mostly copied) is that it's pretty easy to reason logically about how a change will interact with older versions of the code. You add a new field, you know old code will just ignore it, and new code receiving data from old code will fill in the default value. It's rare -- surprisingly rare, to be perfectly honest! -- that people can't reason through this in their head.
>
> The problem with `required` was that the implications of changing it were not intuitive, because it's not intuitive that it had implications for servers that don't even inspect the field in question.
>
> The lesson for me is that validation has to happen at the point of consumption. You should not try to validate your data early in the pipeline because your validation rules will likely become out-of-sync with what the consumer actually wants over time. The only way to maintain sync is for the consumer itself to decide whether the data meets its requirements. This makes a lot of theorists uncomfortable, but I've seen in play out in practice so many times...

---

### Cycles and backreferences in serialization = DoS surface

Source: https://news.ycombinator.com/item?id=11030323 (2016-02-03, ION format thread)

> While it's true that Protobuf doesn't support these, I hope you've considered the denial-of-service vulnerabilities they tend to create if the receiver is not expecting them. Please ensure that cyclic references are only allowed in cases where the app opted into it.
>
> Relatedly, overlapping references / backreferences ("Copy" in your table) potentially leads to an amplification attack where a small message on the wire turns out to be much, much larger when traversed. If applications cannot defend themselves from huge payloads by setting a message size limit, then you'll need to give them some other way.

Note: This is why Cap'n Web "emphatically refuses" cycles (see b-capnweb.md) even though structured clone supports them — and why he plans to _remove_ cycle support from Workers RPC (README: "This can actually cause problems, so we actually plan to remove this feature from Workers RPC (with a compatibility flag, of course).").

---

### Cloudflare OS Gatekeepers: capability connectors with simulated approvals

Source: https://news.ycombinator.com/item?id=49183703 (2026-08-05, Cloudflare OS thread; quoting his linked tweet chain)
Context: His newest platform design — connectors as Cap'n Web RPC capabilities rather than MCP tools, with human-in-the-loop that doesn't block the agent.

> Of course, personal apps are more useful if they can connect to external services. Cloudflare OS introduces a "connector" system we call Gatekeepers. This is sort of like MCP (and MCP is supported as a kind of Gatekeeper), but with a lot more:
>
> - Instead of exposing tools, a Gatekeeper exposes a Cap'n Web RPC API. That makes it appropriate for use by both agents (via code mode) and Gadgets.
> - Gatekeepers integrate with the Cloudflare OS UI to provide inline audit logging and human-in-the-loop approvals for all side-effecting actions.
> - When an action requires approval, the agent does not need to stop and wait for it. A Gatekeeper will simulate the outcome, allowing the agent to keep running and queue up more work. You can then approve everything in a batch at the end. Hopefully, this means you no longer feel the need to turn on auto-approve! (But you still can if you want.)
>
> We have already built Gatekeepers for a huge number of services, from GitHub to Home Assistant. We've found, with the right skills, AI can basically crank these things out for any given API, solving the chicken-and-egg ecosystem problem.

---

### Open-sourcing the runtime but not the scheduler

Source: https://news.ycombinator.com/item?id=46012008 (2025-11-22, Zed Cloud thread)

> None of these schedulers are open source. Not Deno Deploy, not Supabase, and yeah, not ours either. Standard practice here is to offer an open source local runtime that can be used with other schedulers, but not to open source the cloud scheduler itself.
>
> [...] I will also note, if we actually open sourced the tech, I think you'd find it not as useful as you imagine. It's really designed for running a whole multi-tenant hosting service (across a globally distributed network) and would be massive overkill for just hosting your own code. workerd is actually better for that.

---

### "Pretty maniacal about backwards compatibility"

Source: https://news.ycombinator.com/item?id=45593203 (2025-10-15, Workers CPU benchmarks thread)

> Personally I pushed back on bumping the major version at all, because I know even a no-op major version update creates pain. [...] We have resolved, though, that in the future we'll build ways to manage all these issues without requiring a major version bump [...]
>
> Incidentally, on the runtime side especially, we're pretty maniacal about backwards compatibility: https://blog.cloudflare.com/backwards-compatibility-in-cloudflare-workers/

---

### Chrome site-isolation history, correctly told

Source: https://news.ycombinator.com/item?id=18424734 (2018-11-11, "Cloud Computing Without Containers")

> Chrome has had the ability to run separate tabs in separate processes since day 1. However, quite often, JavaScript from separate web sites would end up running in the same process. Specifically, (i)frames, popup windows, and sometimes tabs created by a site would run in the same process as the creating site [...] In this case, in fact, the sites would run in the same V8 isolate. The only separation was "context" separation [...]
>
> Chrome started working on Site Isolation before Spectre, but Spectre accelerated interest in it. My take is that Spectre is probably not the main reason that the Chrome security people (who are awesome, BTW) want to do it, but it provided a great excuse to rally support behind it.

Note: Companion detail from 31759342: "When Spectre hit, Chrome concluded that defending the web platform from Spectre in userspace was too hard, so they decided to go all-in on process isolation so that Spectre was the kernel's problem instead."

---

### Isolates make "start the app where the request landed" cheaper than routing to a warm copy

Source: https://news.ycombinator.com/item?id=43026231 (2025-02-12, "WASM will replace containers")

> Cloudflare Workers run in V8 isolates, which are much lighter-weight than containers, with the ability to run thousands in the same process, and start up new ones quickly on-demand. For Cloudflare it's usually easier to start your application on the machine where it is requested, than to try to route to a machine where it's already running.
>
> The API construct that lets a worker call another worker (in the same process, in fact, in the same thread) is a Service Binding [...] This is one type of "binding" or "live environment variable" or "capability".
