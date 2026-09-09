# Kenton Varda — Durable Objects: lifecycle, storage, gates, alarms (Collector A)

Verbatim harvest from cloudflare/workerd issues/PRs/commits/in-tree docs. workerd main @ `479771c30d10a04f468c68f80714cbf4c34b9d85` (2026-08-17).

### How output gates work — why writes complete "instantly" but the world can't observe them

Source: https://github.com/cloudflare/workerd/pull/6533#issuecomment-4216508609
Context: A Cloudflare engineer asked why TCP `connect()` from a DO needs to wait for the output gate; Kenton explains the whole output-gate model.

> That's how output gates work. We don't want applications to have to wait for writes to be confirmed durable before we allow them to continue executing. Instead, we make it impossible to _observe_ that the app has continued executing until the write has become durable. If the write ends up failing, then we prevent the rest of the world from ever knowing that the app kept running -- so from the PoV of the rest of the world, the app stopped exactly where the failed write was performed. This is a huge optimization because it allows an app to perform several writes in rapid succession with only one round trip to durable storage (SRS followers).
>
> https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/

### The output gate must block _anything observable_ — even opening a TCP connection

Source: https://github.com/cloudflare/workerd/pull/6533#issuecomment-4216508609
Context: Same thread; answering "shouldn't only writes be blocked instead?"

> Anything that can be _observed_ by the outside world needs to be blocked. That means we have to block both writes and connection initiation -- the remote end can observe that it has received a connection, and in theory you could imagine a protocol where merely connecting to a remote service serves to notify it of something, thus having side effects.

### The input/output gate model, canonical in-tree statement

Source: workerd repo, `src/workerd/io/io-gate.h` @ 479771c30 (top-of-file comment)
Context: The header that implements both gates; this comment is the terse canonical definition of DO consistency machinery.

> An I/O gate allows someone to "lock" a type of I/O so that other concurrent tasks trying to perform that type of I/O are blocked until the lock is released.
>
> I/O gates are used in actors to implement consistency guarantees, allowing in-memory state and storage to be synchronized.
>
> Each Actor has two main gates:
>
> - Input gate: While locked, blocks all incoming I/O events of any type from being delivered to the actor, other than the specific event or events that hold the lock. This includes blocking responses to subrequests, timer events, input streams, etc. Used when storage operations are outstanding, so that awaiting a storage operation does not risk allowing concurrent events that render the state inconsistent.
> - Output gate: While locked, blocks all outgoing messages from an actor that would allow the rest of the world to observe the actor's state. Held while writes that have been confirmed to the application are still being flushed to disk. If the flush fails, these messages will never be sent, so that the rest of the world cannot observe a prematurely-confirmed write.

### ActorCache semantics: writes complete instantly, ordering by brute force

Source: workerd repo, `src/workerd/io/actor-cache.h` @ 479771c30 (class ActorCache doc comment)
Context: The caching layer between the DO storage API and disk; states the exact consistency contract.

> An in-memory caching layer on top of ActorStorage.Stage RPC interface.
>
> This cache assumes that it is the only client of the underlying storage -- which is, of course, true for actors.
>
> Writes complete "instantly" -- but the OutputGate is told to block output until the write is confirmed durable.
>
> Ordering is carefully preserved. A read will always return results consistent with the time when it was called, never reflecting later writes -- even writes that are performed before the read actually completes. Writes are never committed out-of-order (this is accomplished by brute force -- the cache always performs a transaction committing all dirty keys at once).

### DO lifecycle rule: if you never touch storage, storage must never exist

Source: https://github.com/cloudflare/workerd/pull/6101#issuecomment-3921322807
Context: Rejecting a community PR that persisted `ctx.id.name` into the `_cf_METADATA` table on startup.

