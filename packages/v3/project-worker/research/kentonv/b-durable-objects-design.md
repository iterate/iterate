# Kenton Varda on Durable Objects design (Collector B)

Harvested 2026-08-18 from his Cloudflare blog posts (DO announcement, "Easy, Fast, Correct — Choose three", "Zero-latency SQLite storage in every Durable Object") and HN commentary. All blockquotes verbatim. A sibling file `a-durable-objects.md` covers the other collector's territory; overlap was minimized.

---

### The name, unpacked: Objects, Unique, Durable

Source: https://blog.cloudflare.com/introducing-workers-durable-objects/ (2020-09, Kenton Varda)

> I'm going to be honest: naming this product was hard, because it's not quite like any other cloud technology that is widely-used today. [...]
>
> - Objects: Durable Objects are objects in the sense of Object-Oriented Programming. A Durable Object is an instance of a class -- literally, a class definition written in JavaScript (or your language of choice). The class has methods which define its public interface. An object is an instance of this class, combining the code with some private state.
> - Unique: Each object has a globally-unique identifier. That object exists in only one location in the whole world at a time. Any Worker running anywhere in the world that knows the object's ID can send messages to it. All those messages end up delivered to the same place.
> - Durable: Unlike a normal object in JavaScript, Durable Objects can have persistent state stored on disk. Each object's durable state is private to it, which means not only that access to storage is fast, but the object can even safely maintain a consistent copy of the state in memory and operate on it with zero latency.

---

### Serverless state = fine-grained state matching the app's logical units

Source: https://blog.cloudflare.com/introducing-workers-durable-objects/ ("What does it mean for state to be serverless?")
Context: The philosophical close of the announcement — the design thesis of DOs.

> So how can we apply the serverless philosophy to state? Just like serverless compute is about splitting compute into fine-grained pieces, serverless state is about splitting state into fine-grained pieces. Again, we seek to find a unit of state that corresponds to logical units in our application. The logical unit of state in an application is not a "table" or a "collection" or a "graph". Instead, it depends on the application. The logical unit of state in a chat app is a chat room. The logical unit of state in an online spreadsheet editor is a spreadsheet. The logical unit of state in an online storefront is a shopping cart. By making the physical unit of storage provided by the storage layer match the logical unit of state inherent in the application, we can allow the underlying storage provider (Cloudflare) to take responsibility for a wide array of logistical concerns that previously fell on the developer, including scalability and regionality.
>
> This is what Durable Objects do.

---

### Region: Earth

Source: https://blog.cloudflare.com/introducing-workers-durable-objects/

> Traditional databases and stateful infrastructure usually require you to think about geographical "regions", so that you can be sure to store data close to where it is used. Thinking about regions can often be an unnatural burden, especially for applications that are not inherently geographical.
>
> With Durable Objects, you instead design your storage model to match your application's logical data model. For example, a document editor would have an object for each document, while a chat app would have an object for each chat. There is no problem creating millions or billions of objects, as each object has minimal overhead.

---

### The killer app: a live coordination point, not a database

Source: https://blog.cloudflare.com/introducing-workers-durable-objects/

> The secret to solving this problem is to have a live coordination point. Alice and Bob connect to the same coordinator, typically using WebSockets. The coordinator then forwards Alice's keystrokes to Bob and Bob's keystrokes to Alice, without having to go through a storage layer. [...] The coordinator can then take responsibility for updating the document in storage -- but because the coordinator keeps a live copy of the document in-memory, writing back to storage can happen asynchronously.
>
> Every big-name real-time collaborative document editor works this way. But for many web developers, especially those building on serverless infrastructure, this kind of solution has long been out-of-reach.

Note: Also the CRDT stance from the same post's Q&A: "We feel that, for most applications, CRDTs are overly complex and not worth the effort. [...] It's usually much easier to assign a single authoritative coordination point for each document, which is exactly what Durable Objects accomplish." (CRDTs can still be layered on top as replication between objects.)

---

### E-order, CapTP-not-Ken, and single-threaded atomicity — the DO consistency model in one HN comment

Source: https://news.ycombinator.com/item?id=24617903 (2020-09-28, DO beta thread)
Context: The most information-dense public statement of DO's ordering/failure semantics.

