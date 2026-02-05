import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: `backend/db/migrations`,
  schema: `backend/db/schema.ts`,
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.PSCALE_DATABASE_URL ??
      process.env.DATABASE_URL ??
      `postgres://postgres:postgres@localhost:${process.env.LOCAL_DOCKER_POSTGRES_PORT ?? "5432"}/os`,
  },
});
