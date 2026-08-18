# Kenton Varda — Durable Object Facets (Collector A)

Verbatim harvest from cloudflare/workerd. workerd main @ `479771c30d10a04f468c68f80714cbf4c34b9d85` (2026-08-17). Facets are Kenton's feature: he authored the experimental PR (#4123), the JS API commit, and the design doc embedded in both.

### The facets feature specification, in full

Source: https://github.com/cloudflare/workerd/pull/4123 (PR body, authored by kentonv, 2025-05-09; same design doc in commit workerd@b516bb1ed41048775425b540bb778168a1ccf937)
Context: The complete original spec. Key excerpts:

> Multifaceted Durable Objects are Durable Objects (DOs) which are composed of multiple "facets" implemented by different isolates. Each facet is written like a regular DO class, but all the facets run together on the same machine to implement the DO. Each facet has its own storage in the form of a SQLite database, but these databases are all stored together as one logical object.
>
> A multifaceted DO has a "main" facet which implements its public interface. This works exactly like a regular Durable Object. The main facet's implementation can call out to other "facets" as needed, using `ctx.facets` [...]
>
> // Each facet has a name, which identifies its respective slice of storage. Names are hierarchical: if the main facet creates a facet called "foo", and that facet in turn creates a facet called "bar", the latter facet's true name is "foo/bar". A facet cannot directly access its siblings, unless the common parent facet chooses to pass references explicitly.
>
> // Like with regular Durable Objects, there is no explicit "create" operation for a facet. It is implicitly created when first used, and is implicitly deleted if it shuts down with nothing left in storage.
>
> // `facet` acts like a DO stub, except all calls are local.
>
> // `facets.abort()` forcefully aborts the facet immediately. No further code will execute in the facet until it is started again. The next call to `facets.get()` is guaranteed to call the callback and start a new instance. `reason` is thrown by any outstanding or future RPC calls on existing stubs pointing into the facet. This also transitively aborts all children of the facet.
>
> // Deleting a facet aborts the facet if it is running and then deletes its underlying storage. This applies transitively to all children as well.
>
> // Note that `storage.deleteAll()` deletes all facets in addition to regular storage.
>
> Notes:
>
> - When any running facet becomes "broken", the entire actor breaks and will restart. There is currently no mechanism to catch errors in the parent, though one might be added in the future. As a special exception, if a facet becomes broken because a parent used `facets.abort()` or `facets.delete()` on it, this does not break the entire actor, only the specific facet.

### Facet storage layout (workerd and production/SRS)

Source: https://github.com/cloudflare/workerd/pull/4123 (PR body, "Storage Details")
Context: How facet databases are laid out on disk and in SRS.

> In workerd, a DO's main database has always been stored in a file called `<actor-id>.sqlite`. Each non-root facet is stored in a separate file `<actor-id>.<facet-id>.sqlite`, where `<facet-id>` is a small integer assigned to each facet. An index of facet IDs is maintained in a separate file, `<actor-id>.facets`. [...]
>
> In production (not yet implemented), facets will only be supported when using SRS to store actor data (not the old storage backend). Each facet is stored as a separate SRS "lane". Lane names are prefixed by their facet path, which is the list of facet names leading from the root to the specific facet, separated by `/` characters.

### Why facets instead of groups of Durable Objects

Source: https://github.com/cloudflare/workerd/pull/4123#issuecomment-3016876603
Context: Answering an external developer's "why not just several DOs?"

> > As an external developer building on top of cloudflare, what's the benefit of using facets instead of just groups of Durable Objects? Is it so they are forced to run on the same machiene which gurantees low-latency RPCs between them?
>
> That's one reason.
>
> The other reason is resource / namespace management. If you have a "group" of several objects working together, where each one runs different code, you now have to have several different namespaces in which those objects live, and each object has to have an ID, etc. You also need a convention for how these objects get cleaned up when they are no longer needed.
>
> With facets, there's only one namespace needed -- the one for the root facet. Deleting the root facet deletes all the children.
>
> This advantage is particularly acute when combined with #4383, dynamic worker loading: You are dynamically loading code for a one-off worker that defines a Durable Object class. Without facets, the only way to actually run that Durable Object would be to provision a whole namespace for it. Dynamically loading workers makes sense, but dynamically creating DO namespaces seems wrong.

### Facets run in their own execution context — no shared isolate, no shared globals

Source: https://github.com/cloudflare/workerd/issues/6702#issuecomment-4371272016
Context: Facet touching a parent-owned WebSocket handle tripped the cross-DO I/O check in prod.

> A facet runs in its own execution context, independent of the parent. It definitely cannot directly access I/O objects that belong to the parent. This won't work in either dev or prod.
>
> Note that you cannot assume that a facet runs in the same isolate as its parent, even if the code is in the same Worker. You should not try to share objects via global variables -- for all the same reasons you shouldn't try to share mutable globals between separate DO instances or requests.

### Why `facets.get()` takes a callback for start info (matching worker-loader)

Source: workerd@026eede24237da9ad2d823d82856a03f98b28dfe (commit message, 2025-06-30)
Context: "Change ctx.facets.get() to take a callback for start info." API-evolution reasoning.

> Previously, the caller of `facets.get()` would always provide the actor class and (optionally) `id`. If the facet was already running, these values would be compared against the running copy, and the facet would be reset if they didn't match.
>
> This proves to be a bit problematic:
>
> - Comparing ActorClass objects for equality proves to be more difficult than expected. With dynamic worker loading, the actor class may have dynamically-specified `props`, and comparing `props` for equality is not really possible since it's an arbitrary value. We could say that if you call `dynamicWorker.getActorClass()` multiple times, even with the same inputs, the returned classes are considered "different", but this would probably lead to facets restarting unexpectedly.
> - The API is aesthetically inconsistent with dynamic worker loading. With worker loaders, you call `loader.get(name, callback)`, where the callback returns the worker code. The callback is not called if the worker is already running. For consistency, facets should work the same way.
>
> So, this changes the facets API to now expect a callback as the second parameter to `get()`. The callback is not called if the facet is already running. If you want to change the class or ID, you'll have to abort() the existing facet first.

### A facet class has no namespace of its own

Source: https://github.com/cloudflare/workerd/pull/4123#discussion_r2146017205
Context: Review Q&A during the facets PR.

> Facets are other DO classes, but they are not other DO namespaces. A facet class has no namespace of its own -- it executes attached to some parent DO. The only namespace is the namespace that the root facet is in. So this seems correct to me.

### Why the facet manager must be IoContext-guarded (thread safety / use-after-free)

Source: https://github.com/cloudflare/workerd/pull/4123#discussion_r2146031197
Context: Reviewer asked why the facet manager needs an IoOwn-style wrapper.

> No, someone could put a reference to the facet manager into the global scope and then attempt to access it from a different Durable Object or from a stateless handler. This could be running on a different thread, so would cause thread-safety issues, or it might be after the original DO had shut down, in which case it would be a use-after-free.

### Facet stubs over RPC: deliberately punted, RpcTarget stubs work meanwhile

Source: https://github.com/cloudflare/workerd/pull/4123#discussion_r2153011026
Context: What happens if you try to pass a facet stub across a boundary.

> Yes that's what will happen. But also at present you can't actually pass a facet stub over RPC. You could pass an RpcTarget stub implemented by the facet, but that'll require a bunch more code to test, so I'd rather punt it for now. (Eventually I do want to make it possible to pass DO stubs and facet stubs over RPC but that's an entirely separate change...)

### Each ActorNamespace gets its own kj::Directory — ownership should match the storage boundary

Source: workerd@b5ff39b95fb717e33363f563dcc3707a89fc1d1e (commit message, 2025-05-01)
Context: "Facets: Refactor: Each ActorNamespace creates a kj::Directory." Small refactor with a stated principle.

> That had two problems:
>
> - It's ugly that an ActorNamespace could open files outside its own storage, and just has to promise to always use the correct path to its storage.
> - We actually didn't give the ActorNamespace a kj::Directory at all [...]. But we now want to open other kinds of files in this directory, so we need a kj::Directory. Let's just actually open the directory specific to the namespace, and create a separate Vfs per-namespace.

### Known facet gaps acknowledged in issues (no Kenton reply yet, kept for the record)

Source: https://github.com/cloudflare/workerd/issues/6810 and https://github.com/cloudflare/workerd/issues/6800
Context: Two open facet issues Collector A checked for Kenton commentary; he has not commented as of harvest date. Noted because both cite workerd source honestly:

- #6810: facet `ctx.storage.setAlarm()` in local dev silently breaks the actor later — `src/workerd/server/server.c++` gives facet actors default hooks with a TODO "Support alarms in facets, somehow", and `actor-sqlite.c++` default `Hooks::scheduleRun()` throws "alarms are not yet implemented for SQLite-backed Durable Objects" during the output-gate commit path (async, after `setAlarm()` already resolved).
- #6800: facets with SQLite keep the parent DO in "idle, non-hibernatable" state until forced eviction (70-140s), billing duration; `ctx.facets.abort()` after use restores ~3s lifetimes at the cost of full facet reconstruction.

Note: relevant to us because our platform's facet-hosted processors inherit both behaviors.
