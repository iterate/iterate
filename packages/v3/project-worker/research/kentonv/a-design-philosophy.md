# Kenton Varda — General design philosophy & working style (Collector A)

Verbatim harvest from cloudflare/workerd + workers-sdk. workerd main @ `479771c30d10a04f468c68f80714cbf4c34b9d85` (2026-08-17). Catch-all for principles that transcend a single subsystem.

### "Worse is better" vs "better is better" — his explicit stance

Source: https://github.com/cloudflare/workerd/pull/302#discussion_r1106013436
Context: Defending the complex VFS abstraction in the SQLite bindings against a simpler string-paths approach.

> I would say that using string paths and the default VFS would be a "worse is better" approach -- simpler code, but warty and harder to test, with totally separate code paths needed in server.c++ to support unit testing vs. production. The approach I took instead is a "better is better" approach -- high complexity within `sqlite.c++` itself in order to provide a clean, consistent, object-oriented external-facing interface that supports abstraction and dependency injection, such that server.c++ need not have separate code paths for testing vs. production.

Note: The companion reasoning (same PR, discussion_r1099281692) explains why: if the test harness injects a different filesystem than production uses, "it's not testing exactly the same code that runs in production," which "erodes trust in the unit test."

### Exception-safety as reflex

Source: https://github.com/cloudflare/workerd/pull/302#discussion_r1099261378
Context: Reviewer noted RAII wasn't strictly needed in a spot.

> You're correct that exceptions aren't a concern here so it's not really necessary to write in RAII style, but I still prefer it because exception-unsafe code triggers me. (Also it saves the need to store the return value in a temporary variable...)

### Owning mistakes in public: Fetcher get/put/delete

Source: workerd@47a5e0db1c5cd75cd6efb6f960dfe306f8ec3aa9 (commit message, 2024-03-05)
Context: "Remove Fetcher methods get(), put(), delete() with compat flag."

> These were intended to be convenient wrappers around `fetch()` that perform the respective HTTP method. It was a bad idea (my fault). Luckily it was never documented and probably few people depend on it.

### The gRPC rant: protocol design should meet the web where it is

Source: https://github.com/cloudflare/workerd/issues/6455#issuecomment-4150474480
Context: Request for HTTP/2 bidirectional streaming (gRPC) support in Workers.

> &lt;rant&gt;
> gRPC made some terrible design choices.
>
> Browsers don't even support full-duplex HTTP today, nearly a decade after gRPC was released. And middlebox proxies -- even those supporting HTTP/2 -- regularly break full-duplex support, because there's no way to know if the app is expecting full-duplex to work, and supporting it makes a lot of other features (like WAF) hard to implement.
>
> gRPC also chose to use HTTP trailers, which are also supported by almost nothing.
>
> If gRPC had been based on WebSocket from the start, none of this would have been an issue. It would have "just worked" with everything.
> &lt;/rant&gt;
>
> workerd itself actually supports full-duplex HTTP (even though it only does HTTP/1.1 -- contrary to popular belief, full duplex does _not_ require HTTP/2). And our production environment supports speaking HTTP/2 to origin servers. But the full-duplexness gets lost in the proxy stack.

### Use the type system to make invalid states unrepresentable (union vs boolean-flag)

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1411130302
Context: RPC results were a byte array plus a "caughtException" boolean.

> I think that serializing both regular results and exceptions into the same `data` field, and using this separate `caughtException` boolean to decide which it is, is too easy to mess up. I'd prefer something like:
>
> ```
> struct Returned {
>   kj::Array<kj::byte> serializedValue;
> };
> struct ThrewException {
>   kj::Array<kj::byte> serializedException;
> };
> using SerializedResult = kj::OneOf<Returned, ThrewException>
> ```
>
> This makes it hard to write code that accidentally interprets an exception as a regular value or vice versa.

### Prefer switch-on-union over has() checks — let the compiler find unhandled cases

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1410993783
Context: Reviewing capnp union handling.

> Stylistic point, but if you use `switch (rpcResult.which())` to distinguish the two possibilities here, then if we ever grow the union with more options, we'll get a compiler error here telling us to extend the switch. Whereas if you use `hasException()`, this code will silently break when a new case is added. For this reason I almost always prefer to use a switch when handling a union rather than use `has`.

### Classes should almost never have public member variables

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1312373900
Context: Routine review comment; stated as a rule.

> I would also make it private and provide an accessor method. Classes should almost never have public member variables.

### Schema/table cleanup is cheapest before anything is written to disk

Source: https://github.com/cloudflare/workerd/pull/6104#discussion_r2856042186
Context: Per-namespace alarm DBs made a per-row `actor_unique_key` column redundant.

> But now that we store a separate database per namespace, we don't really want that anymore. It's just wasting bytes and potentially causing headaches if someone wants to change keys or something.
>
> Seems like we should update the `AlarmScheduler` implementation to remove the redundant functionality.
>
> This is something that's best to do now, not later after a bunch of these tables have already been written to disk...

### Don't spend time polishing what nobody will read

Source: https://github.com/cloudflare/workerd/pull/4123#discussion_r2146052914 and #discussion_r2146068642
Context: Review nitpicks on the facets PR.

> As a rule I don't think it's worth spending time to fix typos like this in internal comments where the meaning is not ambiguous.

> I agree it would nicer that way but I don't really feel it's worth spending time on. Probably nobody will ever read this test again. :)

