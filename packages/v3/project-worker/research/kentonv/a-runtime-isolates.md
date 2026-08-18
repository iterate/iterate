# Kenton Varda — Runtime, isolates, memory, processes (Collector A)

Verbatim harvest from cloudflare/workerd + workers-sdk. workerd main @ `479771c30d10a04f468c68f80714cbf4c34b9d85` (2026-08-17).

### The real cost of an isolate, and why continuation-serialization is the wrong fix

Source: https://github.com/cloudflare/workerd/issues/6595#issuecomment-4276737631
Context: RFC proposing a BEAM-style continuation model to run 24M agents; Kenton's response is a compact statement of the isolate cost model.

> > Each isolate keeps ~183KB alive regardless of whether the Worker is actively executing or waiting for I/O.
>
> I have no idea how you got this number but the actual number is more like 5MB. I don't think your benchmark is testing the right thing.
>
> > A continuation-based execution model for Workers: when an agent hits await, serialize only the live variables (~191–320 bytes) and release the execution context. Resume from the continuation when I/O completes.
>
> The size of the "live variables" obviously depends entirely on the workload -- only a very simple workload would have "191-320 bytes" of live context. For anything more complicated, this approach presumably gets very expensive as the in-memory state grows, as you end up serializing and deserializing everything on every I/O. Moreover, you presumably need to set up a new execution environment (isolate) every time you want to deserialize the state to run a continuation, and that is presumably pretty expensive. So you are trading a _lot_ of CPU time here to drive a memory benefit for certain workloads.
>
> The _right_ way to do this is to design a JS engine which minimizes memory usage without the need to do any serialization / parsing on every I/O. The engine's heap representation should _already_ contain just the "live variables" and nothing else. In theory this is possible, but to actually implement the JS language, you would need some way to keep the built-in objects off of the heap unless the app code actually modifies them -- some sort of copy-on-write. Otherwise, the built-ins alone occupy quite a bit of space. Unpacking the built-ins is the main expense involved in starting a fresh isolate, after all!
>
> Anyway, sorry, we don't feel that trying to plug in an alternative JS engine is worthwhile for us right now -- it would be a very large undertaking, and what we have currently is already 100x cheaper than containers and serving the agents use case well.

### The cross-request I/O barrier: exact production error text and rationale

Source: workerd repo, `src/workerd/io/io-context.c++` @ 479771c30 (IoContext::throwNotCurrentJsError)
Context: The error any platform user hits when I/O objects leak across requests/objects; the "limitation … allows us to improve overall performance" framing is deliberate.

> "Cannot perform I/O on behalf of a different Durable Object. I/O objects (such as streams, request/response bodies, and others) created in the context of one Durable Object cannot be accessed from a different Durable Object in the same isolate. This is a limitation of Cloudflare Workers which allows us to improve overall performance."
>
> "Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response bodies, and others) created in the context of one request handler cannot be accessed from a different request's handler. This is a limitation of Cloudflare Workers which allows us to improve overall performance."

### Attribution of work to requests inside an actor is a heuristic

Source: workerd repo, `src/workerd/io/io-context.h` @ 479771c30 (IoContext_IncomingRequest doc comment)
Context: In-tree comment on why per-request metrics fall apart inside DOs.

> The purpose of tracking IncomingRequests at all is so that we can perform metrics, logging, and tracing on a "per-request basis", e.g. we can log that a particular incoming request generated N subrequests, and traces can trace through them. But this concept falls apart a bit when actors are in play, because we can't really say which incoming request "caused" any particular subrequest, especially when multiple incoming requests overlap. As a heuristic approximation, we attribute each subrequest (and all other forms of resource usage) to the "current" incoming request, which is defined as the newest request that hasn't already completed.

### Construct-then-link: how workerd broke cyclic service-binding deadlocks

Source: workerd@85bfc1ad38b50931ff83204a5befaf72dbdb5a28 (commit message, 2022-09-22)
Context: "Fix cyclic service bindings causing `workerd` to hang at startup." A pattern worth copying in any service graph loader.