> It looks like your approach here is to store the name inside the `_cf_METADATA` table.
>
> Sorry, but this doesn't work. Specifically, it doesn't play well with Durable Object lifecycle rules. It's supposed to be the case that if a DO does not invoke any storage APIs, then the backing storage is never created at all, and the application is never billed for any storage. This is important for use cases that use DOs for coordination only.
>
> If we store some metadata immediately on DO startup, then this breaks: All DOs now have storage even if they didn't ask for it. We'd need a mechanism to delete the metadata if nothing else is ever stored. But that mechanism would of course break the feature.

### workerd must be an accurate simulation of production — don't ship local-only features

Source: https://github.com/cloudflare/workerd/pull/6101#issuecomment-3921322807
Context: Same rejection, second reason. A standing principle for any local-dev runtime.

> A second problem with this PR is it is heavily editing code that is specific to workerd and not to our production environment. In order for this to work in production, we need to make a lot of changes to internal code. Those changes are in fact being worked on right now! But as long as we don't support this in production, then we shouldn't support it in workerd either, since workerd is intended to be an accurate simulation of production.
>
> I appreciate the attempt to help, but this is something we're going to have to implement ourselves, sorry. Again, it is actively being worked on.
>
> In the future, I'd recommend opening a discussion (or comment on the existing issue) to discuss any proposed designs before putting in the work to implement them. I guess with AI it's probably less of a big deal these days, but I still feel bad turning down a big PR like this...

### Why `ctx.id.name` is hard: IDs round-trip through strings and lose the name

Source: https://github.com/cloudflare/workerd/issues/2240#issuecomment-2156627116
Context: threepointone asked why `ctx.id.name` doesn't work inside a DO. This is the core design tension.

> This bothers me too, but I can't figure out how to make it work. The thing is, you are allowed to do:
>
> ```
> let id = ns.idFromName("foo");
> let id2 = ns.idFromString(id.toString());
> ns.get(id2);
> ```
>
> In this case, we've lost the name, because `id.toString()` only encodes the hex ID, not the name. How do we support this?
>
> Moreover, for alarms, where does the name get stored? Does everything in the system which stores a DO ID need to store the name too, or do we implicitly store the name in the DO's own metadata?
>
> Storing it in the metadata seems highly preferable (I guess it would get initialized the first time a name-bearing ID is used?), but then this gets weird when you consider that DOs are implicitly deleted if they shut down while their storage is empty. So the name has to be forgotten at that point. But only if the storage is empty? Is that weird?

### More `id.name` subtleties: empty objects, giant names

Source: https://github.com/cloudflare/workerd/issues/2240#issuecomment-2156642151
Context: Follow-up in the same thread.

> The next alarm time counts as a stored value, so when an alarm is present then storage is not empty.
>
> There are other built-in features planned which are likely to store hex IDs and where we wouldn't really want those systems to have to think about storing names alongside them.
>
> But perhaps we can be reasonably confident that future features similar to alarms that store a hex ID only are never going to be waking up an empty object? And therefore the only way an object might not know its name is if application code wakes up an empty object by ID? Maybe that's OK?
>
> Another weird issue: Technically someone could be passing in a multi-megabyte string as a name, which works fine if it's just getting hashed down but not so fine if we have to transmit that name over the network implicitly. Maybe there's some threshold at which we refuse to automatically store the name for them?

### idFromName is a hash, not a lookup — and it's one-way

Source: https://github.com/cloudflare/workerd/issues/2240#issuecomment-2417528072
Context: Correcting a commenter's mental model of name-to-ID resolution.

> > this does a lookup to get the hex id from "foo" since any worker calling it needs to get the same hex id.
>
> It actually doesn't do a lookup. It uses a cryptographic hash function to generate the ID based on the name.
>
> > Can a DO do a reverse lookup
>
> No, because hash functions are one-way.

### The two DO timeouts: 10s hibernation (internal inactivity) vs 60/70s eviction (no clients)

Source: https://github.com/cloudflare/workerd/pull/1138#discussion_r1319954592
Context: Review of the PR that brought production eviction behavior to workerd.