### Discuss designs before writing big PRs

Source: https://github.com/cloudflare/workerd/pull/6101#issuecomment-3921322807
Context: Closing an unsolicited large community PR (also filed under a-durable-objects).

> In the future, I'd recommend opening a discussion (or comment on the existing issue) to discuss any proposed designs before putting in the work to implement them. I guess with AI it's probably less of a big deal these days, but I still feel bad turning down a big PR like this...

### Serialization formats you haven't committed to should stay legally changeable

Source: https://github.com/cloudflare/workerd/pull/302#issuecomment-1537177829
Context: Someone asked how to parse the DO SQLite value encoding.

> It's V8 serialization. I believe Node's v8 serializer library should be able to parse them. [...] Please do not rely on this format staying the same, though.

### Dogfooding as prioritization: the tech lead hits the bug too

Source: https://github.com/cloudflare/workers-sdk/issues/12901#issuecomment-4061754066 and #issuecomment-4084054461
Context: He filed the wrangler remote-bindings timeout issue himself, then pushed on priority.

> Just want to emphasize here: this is a lot more painful than it sounds. This is really bad UX for anyone developing against Workers AI or AI Gateway (or any other remote bindings). I think it's pretty important that we prioritize fixing this.

> This bites me every day and I'm the tech lead for Workers so don't worry, we're gonna get this fixed. :)

### UX bugs live in what the user could actually see

Source: https://github.com/cloudflare/workers-sdk/issues/10452#issuecomment-3832388174
Context: Wrangler's "report this error to Cloudflare?" prompt was accepted by a stray Enter.

> The bug here is not that the default is "yes". The bug is that the prompt _is not displayed on the screen_ at the time that wrangler is accepting the input.

### AI as a debugging tool, measured like any other tool

Source: https://github.com/cloudflare/workerd/pull/6104#issuecomment-4100752615 and #issuecomment-4100809525
Context: A Windows-only CI failure with no symbolized stack; he ran a blind-debugging bake-off.

> I've sent both Opus 4.6 and GPT 5.4 off to carefully read the code and try to blind-debug the Windows issue, since I don't have a Windows machine available.

> They both got it.
>
> ChatGPT 5.4: 99k tokens (7 minutes)
> Claude Opus 4.6: 129k tokens (23 minutes)
>
> I think Opus is running a little slow today, maybe overloaded, but GPT is the clear winner either way.

Note: Same pattern in commit messages: workerd@f58c99c05 "This was debugged and fixed using Claude+OpenCode. The AI-authored description follows." and PR #6780: "Opus 4.6, Opus 4.7, and GPT 5.5 were all involved in this PR, though quite a lot of manual editing occurred as well." and workerd@e7b2192c4 "(Bug identified, fixed, and tested by Fable 5.)"

### Verify authority, not confidence, in public threads

Source: https://github.com/cloudflare/workerd/issues/6455#issuecomment-4189456754 and #issuecomment-4189615939
Context: An AI-generated "helpful" diagnosis in the gRPC thread.

> @Divkix I appreciate that you're trying to help, but the problem is actually quite different from what your AI is telling you. Please leave it to us on the Workers Runtime team, we know what is needed here.

> @arbuthnot-eth Be sure to look for the "Member" badge on comments to verify it's from a team member. :)

### Not implemented ≠ objection: name the actual blocker

Source: https://github.com/cloudflare/workerd/issues/2240#issuecomment-3638305175
Context: On the years-old `ctx.id.name` request.

> To be clear, the reason this hasn't been implemented is not because anyone objects to the idea, but simply because there is surprising complexity in the implementation and not enough eng-hours to work on it. We do intend to get to it eventually but I'm not sure when.

### Release discipline: compat-date defaults must account for review latency

Source: https://github.com/cloudflare/workerd/pull/6197#discussion_r2895887873
Context: Reviewing a proposed default-on date for a new compat flag.

> This date needs to be pushed later due to code review latency, maybe set it to a month out so we don't have to bump it again.

### Flag naming should read without thinking

Source: https://github.com/cloudflare/workerd/pull/6197#discussion_r2895883112
Context: Same PR; renaming a confusing compat flag.

> I'm finding it really hard to understand this flag name without a lot of thinking.
>
> Maybe:
>
> - Enabled: `web_socket_automatic_reply_to_close`
> - Disabled: `web_socket_manual_reply_to_close`

### Error classification: user errors are JSG_REQUIREs, not Sentry noise

Source: https://github.com/cloudflare/workerd/pull/1028#discussion_r1298895316 and pull/6443#discussion_r3002828668
Context: A recurring review theme — application errors and runtime errors go to different places, and parsing code must not be duplicated.

> These should probably be `JSG_REQUIRE`s -- it's an application error, not something we want to log to Sentry.

> Is this actually any different than `isTunneledException()` in practice? Even if it is, please extend `tunneledErrorType()` to cover what you want, and have this function call it. Currently you've implemented entirely new, separate parsing code, duplicating the code that already exists -- let's not do that.

### Delegate to the existing path so new properties can't be forgotten

Source: https://github.com/cloudflare/workerd/pull/6730#discussion_r3229265127
Context: Review of jasnell's `new Request(Proxy(Request))` sketch.

> Instead of reproducing all this logic here, it would be nice if we could delegate to the existing `RequestInit` path. Only the `url` needs special handling.
>
> Otherwise it's easy to forget to add new properties here.