> Previously, WorkerService's constructor took a list of `Service`s implemeting subrequest channels, which implied that those services had to be constructed before the WorkerService, and so cycles were impossible.
>
> We now split into two stages, construction and linking. We construct all services first, then we link them.
>
> This also means we no longer have any service types that need to be constructed asynchronously, which improves error handling since all errors will be reported by the time we've fininished constructing+linking.

### Experimental features gated by a CLI flag, deliberately hostile to production use

Source: workerd@6dd673836c2af1308b26afccd1837090020191c0 (commit message, 2022-09-25)
Context: "Add --experimental CLI flag, require it to enable experimental features."

> Specifically, the following features are considered experimental:
>
> - Ephemeral objects (fka "colo-local actors").
> - Any compatibility flag that doesn't have a default-on date assigned. [...]
>
> I decided to use a CLI flag rather than a config flag in order to add resistance against using this in production, but we can consider finer-grained control if it proves warranted.

### Structured logs stuck in stdio buffers — write to the fd, skip 40-year-old C buffering

Source: workerd@912ebfa48d6b6359576875e9b8df74a22a81b43a (commit message, 2025-08-15)
Context: "Fix structured logs getting stuck in the buffer." Practical ops lesson for any runtime that pipes logs.

> `puts()` is an ancient C stdio function. It doesn't write directly to stdout, but rather a C stdio `FILE` structure representing stdout. This structure has a buffer.
>
> Now, if stdout is an internactive terminal, then the FILE for stdout is automatically configured to line-buffer mode [...]. So when testing structured logging on the terminal, everything would appear to work great.
>
> But if stdout is a disk file, pipe, socket, etc., then stdio will use file-buffering mode, which means it won't flush the buffer until it fills up. [...] This means that logs might be delayed -- or might not show up at all if workerd is shut down before the buffer fills.
>
> It looks like Miniflare has recently switched to use this new structured logging mode by default [...]. This managed to bite me, as I couldn't see the internal error behind a problem in an app I am working on.
>
> Anyway, there's really no need to use these ancient C functions. We can write directly to the file descriptor and avoid buffering entirely.

### Stack-trace capture flag: only meant for startup, and misunderstood even internally

Source: https://github.com/cloudflare/workerd/issues/5332#issuecomment-3417406381 and #issuecomment-3419994253
Context: 26% perf win found by disabling SetCaptureStackTraceForUncaughtExceptions; Kenton digs to the true semantics.

> OK, looking at it, I think `SetCaptureStackTraceForUncaughtExceptions()` should actually be described as: "Collect stack traces for thrown exceptions even if they are not of type `Error`, observable via the C++ `v8::TryCatch` API."
>
> The "uncaught exception" thing really means "caught by `v8::TryCatch` in C++".
>
> We set this in the `Script` constructor in order to be able to report better errors at startup. I think we could just turn it off at the end of the constructor.

> The intent of our enabling `SetCaptureStackTraceForUncaughtExceptions` has always been purely for startup-time exceptions. Turning it off at the end of startup seems correct. We don't even enable this at all in production -- only locally and during deploy-time validation.

### CPU-limit design constrains crypto: the PBKDF2 iteration cap explained

Source: https://github.com/cloudflare/workerd/issues/1346#issuecomment-1785806463
Context: Users asked for higher PBKDF2 iteration counts; the limit exists because BoringSSL can't be interrupted mid-loop.

> What we want to do here is permit a higher iteration count for people who have higher CPU limits. The original 100k limit was put in place when Workers had a 50ms total time limit -- that's about how much you could do in 50ms. Since our CPU time-limiting code cannot interrupt BoringSSL in the middle of running PBKDF, we have to limit the iterations upfront. But, these days most Workers have a 30s time limit so we should be able to increase the limit on PBKDF2 much higher for workers with such a higher limit.
>
> Or if we can find an easy way to be able to interrupt the PBKDF2 loop when the CPU time limit is hit, then we could make the iterations unlimited...

### Runaway isolates can't be stopped from inside: the supervisor must SIGKILL

Source: https://github.com/cloudflare/workers-sdk/issues/9193#issuecomment-2867558763 and #issuecomment-2930693058
Context: Orphaned workerd processes burning CPU under wrangler/vitest.