> There are two relevant timeouts:
>
> - Hibernation occurs after 10 seconds of _internal_ inactivity, that is, 10 seconds of not having any non-hibernatable work scheduled inside the isolate. Clients may still be connected.
> - Eviction occurs after 60 seconds (or is it 70 seconds? I can never remember) of not having any clients connected.
>
> We should make sure to cover both of these in this PR. For example, if someone uses `setInterval()` to schedule a periodic callback, this should prevent hibernation, and the actor should only be evicted after the 60-second interval.

### A hibernated WebSocket still counts as a client; eviction keyed off WorkerInterface refs

Source: https://github.com/cloudflare/workerd/pull/1138#discussion_r1324926605
Context: Same review; pins down what "client" means for the eviction timer.

> I think there's some confusion here. The 70-second timeout only applies after there are _no clients at all_. If there is an open WebSocket, even if it's using hibernation, that counts as a client, and so the 70-second timeout doesn't apply. So I think the HibernationManager can in fact be destroyed when the 70-second timeout kicks in, because there are necessarily no hibernated WebSockets at that point.
>
> More concretely: `ActorNamespace::getActor()` returns an `Own<WorkerInterface>`, which the caller will hold until it no longer needs it. I think the timeout you want here is: 70 seconds after all of these `WorkerInterface` instances have been dropped (and no new ones created), you want to destroy the actor.
>
> The 10-second hibernation timeout is a bit different. This applies when no work is scheduled and all client connections are hibernatable.

### Local dev must simulate production timing, not "be nice"

Source: https://github.com/cloudflare/workerd/pull/1138#discussion_r1321953741
Context: Same review; on whether workerd should keep actors alive for setInterval.

> Hmm, I would argue the real goal is to simulate the behavior that would be seen in production, otherwise people can't properly test their code.

### Aborting an actor without really killing it causes split brain

Source: workerd@6141d69274526111226e4d038be09cd63612b072 (commit message, 2025-04-28)
Context: "Bugfix: abortAllDurableObjects() should actually abort them."

> This API wasn't acutally aborting the actors, it was just leaving them unreachable. With the recent changes, the existing stubs would continue pointing at the old instances of the objects, which still worked. But even before those changes, there would have been a problem if the actors were doing work in the background -- that work would keep running even after they were supposedly aborted, even as new instances could start up in parallel, leading to split brain.

### "Aborting is not deleting" — semantics of abort vs data

Source: https://github.com/cloudflare/workerd/pull/6104#issuecomment-4063870286
Context: A merged PR made `abortAllDurableObjects()` delete alarms for vitest's benefit; Kenton pushes back on the semantics.

> But _in the abstract_, it doesn't seem like "abort all durable objects" should imply "delete all alarms"! Aborting is not deleting!
>
> Perhaps in practice this `abortAllDurableObjects()` is only used from vitest? And in that context, deleting the alarms makes sense? I don't know.
>
> Do we really just want to delete the alarms, or would it make more sense to _delete all the data_? I feel like "delete alarms but not content" just means your DOs are left in an inconsistent state.

### SQLite storage auto-wraps in transactions; the no-await coalescing rule

Source: workerd@99cf190cb964205daa401818dece93e9a5dd22b3 (commit message, 2023-05-04)
Context: "Automatically wrap SQLite usage in transactions and respect OutputGate."

> Per the old blog post:
>
> https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
>
> All writes that occur without an `await` in between are supposed to be automatically coalesced and submitted atomically.
>
> With this change, the SQLite-based DO storage respects this requirement, by automatically creating a transaction.
>
> As it turns out, this actually makes SQLite more efficient. Multiple changes to the same pages will be coalesced, and fsync()s will only be needed at commit time.

### Under SQLite, `txn` is deprecated: all storage access during a transaction is in the transaction

Source: https://github.com/cloudflare/workerd/pull/2648#discussion_r1767654161
Context: Review of alarms-in-sqlite; explains why the explicit transaction callback covers everything.

