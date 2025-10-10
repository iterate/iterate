> [!IMPORTANT]
> Remember to go back to the iterate website to grant the bot access to your repository.

# Welcome to your iterate repo!

Use `iterate.config.ts` to configure your @iterate agent.

It's just typescript, so you can experiment with different ways of structuring your repo.

Or, if you're not so technically minded, just drop markdown files in the `rules/` folder.

# Things to do next

- Remove the annoying example rules and update or add others that explain how your company works
- Have a look at iterate's own iterate estate to see how we use it: https://github.com/iterate/iterate/estates/iterate

# Why is everything in a git repository?

We like to model your entire "startup as code" in a git repository.

At the moment it just contains context rules, but in time it will contain the source code of your applications, human language instructions for your agents (and humans), and configuration files.

Using git makes it easy for

- a human to approve proposed changes an AI is making
- for an agent to make atomic changes across different parts of the company
- for the agent to update its own behaviour (per-customer system prompt learning)
