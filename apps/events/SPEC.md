# Events app

We are building an event streaming system for Cloudflare, and it should fundamentally be based on the following primitives:

- We have a durable object called event stream.
- The stream supports, in principle, just append and read operations.
- The way you interact with this thing is through ORPC procedures.

# Key ideas

- streams are implicitly created when first appended to
- the only way to mutate a stream is to append to it
- we care about simplicity!

## Event shape

// TODO take this from apps/events-contract

# API

# End to end testing

End to end (e2e) tests are in e2e/ - they are the most important part of this app!

E2E tests take as input a deployed events app base URL.

There is a fixture

```ts
import { test } from "vitest";

test("e2e", async ({ baseURL }) => {
  await using f = await withEventsApp({
    baseURL: "https://events.iterate.com",
  });

  const c = f.connect({
    path: "/test",
  });

  await c.append({
    event: {
      type: "test",
      data: {
        message: "Hello, world!",
      },
    },
  });
});
```

The events app has an optional egressProxyBaseUrl config option. When set, all outbound fetch traffic goes through this URL.

So we can set up

E2E tests take a deployed events app URL as input

# Phases

1. Basic durable stream shape
