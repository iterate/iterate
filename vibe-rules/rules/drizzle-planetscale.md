---
description: "We use the drizzle ORM"
globs: ["apps/os/backend/**/*.ts"]
---

We use Planetscale Postgres with Drizzle as our ORM. In development we run postgres in a docker container.

Remember to use db.transaction() when performing multiple related database operations that should succeed or fail together.