> I don't know what caused the CPU usage, but note that if the application goes into an infinite loop, workerd doesn't have any way to stop it, and won't be able to respond to SIGTERM. Probably, wrangler should be killing workerd with SIGKILL. If it does that, then nothing it workerd could cause it to keep running...

> It's weird that kill -9 wouldn't work. AFAIK that would only be the case if either:
>
> 1. workerd is blocked on a uninterruptible syscall. On Linux this can happen when reading from a disk that is not responding (which is something workerd itself can't do anything about).
> 2. The process is actually already dead and you're looking at a zombie process table entry that hasn't been cleaned up by the parent yet.

### console.\* is V8's implementation; local terminal output is the wrapper's job

Source: https://github.com/cloudflare/workers-sdk/issues/6227#issuecomment-2214519884 and #issuecomment-2214553885
Context: console.assert "does nothing" report; ends with a tooling-philosophy punchline.

> By the way, `console` is implemented by V8. So, we use the exact same code as all other V8 runtimes.

> To recap:
>
> - `console.assert()` does not throw an exception on any platform. It simply logs a message if the assertion fails.
> - The runtime is implementing this correctly, sending the message to the inspector protocol client.
> - wrangler is ignoring the message on its end, rather than printing it.

> But IMO we should just open the real devtools UI and not try to implement anything in wrangler. Then people get the whole debugging suite!

### Abort correctness: re-check abort state after re-acquiring locks

Source: workerd@e7b2192c4e9c32fdf6cd2a3fc32db96109a147d0 (commit message, 2026-08-01)
Context: "Fix issue where IoContext could be aborted while waiting for lock."

> It's difficult to actually make this happen (required a low-level C++ test), but theoretically possible that an IoContext could become aborted while we waited for the isolate lock, after we'd already checked the abort exception. Re-checking again after locking solves the problem.
>
> (Bug identified, fixed, and tested by Fable 5.)

### Making ctx.abort() non-experimental required closing every keep-running-after-abort path

Source: workerd@322d59b78960b1bb053e8f78c096cd5e64e47249 (commit message, 2026-08-01)
Context: "Make ctx.abort() (for stateless workers) non-experimental." The checklist for trusting an abort primitive.

> All of the concerns in the TODO bullet points had already been addressed:
>
> - We already use TerminateExecution().
> - Abort handling has been significantly refactored closing most ways that code could keep running after abort. One remaining issue was fixed in the previous commit.
> - The refactoring of abort handling also ensured that the correct exception propagates.
> - All event handler paths were verified as respecting abort.
> - The Durable Object version was un-gated a long time ago.
>
> (Fable 5 reviewed the code to verify all this.)

### SQLite cursor read-ahead: platform buffering is a fair trade against metrics purity

Source: workerd@6f5fd8c103eb78fb2e9470a4712cc98f43ee528b (commit message, 2024-10-22)
Context: "SQLite: Optimization: Read one row ahead."

> By always iterating the underlying query one row ahead of what has been returned, we can discover when the query is done and return it to the statement cache more proactively.
>
> Without this optimization, statements very commonly don't get returned to the cache until the cursor is GC'd -- especially statements that return no results at all.
>
> In theory this would inflate the "rows read" metric for an application that commonly creates cursors and doesn't iterate them to completion. But, that should be uncommon, and "buffering ahead" is hardly an unreasonable thing for the platform to be doing.

### Trace spans: make the observer abstract, make the no-tracing case invisible

Source: workerd@87e858bdeb7f68bed8e2bd529ef594be48457f21 (commit message, 2022-10-29)
Context: "Improve representation of trace spans." — the SpanObserver refactor rationale.

> There are a few benefits:
>
> - The new classes provide a clearer mental model for what they do, compared to the old `Tracer` class which had collected considerable baggage over its history.
> - The classes are designed so most code no longer needs to be aware of whether tracing is active -- no more `Maybe`s and `mappAddRef()` all over the place.
> - `SpanObserver` abstracts away the specific tracing back-end, so we are no longer specifically dependent on Jaeger.
