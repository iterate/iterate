---
description: "Cloudflare Workers patterns and utilities"
globs: ["apps/*/backend/**/*.ts"]
---

Our backend is deployed to cloudflare workers with nodejs-compat turned on.

### Use `waitUntil()` to run tasks in the background

**Important:** Always use the wrapper from the app's `env.ts` instead of importing directly from `cloudflare:workers`. The wrapper adds error handling and logging.

```ts
import { waitUntil } from "../env.ts";

waitUntil(
  (async () => {
    await someAsyncTask();
  })(),
);
```

Note: `waitUntil` takes a `Promise`, not a function. Use an IIFE (Immediately Invoked Function Expression) as shown above.

Do NOT import directly from `cloudflare:workers` - use the wrapper to ensure errors are caught and logged.

### Import cloudflare env from the app's env.ts

```ts
import { env, type CloudflareEnv } from "../env.ts";
```
