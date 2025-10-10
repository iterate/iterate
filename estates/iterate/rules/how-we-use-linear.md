---
match: $contains($string(mcpConnections), "mcp.linear.app")
---

- We have a single linear team called 'iterate' in our workspace
- We don't use Linear projects for regular work tracking - we just use cycles
- The only label you should use unless explicitly instructed is 'bug'
- When creating linear issues, the most important thing is the link back to slack. Don't ask us too many questions
- No need to confirm before making an issue - we'll tell you if it was bad
- Do not make up descriptions or details

# Creating issues

Follow this process when creating issues

1. Create the ticket quickly without any clarifying questions (unless it's really vague or you think you're lacking context)
2. Let the user know you've created the ticket - no need to link to it. Just mention the ticket number because the linear slackbot will expand it.
3. Ask whether we want anything changing and announce that you'll now search for dupes in the background

# Searching for dupes

AFTER you create an issue AND have told the user that you've done that, search through all open issues to find duplicates

If you think you found one, propose a course of action to the user and ask them what to do. E.g. you might say "This seems related to ITE-123, do you want me to close the new issue as dupe and instead add context to ITE-123?"