> Yeah, under sqlite, when a transaction is open, there's no way for us to support doing queries that skip the transaction. And we also wanted transactions to include SQL queries with the new SQL interface. So we just said: ok, transactions now cover everything done within the transaction callback whether you issue the queries against the `txn` object or the underlying `storage` object. `txn` is essentially deprecated and people should stop declaring it as an argument.

### Implicit transactions may legally stretch across awaits — atomicity is a floor, not a ceiling

Source: https://github.com/cloudflare/workerd/pull/2648#discussion_r1757526722
Context: Review discussion of holding the implicit transaction open while alarm scheduling happens.

> It should be OK to hold it open. It's already being held open until the `kj::evalLater` above resolves -- arbitrary async stuff could have happened in the meantime. It's possible that more JavaScript code will run, even, in which case changes made in that code will be merged into the same implicit transaction. Again, that'll all fine: the point of the implicit transaction is only to make sure that two queries executed in sequence without an await are applied atomically, but there's no reason that it _can't_ extend that atomicity further, such that it actually crosses an await.

### Alarm scheduling invariant: it's always safe for the scheduled alarm to be too early, never too late

Source: https://github.com/cloudflare/workerd/pull/2648#discussion_r1767651750 and #discussion_r1768815634
Context: Review of alarm/commit ordering. Two quotes; the second is the naming that encodes the invariant.

> I think that when making the post-commit request to move the alarm time _later_, you can _immediately_ update `lastConfirmedScheduledAlarm` to the new value when you kick off the request, without actually waiting for confirmation. This works because it's always OK if the alarm time accidentally gets left being too early -- you'll just reschedule it when it fires prematurely.

> Perhaps `lastConfirmedScheduledAlarm` should actually be called something like... `alarmScheduledNoLaterThan`? Makes clearer why it's safe to update before the call when scheduling later, but only after the call when scheduling earlier.

### The premature-alarm recovery scenario, spelled out

Source: https://github.com/cloudflare/workerd/pull/2648#discussion_r1763724533
Context: Same review; what must happen when an alarm fires before its stored time after a partial failure.