> Since each object is single-threaded, any block of code that doesn't contain an `await` statement is guaranteed to execute atomically. Any put()s to durable storage will be ordered according to when put() was invoked (even though it's an async method that you have to `await`.)
>
> When sending messages to a Durable Object, two messages sent with the same stub will be delivered in order [...]
>
> If you have heard of a concept called "E-order" (from capability-based security and the E programming language designed by Mark Miller), we try to follow that wherever possible.
>
> [On reconstructing state:] No. The only state that is durable is what you explicitly store using the storage interface [...] We don't attempt to reconstruct live object state. We thought about it, but there's a lot of tricky problems with that... maybe someday.
>
> If the machine hosting an object randomly dies mid-request, the client will get an exception thrown from `stub.fetch()` and will have to retry (with a new stub; the existing stub is permanently disconnected per e-order). In capability-based terms, this is CapTP-style, not Ken-style.

Note: Same comment: "There is indeed backpressure on the HTTP request/response bodies and WebSocket streams. In fact, this is exactly why we added streaming flow control to Cap'n Proto."

---

### "Use a database" doesn't dodge the single-writer bottleneck

Source: https://news.ycombinator.com/item?id=24645308 (2020-09-30, DO beta thread)

> Incidentally databases will also hit scaling bottlenecks if you have too many requests hitting the same row. Under the hood, the database has to do exactly what Durable Objects do -- the row will be owned by one "chunk" which has to serialize all changes (making it effectively single-threaded).
>
> So "use a database" doesn't necessarily solve your scaling bottleneck. In fact, it's likely to be worse, since the database chunk is not running app-specific optimized code.

Note: On object sizing (HN 25088696): "we recommend aiming for small, fine-grained objects, kilobytes to megabytes in size. But there's nothing fundamentally preventing an object from growing to multiple gigabytes."

---

### Input gates: the rule

Source: https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/ (2021, Kenton Varda)
Context: The response to "everyone writes racy DO code": change the system, not the developer.

> When looking at this, we had two options:
>
> 1. Try to carefully document these problems and educate developers about them, so that they could write code that does the right thing.
> 2. Change the system so that naturally-written code just does the right thing by default -- and runs quickly.
>
> We chose option 2.

> Input gates: While a storage operation is executing, no events shall be delivered to the object except for storage completion events. Any other events will be deferred until such a time as the object is no longer executing JavaScript code and is no longer waiting for any storage operations. We say that these events are waiting for the "input gate" to open.

---

### Output gates: the rule, and why unconfirmed writes are safe

Source: https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/

> Output gates: When a storage write operation is in progress, any new outgoing network messages will be held back until the write has completed. We say that these messages are waiting for the "output gate" to open. If the write ultimately fails, the outgoing network messages will be discarded and replaced with errors, while the Durable Object will be shut down and restarted from scratch.
>
> With this rule, we no longer have to await the result of put(). Our code can happily continue executing and just assume the put() will succeed. If the put() doesn't succeed, then anything the application does here will never be observable to the rest of the world anyway. For example, if the app prematurely sends a response to the user saying that the operation succeeded, this response will not actually be delivered until after the put() completes successfully. So, by the time the user receives the message, it is no longer "premature"! [...]
>
> Note that output gates apply not only to responses sent back to a client, but also to new outgoing requests made with fetch() -- those requests will be delayed from being sent until all prior writes are confirmed. So, once again, it is impossible for anything else in the world to observe a premature confirmation.

Plus caching + coalescing:

> Better yet, put() requests now always complete "instantaneously". A put() simply writes to cache. We rely on output gates [...] Writes will be coalesced (even if you await them), so that the output gate waits only for O(1) network round trips of latency, not O(n).

And the escape hatches:

> ```
> this.storage.get("foo", {allowConcurrency: true, noCache: true});
> this.storage.put("foo", "bar", {allowUnconfirmed: true, noCache: true});
> ```
>
> Developers who have taken the time to think carefully about these issues can use these flags to tune performance to their specific needs. For those who don't want to think about it, the defaults should work well.

Note: Conclusion of the post: "Concurrency is hard. It doesn't matter if you're a novice or an expert: even experts regularly get it wrong. [...] With input gates, output gates, and caching, code written in the most intuitive way now 'just works', and runs fast."

---

### Contagious output gates (a design idea he keeps floating)

Source: https://news.ycombinator.com/item?id=41662311 and https://news.ycombinator.com/item?id=41674263 (2024-09, SQLite-in-DO thread)

> I've thought about this... what if output gates were a sort of contagious thing across Cloudflare's network, so they don't block communications to other workers (including DOs), but instead the output gate extends around the other worker? Haven't done this yet but in principle it makes sense.

> At present output gates operate on the scope of a single worker, blocking the output from being sent. It's easy to imagine, though, that we extend things so if you are sending a message to another worker (including a Durable Object), the message is sent immediately, but the destination worker becomes subject to the same output gate. Haven't done it yet but would definitely like to!

