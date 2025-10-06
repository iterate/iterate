---
description: "Usage of trpc and tanstack react query in apps"
globs: ["**/*.tsx"]
---

## Prefer the useSuspenseQuery hook when making trpc queries

As per these docs: https://trpc.io/docs/client/react/suspense

We want to use <Suspense> and <ErrorBoundary> in sensible places.
E.g.

```tsx
const { data } = useSuspenseQuery(
  trpc.agent.conversation.getConversation.queryOptions({
    conversationId: "123",
  }),
);
```
