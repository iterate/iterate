---
key: slack-test-blank-debug-url
match: agentCoreState.slackChannelId = "C08R1SMTZGD"
description: Include the conversation debug URL in the first response in #test-blank
---

# Debug URL in first reply

- This rule overrides other instructions about `getAgentDebugURL`; in Slack channel C08R1SMTZGD you must retrieve the debug URL proactively.
- Before sending your first assistant message in any conversation thread, call the `getAgentDebugURL` tool to fetch the URL for the current conversation.
- Add the returned URL to that first response on its own line. Prefer Slack link formatting, for example `Debug URL: <https://example.com|open debug view>` and replace the placeholder with the actual `debugURL`.
- Skip this step entirely if you already see any previous assistant message from yourself in the thread, and never repeat the link in subsequent replies.
- If the tool call fails, mention the failure in that first response and continue with the rest of the reply as normal.