Note: Directly relevant to any platform propagating speculative side effects across RPC hops.

---

### Synchronous SQLite: "disk is L5 cache", and why sync APIs kill a class of bugs

Source: https://blog.cloudflare.com/sqlite-in-durable-objects/ (2024-09, Kenton Varda)

> This may come as a surprise to some. Querying a database is I/O, right? I/O should always be asynchronous, right? Isn't this a violation of the natural order of JavaScript?
>
> It's OK! The database content is probably cached in memory already, and SQLite is being called as a library in the same thread as the application, so the query often actually won't spend any time at all waiting for I/O. Even if it does have to go to disk, it's a local SSD. You might as well consider the local disk as just another layer in the memory cache hierarchy: L5 cache, if you will. [...]
>
> More importantly, though, synchronous queries help you avoid subtle bugs. Any time your application awaits a promise, it's possible that some other code executes while you wait. The state of the world may have changed by the time your await completes. Maybe even other SQL queries were executed. This can lead to subtle bugs that are hard to reproduce because they require events to happen at just the wrong time. With a synchronous API, though, none of that can happen. Your code always executes in the order you wrote it, uninterrupted.

And the N+1 selects payoff:

> Well, good news: You don't need to figure it out. Because when using SQLite as a library, the first example above works just fine. It'll perform about the same as the second fancy version.
>
> More generally, when using SQLite as a library, you don't have to learn how to do fancy things in SQL syntax. Your logic can be in regular old application code in your programming language of choice, orchestrating the most basic SQL queries that are easy to learn. It's fine. The creators of SQLite have made this point themselves.

---

### Storage Relay Service: WAL batches to object storage + five followers, quorum of three

Source: https://blog.cloudflare.com/sqlite-in-durable-objects/ ("Under the hood: Storage Relay Service")

> SRS is based on a simple idea: Local disk is fast and randomly-accessible, but expensive and prone to disk failures. Object storage (like R2) is cheap and durable, but much slower than local disk and not designed for database-like access patterns. Can we get the best of both worlds by using a local disk as a cache on top of object storage?

