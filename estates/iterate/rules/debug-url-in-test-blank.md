---
key: slack-channel-c08r1smtzgd-debug-url
match: "durableObjectClassName = 'SlackAgent' and slackChannelId = 'C08R1SMTZGD'"
---

When you're replying in #test-blank (Slack channel ID C08R1SMTZGD), attach the conversation's debug link the very first time you speak in each thread.

- Before drafting your initial reply in a thread (including when you start a root message), call the `functions.getAgentDebugURL` tool to retrieve the URL.
- Begin that first reply with its own line reading `debug: <URL|debug url>` where `URL` is replaced with the tool result, then add a blank line and continue with the rest of your message.
- Remember the retrieved URL so you can reference it again without re-calling the tool. Do **not** add the debug line or call the tool on later replies in the same thread.
- If you already see a `debug: <...|debug url>` line from yourself earlier in the thread, skip the tool call and proceed normally.
