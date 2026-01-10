---
state: next
tags:
  - daemon
  - ui
priority: medium
size: small
---

# Use Vercel AI Elements in Daemon UI

Integrate [Vercel AI Elements](https://ai-sdk.dev/elements) into the daemon UI for building the chat/conversation interface.

AI Elements is a component library built on top of shadcn/ui that provides pre-built components for AI-native applications:

- Conversations
- Messages
- Chat inputs with attachments
- And more

Since we already use shadcn/ui, this should integrate nicely. Components can be installed via:

```bash
npx ai-elements@latest
```

Or via the shadcn CLI.
