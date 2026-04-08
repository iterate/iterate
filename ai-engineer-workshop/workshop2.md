0. I want to build a state of the art coding agent based entirely on these abstractions

- Durable stream with append and stream methods
- Stream processor that implements the .reduce({ event, state }) and .afterAppend({ append, event, state }) methods

- We've got a live version of this service at events.iterate.com that you can play with

1. Start with empty typescript file
   - import SDK
   - append an event
   - you can append literally anything you want let's invent an "agent-input-added" event
   - observe:
     - it gained an offset
     - i can open this path in the browser and see the event!
       - use raw renderer
       - hide sidebar
     - i can even append it there - it does the same thing!

2. You can also stream the events at this path!
   - write for loop that prints all the events
   - observe:
     - when i add an event in the browser, i can see it here in my terminal!

3. Now let's make an LLM request
   - add if statement to stream
   - then make openai request
   - append everything
   - now we get a lot of events - so let's just append the response.completed event for now
   - look we have lots of cool events
     - if we want to make a UI or something,

4. Now we have a problem!
   - The agent can't remember stuff!
   - So let's make a history
   - 03-with-openai-request-with-history.ts
   - Problem : If I restart my program, the history is lost! And we also make loads of LLM requests. Whoops
   - Solution: Let's populate the history from the stream when we start

05 Now we have a new problem - The agent makes lots of LLM requests -

Narrative

- Here's a typescript
- Let's import this SDK
- Let's append an event called {"type": "input-item-added", "payload": { "role": "user", "content": "What is 50 - 8?" }}
  - Look it's here in the browser - use raw renderer
- Now let's do openai.responses.create({ model: "gpt-5.4", instructions: "You are a helpful assistant. Keep answers concise.", input: [{"role": "user", "content": "What is 50 - 8?" }] })

defineProcessor(() => {
return {
slug: "bla",
afterAppend: async ({ event }) => {
if (event.type === "input-item-added") {
// this where the agent makes an LLM request
}

    },

};
});

Iteration 2:
Problem:

- there is no history
  Solution:
- let's do "let history : ResponseInputItem[] = []" and always append to it when we get a request or response

Iterattion 3:
Problem:

- Agent doesn't remember what we spoke about if I restart my program
  Solution:
- Populate history from client.stream({ path: streamPath })) when we start - but be careful not to cause more LLM requests

Iteration 4:
