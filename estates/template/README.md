# Welcome to your iterate repo!

Use `iterate.config.ts` to configure your @iterate agent.

It's just typescript, so you can experiment with different ways of structuring your repo.

For example, we've deliberately designed this to make it easy to install rules from a shadcn registry

# Context rules are all you need!

The primary concept you need to know about is called a `ContextRule`. It combines some prompt fragments and tools

```typescript
const someRule = defineRule({
  // The key is just a globally unique identifier
  // You can override keys that are used within the system - it works a bit like an i18n library
  key: "my-new-rule",

  // The prompt is appended to the end of the system prompt
  // In the future it'll be possible to more precisely control where in the context it goes
  prompt: "",

  // The matcher is used to determine whether or not a rule should be used
  // It matches against the agent's internal state
  match: matchers.always(), // this is the default so can be ommitted
});
```

You can find the default rules that the agent uses here: https://github.com/iterate/iterate/blob/main/apps/os/backend/agent/default-context-rules.ts

# Things to do next

- Remove the annoying example rules and update or add others that explain how your company works
- Remove any rules that are annoying you
- Join our community slack channel - email jonas@iterate.com for an invite if you haven't gotten one
- Have a look at iterate's own iterate estate to see how we use it: https://github.com/iterate/iterate/estates/iterate

# Why is everything in a git repository?

We like to model your entire "startup as code" in a git repository.

At the moment it just contains context rules, but in time it will contain the source code of your applications, human language instructions for your agents (and humans), and configuration files.

Using git makes it easy for

- a human to approve proposed changes an AI is making
- for an agent to make atomic changes across different parts of the company
- for the agent to update its own behaviour (per-customer system prompt learning)
