---
description: "Cloudflare Workers patterns and utilities"
globs: ["**/*.ts"]
---

Our backend is deployed to cloudflare workers with nodejs-compat turned on.

### Use `waitUntil()` to run tasks in the background

```ts
import { waitUntil } from "cloudflare:workers";

waitUntil(async () => {
  await someAsyncTask();
});
```

### Import cloudflare env from `apps/os/env.ts`

```ts
import { env, type CloudflareEnv } from "../env.ts";
```
