Plan for pi agent integration:

In os
- When receiving slack webhooks, forward them to the iterate instance sandbox

In daemon / pi setup MVP
- Make it so we can receive slack message
- Make it so we can send messages back to slack (either as tool calls or )
- proxy LLM requests through worker so we don't expose our openai API keys
- Find a way to wire up our MCP stuff and context rules