> Every time SQLite commits a transaction, SRS will immediately forward the change log to five "follower" machines across our network. Once at least three of these followers respond that they have received the change, SRS informs the application that the write is confirmed. (As discussed earlier, the write confirmation opens the Durable Object's "output gate", unblocking network communications to the rest of the world.)
>
> [...] However, if the follower never receives the persisted notification, then, after some timeout, the follower itself will upload the change to object storage. Thus, if the machine running the database suddenly fails, as long as at least one follower is still running, it will ensure that all confirmed writes are safely persisted.

Fencing off a zombie primary:

> We cannot start up a new instance of the DO until we know for sure that the previous instance is dead – or, at least, that it can no longer confirm writes, since the old and new instances could then confirm contradictory writes. To deal with this situation, if we can't reach the DO's host, we can instead try to contact its followers. If we can contact at least three of the five followers, and tell them to stop confirming writes for the unreachable DO instance, then we know that instance is unable to confirm any more writes going forward.

Point-in-time recovery as an accident:

> This was actually an accidental feature that fell out of SRS's design. Since SRS stores a complete log of changes made to the database, we can restore to any point in time by replaying the change log from the last snapshot. The only thing we have to do is make sure we don't delete those logs too soon.

---

### The D1 "dirty secret": D1 is just a singleton DO — bring your code to the data

Source: https://news.ycombinator.com/item?id=48611834 (2026-06-20)

> I'll let you in on a sort of dirty secret:
>
> It's almost always better to use Durable Objects storage, rather than D1. Even if you only want a single global database, it's better to implement that as a singleton Durable Object, than by using D1. Because that's all D1 itself actually is: a singleton Durable Object that exposes an API to its SQLite database. It's just a wrapper.
>
> With raw Durable Objects, you get to bring your code to run on the same machine as the database itself. Your queries run on a local file, synchronously, rather than going over a network. There is essentially zero latency when using sqlite storage in a Durable Object.
>
> [...] But if your app ever does two or more queries in series for a single request, then Durable Objects becomes vastly better, because you get to move that query-chaining code to happen directly where the database lives, rather than have multiple round trips.
>
> Really, though, the only reason D1 exists is for comfort. Once you know how to use Durable Objects, there's no reason to use D1. We offer D1 because a lot of people don't want to learn a new model. (Which is fair. People are busy and may have better things to do.)

Follow-up (HN 48612876):

> Also with Durable Objects you can have many objects, e.g. one object per user or one object per document, spread around the world. It's a distributed systems building block. Many of the things you can build on it can't really be "smart" auto-detected.

---

### Many small databases beat one monolith

Source: https://news.ycombinator.com/item?id=36003771 (2023-05-19, D1 thread)

> Personally, I'm a firm believer that most "web app" use cases are better served by many small databases (e.g. per-user or per-document) rather than a single monolithic databases. This is especially true when serving users all around the world -- per-user databases can be located near each user (both for speed and to comply with data locality laws).
>
> What I'd like to enable here is a progression where you start out prototyping your app with a single D1 database [...] Then as you grow we provide tools to let you transition to many D1 databases sharded in a way that makes sense (e.g. per-user). Apps that want even more control can move to using full-on Durable Objects.

---

### Why remote transactions were forbidden: SQLite is single-writer, and the speed of light is real

Source: https://news.ycombinator.com/item?id=36118825 (2023-05-29, Connect() thread)

> So, a challenge here is that SQLite is designed for single-writer scenarios. [...] D1 allows queries to be submitted to the database from Workers located around the world. Any sort of multi-step transaction driven from the client is necessarily going to lock the database for at least one network round trip [...] you could be looking at the database being write-locked for 10s or 100s of milliseconds. And if the client Worker disappears for some reason [...] then presumably the database has to wait some number of seconds for a timeout, remaining locked in the meantime. Yikes!
>
> [...] To actually enable transactions, we need to make sure the code is running next to the database, so that write locks aren't held for long.

---

### SQLite WAL checksums: rollback of incomplete transactions is not data loss

Source: https://news.ycombinator.com/item?id=44672473 (2025-07-24, "SQLite WAL checksums fail silently")
Context: A precise statement of what WAL checksums are for — relevant to anyone building durability on SQLite.

> How does sqlite know if the transaction was complete? It needs to see two things:
>
> 1. The transaction ends with a commit frame, indicating the application did in fact perform a `COMMIT TRANSACTION`.
> 2. All the checksums are correct, indicating the data was fully synced to disk when it was committed.
>
> If the checksums are wrong, the assumption is that the transaction wasn't fully written out. Therefore, it should be rolled back. That's exactly what sqlite does.
>
> This is not "data loss", because the transaction was not ever fully committed. [...] The checksum is NOT intended to detect when the data was corrupted by some other means, like damage to the disk or a buggy app overwriting bytes. Myriad other mechanisms should be protecting against those already.

---

### workerd DOs at self-hosted scale: the NFSv4 plan

Source: https://news.ycombinator.com/item?id=49184397 and https://news.ycombinator.com/item?id=49191560 (2026-08, Cloudflare OS thread)
Context: What of DO-land is open source and what the open-source scaling story is (workerd PR #6780).

> Durable Objects are fully supported by workerd (and Cloudflare OS uses them extensively). There is, however, one catch currently: Durable Objects don't scale out well without the global scheduling. For running Cloudflare OS for one user, this is actually no big deal, but a company-wide instance might not work well. But I'm actually fixing that: https://github.com/cloudflare/workerd/pull/6780

> Stateless workloads should scale trivially (just add more instances and load balance). For Durable Objects (statefull), currently it doesn't scale well at all, but I'm working on changes so that it scales nicely across a cluster. I intentionally chose a design here that is operationally easy to set up. (Basically: just connect all the nodes to NFSv4.)

Note: On the production scheduler (HN 46012008): "workerd's implementation of Durable Objects doesn't scale at all, so can't plausibly be used in production. We actually have some plans to fix this." — and none of the cloud schedulers (Deno Deploy, Supabase, Lambda, Cloudflare) are open source; "Standard practice here is to offer an open source local runtime that can be used with other schedulers, but not to open source the cloud scheduler itself."

---

### Storage locality kills a whole class of ops work

Source: https://news.ycombinator.com/item?id=41948479 (2024-10-25, "Infinite Git repos on Cloudflare workers")

> Huh? With Durable Objects the storage is local to each object. There is no API key involved in accessing it.
>
> [...] Durable Object storage (under the new beta storage engine) automatically gives you point-in-time recovery to any point in time in the last 30 days.
>
> [...] Why would it be worse? It should be better, because Cloudflare can locate each DO (git repo) close to whoever is accessing it, whereas your VPS is going to sit in one single central location that's probably further away. [...] While each individual repo may be more constrained, this solution can scale to far more total repos than a single-server VPS could.
