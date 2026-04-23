This document outlines the steps for creating a new stream processor or adding functionality to it.

Go through these steps

1. What side effects do we want to enact?

Side effects are things like appending more events or calling out to other systems. This can only be done from the `afterAppend` function in a processor - not from the synchronous reducer.

All processors have side-effects (or else they don't do anything!)

For example:

- When an event of type `slack-webhook-received` is appended, we conditionally sometimes turn it into an event of type `agent-input-added`

2. What state, if any, do we need to track for this?

- You may need to update the state shape, initial state and reducer of your processor
- This is only necessary IFF, in order to enact your side effect, you need more than just the information contained in your existing state or an individual appened event.

3. What events, if any, do I need to invent?

You'll often want to add new events in order to drive your reducer or side effects. Declare them as zod schemas at the top of your processor.

# Here's the code you write

```typescript
// 1. New event types

// 2. State shape and initial state

// 3. reduce function

// 4. afterAppend
```

### Dependencies between processors

- Coupling between processors is loose via shared event schemas - you may append or consume events from other processors
- You can import other processors' zod schemas or even reducer into your processor
- This means you depend on them - there currently isn't any more complex modeling of this

# Style

- use schematch to switch over event shapes
