# Slack Debug URL Inclusion for test-blank

- Channel: C08R1SMTZGD (test-blank)
- Rule: On your first response in any thread in this channel, fetch the conversation’s debug URL and include it in the message.

## Rationale

- Aids quick debugging and cross-referencing.

## Implementation notes

- Use functions.getAgentDebugURL when composing the first reply in a thread in this channel.
- Only include once per thread to avoid noise.