> To be clear, the scenario would be:
>
> - Application updates alarm from X to Y, where Y is later than X.
> - The database commit goes through and is persisted.
> - The alarm update (which happens after the commit, since it's moving later) fails.
> - The machine dies.
> - Later, the alarm fires at time X. At this point, no writes/commits/etc. are in progress or anything.
> - We need to respond by updating the alarm time to Y (and skip running the alarm for now).

### deleteAll(), alarms, and the empty-object cleanup problem

Source: https://github.com/cloudflare/workerd/pull/2648#discussion_r1757362817
Context: Review comment on how alarms interact with the delete-and-recreate implementation of deleteAll().

> Which raises the question: What should happen to the alarm on deleteAll()? With the old storage backend, the alarm is not actually deleted. To emulate that behavior, I suppose we have to recreate the alarm immediately, if it exists. We probably do need to emulate the behavior as we want to be able to migrate people transparently someday.
>
> Relatedly, though, if an alarm is set on an object that has no other data in storage (whether because deleteAll() was called, or maybe nothing else was ever stored in the first place), and that alarm eventually runs and doesn't store anything nor set a new alarm... we need to make sure the object can be cleaned up. That won't happen unless we actually do another `deleteAll()` (or `db.reset()`) at that point.

### Don't leave latent ordering bugs because today's code paths can't reach them

Source: workerd@3ed17551ac31707f90c44c7da0c154d2aec17130 (commit message, 2026-05-14)
Context: "Delay start of explicit transaction until implicit is done." — fixing an unreachable-today bug because an upcoming feature (persistent stubs) would expose it.

> Before this change, ExplicitTxn's constructor would, if it observed an ImplicitTxn existed, try to commit that ImplicitTxn synchronously.
>
> This is problematic because it doesn't account for all the alarm-handling code that happens later on during the async commit, which must be carefully ordered against the transaction commit. [...]
>
> However, this problem actually can't happen in practice today because starting an explicit transaction always involves first starting a `blockConcurrencyWhile()`, which always requires waiting for a turn of the KJ event loop, which always gives the `ImplicitTxn` a chance to commit. So in practice, it's impossible to hit this code path.
>
> But, this will change soon: The persistent stubs feature I'm working on will require delaying commit of implicit transactions while some asynchronous I/O takes place. This will not only allow this code path to be exercised, but the premature synchronous commit would actively break the persistent stubs feature.

### API shape: `storage.sql` always present, throwing methods beat optional properties

Source: workerd@4ae0e11015476568943b7d8d6f9e28b9d22900c6 (commit message, 2024-09-06)
Context: "Don't make storage.sql optional; have methods throw instead."

> Having `storage.sql` be optional is potentially annoying for two reasons:
>
> - TypeScript will force people to check if it's present, even though apps that have configured it should be able to expect it's always present.
> - We'd like to provide a more detailed error message telling people how to configure SQL.
>
> So, this commit changes things so `storage.sql` is always present, but its methods will throw exceptions if the DO isn't SQLite-backed.

### The synchronous KV API: why `storage.kv`, and what got dropped

Source: workerd@123c205a888d09675cd9b522a44ee3b8adad2ed3 (commit message, 2025-08-25)
Context: "Implement synchronous version of DO KV storage API." Sync-over-SQLite as the successor to the async storage API.

> This adds `ctx.storage.kv`, which has methods `get()`, `put()`, `list()`, and `delete()`. All four methods have the same signatures as the same-named methods of `ctx.storage` except:
>
> 1. They return synchronously. No promises.
> 2. They require SQLite-backed DOs.
> 3. They don't have the `allowConcurrency` nor `noCache` options since those don't make sense for SQLite. [...]
> 4. Obscure: If you `get()` multiple keys at once, the returned map now iterates in the order in which the keys were specified, rather than in alphabetical order. The old interface's alphabetical ordering was a historical quirk that required an extra sort operation. It had been maintained for backwards-compatibility, but probably nobody really cares about it, so the new interface takes the opportunity to skip the sort.
>
> The name `storage.kv` nicely parallels `storage.sql` while avoiding any backwards-compatibility concerns. In the long term we should "deprecate" (but forever support) the old async methods.

### Why SQLite storage returns results synchronously (never dropping the isolate lock)

Source: https://github.com/cloudflare/workerd/pull/302#discussion_r1085519409
Context: Review Q&A on the original SQLite-backed DO storage PR.

> Yes. This is done as an optimization so that when `ActorCache` is able to return a result from cache, the caller isn't forced to drop back to the KJ event loop (which otherwise necessitates dropping the isolate lock).
>
> In the case of SQLite, we always produce results synchronously, never returning a Promise.

### Self-hosted DO clustering: one global instance per object, NFS-lease fencing instead of etcd

Source: https://github.com/cloudflare/workerd/pull/6780 (PR body, authored by kentonv, 2026-05-23)
Context: The design statement for making self-hosted workerd DOs scale beyond one process.

> workerd has always been intended to be something you can run in production, in order to self-host Workers outside of Cloudflare. [...] But in production, you probably want to utilize more than one thread on one machine. For stateless Workers, this could be done just fine: just run multiple instances of workerd and load-balance across them. But doing this completely broke the model of Durable Objects, where each object is supposed to have a single instance globally, not one per workerd instance!
>
> This change fixes the problem, by introducing a new "cluster" mode. [...] Mostly these workerd instances behave like they would normally, except when a request is made to a Durable Object, they coordinate to make sure only one workerd instance owns the DO, and others route to it.
>
> The design assumes a shared filesystem for underlying DO storage. All instances must be on the same filesystem. If all instances are on the same machine (useful for utilizing multiple cores), then this can be any local filesystem. Otherwise, it must be NFSv4, or some network filesystem that has exactly the same lock/lease semantics as NFSv4.
>
> The shared filesystem is also used for service discovery and locking. This is unconventional, but has a major advantage vs something like etcd or Consul: If a node loses its NFS lease, it simultaneously loses its locks _and_ loses the ability to write to any open files. This provides "fencing": there's no way a node could continue writing after other nodes believe that it is dead. If locking were provided by a separate service, then it becomes extremely difficult to ensure that a node can't accidentally write after losing its lock due to a timeout.

Note: Full design doc linked from the PR: https://gist.github.com/kentonv/baeebc2de19c6ae81d71e09e822b6c45

### Don't rely on call ordering for initialization — hibernation can strike between any two calls

Source: https://github.com/cloudflare/workerd/pull/6562#issuecomment-4253394724
Context: Reviewing a community fix for RPC-vs-fetch ordering on DO stubs; the second half is the design guidance.

> I'm not sure you can actually safely rely on this in practice, due to hibernation. If you are relying on an initial call to initialize some in-memory state, and need that in-memory state to be initialized for the second call... there's no guarantee that the DO doesn't hibernate in between. True, if you make these calls in rapid succession, it's extremely unlikely that hibernation would happen, but it's always theoretically possible if a packet gets lost somewhere resulting in a delay, or if the runtime suddenly decides it needs to shut the DO down for an update or whatnot.
>
> The _safe_ thing to do is to have the first call return an RpcTarget, and the second call is pipelined on that. That always guarantees the two calls land on the same instance (or, rarely, the second call fails).
>
> Could that approach work for your use case? I personally have been using this pattern a fair amount and feel like it turns out nicely.

### The same review: pre-acquiring the input gate hands clients a lock they shouldn't have

Source: https://github.com/cloudflare/workerd/pull/6562#issuecomment-4253394724
Context: First half of the same comment — why an ordering fix that reserves the InputGate early makes him uneasy.

> One possible issue is, technically, this would allow a client (of the capnp RPC interface) to lock up a DO by sending the initial call to open an RPC session, and then failing to send the actual call. It basically gives clients the ability to take a lock on a DO, which obviously they shouldn't have.
>
> This is an internal RPC interface, though, not exposed to malicious clients. So we don't really have to worry about this being used in some sort of a DoS attack. But I suppose it's technically possible that due to a bug or a poorly-timed network hiccup, the "call" message may be significantly delayed after the "open RPC session" message.
>
> Ugh I can't quite convince myself that this is fine, nor can I think of an easy way to make it safe.
>
> A much deeper, more thorough solution would be to do what I've always wanted to do and make the KJ event loop ordering fully depth-first. I think that would just solve this problem inherently.

### `primary` stub belongs on ctx, not ctx.storage

Source: https://github.com/cloudflare/workerd/pull/6605#issuecomment-4300950055
Context: Drive-by API-placement review on replication primaryStub.

> (drive-by comment, feel free to ignore)
>
> Arguably this also belongs on `ctx` (`DurableObjectState`), not on `ctx.storage`? The stub isn't really storage...

### Request context teardown on client disconnect — why the abort event needs waitUntil

Source: https://github.com/cloudflare/workerd/pull/5062#discussion_r2349797204
Context: Explaining why request cancellation isn't observed in a sample worker.

> Try also adding:
>
> ```
>     ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, 4000)));
> ```
>
> Without the waitUntil(), as soon as the client disconnects, the entire request context is torn down immediately, and hence the abort event doesn't get a chance to be delivered.

### Instance properties on DurableObjectState: lazy and writable beats readonly getters

Source: workerd@a238eea6d3cae1552e3e084f9907144a4354731f (commit message, 2025-01-22)
Context: "Change readonly instance props of DurableObjectState to lazy-writable."

> 1. Make these lazy properties. This is a strict win since the properties cannot change value during the lifetime of the object, so there's no reason to call into C++ on every access. This might even be a non-negligible performance gain for people who use `ctx.storage` a lot without memoizing it.
> 2. Make them writable. There's no real reason to prevent people from overwriting these if they really want to. Moreover, introducing `container` as a read-only property could arguably break someone who is, for whatever reason, monkey-patching this property in today.
