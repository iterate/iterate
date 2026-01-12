# Backend Guidelines (apps/os2/backend)

This folder contains the Cloudflare Workers backend.

## Cloudflare Workers

Our backend runs on Cloudflare Workers with nodejs-compat enabled.

### Environment Variables

Import env from the app's env.ts:

```ts
import { env, type CloudflareEnv } from "../env.ts";
```

### Background Tasks with waitUntil

**Always use the wrapper from env.ts** - it adds error handling and logging:

```ts
import { waitUntil } from "../env.ts";

waitUntil(
  (async () => {
    await someAsyncTask();
  })(),
);
```

Note: `waitUntil` takes a `Promise`, not a function. Use an IIFE as shown.

**Do NOT import directly from `cloudflare:workers`.**

## Database (Drizzle + Postgres)

We use Drizzle ORM with Postgres. In development, Postgres runs in Docker.

### Transactions

Use `db.transaction()` for related operations that should succeed or fail together:

```ts
await db.transaction(async (tx) => {
  const [org] = await tx.insert(schema.organization).values({...}).returning();
  await tx.insert(schema.organizationUserMembership).values({
    organizationId: org.id,
    userId: ctx.user.id,
  });
});
```

### Drizzle Conventions

Use `schema.tableName` pattern for clarity:

```ts
// Do this
await db.insert(schema.organization).values({...});
await db.update(schema.project).set({...});

// Not this
await db.insert(organization).values({...});
```

## Logging

- **Do NOT use `console`** - use `logger` from `backend/tag-logger.ts`
- Use `logger.info` instead of `logger.log`
- Be intentional about production logging - avoid debug logs in production

```ts
import { logger } from "./tag-logger.ts";

logger.info("User created", { userId: user.id });
logger.error("Failed to process", { error });
```

## tRPC Routers

- Routers are in `trpc/routers/`
- Prefer authenticated procedures over `publicProcedure`
- Use Zod schemas for input validation
