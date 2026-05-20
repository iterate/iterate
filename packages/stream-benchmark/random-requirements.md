It should be possible to run a stream processor that connects as a client to the stream durable object as a server, and I should be able to run this in Node.js.

The vast majority of our stream processors are going to run inside durable objects which track their own last processed offset. However, these durable objects need to be woken up at the appropriate time.

It seems like, from the get-go, we want to optimise for two different connection mechanisms:

1. The first one is where a programme outside of the durable objects connects to it in some sense and says, "Give me all the events starting at this offset." Examples of that would be a browser client or when I'm prototyping a stream processor. In that case, the stream durable object stores no offsets, and there is no durable identifier for this subscription.
2. The second case is where we have a durable identifier from the subscription, like a subscription key or something. The stream durable object, whenever an event is appended, wakes up the stream processor and connects to it, and then the stream processor says, "Give me all these events here since offset x." Although it might be faster if the stream just starts sending the events and occasionally the stream processor sends back a cursor update. This cursor update is persisted on the server side against the subscription key. The alarm in the stream durable object makes sure that, for any subscriber where we haven't seen the cursor advance, there is an active WebSocket connection and we're pumping events through it.

If either durable object crashes, which we can simulate by calling this.ctx.abort(), we should resume automatically.

We need the outbound websocket to be created from an alarm always, because otherwise it is going to eventually get closed. We do need to test our assumptions around how long these streams and stream processor durable objects can run without interruption.

Oh, and we want there to be a proper event emitted whenever a stream processor starts or connects. And similarly, when it disconnects . Potentially even going so far as to say that when somebody opens a stream in the browser, you can see an event saying this stream has been opened in the browser, which could be used for presence tracking or other things in the future.

Now, the risk with all that is, of course, infinite loops, but those risks always exist anyway.

We should be able to run a chaos monkey of sorts where we kill durable objects deliberately, and all correctness tests should still pass.

The rule with AFTERAPPEND is always that AFTERAPPEND runs in offset order strictly and needs to complete before the next offset event after append can start. That has some important implications. For instance, when AFTERAPPEND awaits another append, we need to make sure that the stream doesn't block on sending the appended event to all subscribers before returning from its own append function. That needs to be asynchronous.
