# What I am working towards

Big picture

1. I can create a project <project>.iterate.app
2. agents.<project>.iterate.app/path/to/agent
3. Each agent has a corredponding sandbox that is spun up / down on demand
4. Secrets and third party integrations, including MCP servers, can be configured

# Immediate future

Can we make an agent that

1. Only "does things", including talking to us humans, via codemode?
2. Just uses triple backticks blocks and no tool calling
3. Collects input context from other processors (via debounce collect)

# Long term

- Agents write workflow code!

# Examples of tools

`messageAgent({ path, message })`

- path can be relative
- sends a message to an agent on that path
- path must be under `/agents`
- appends a `agent-input-added` event to the agent's stream - includes the message content

`sendSlackMessage({ channel, thread_ts, message })`

- sends a message to a Slack channel
- message is the message to send
- appends slack-message-added event to stream

```ts
await ctx.remindMeLater({
    delay: "30m"
    message: "Remember to do this thing"
})
```

- just appends a scheduled event

# Processor API changes

- Processor should be class
- Stream path should be passed to constructor
