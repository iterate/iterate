import { defineConfig } from "drizzle-kit";
import { resolveLocalDockerPostgresPort } from "./scripts/local-docker-postgres-port.ts";

export default defineConfig({
  out: `backend/db/migrations`,
  schema: `backend/db/schema.ts`,
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.PSCALE_DATABASE_URL ??
      process.env.DATABASE_URL ??
      `postgres://postgres:postgres@localhost:${resolveLocalDockerPostgresPort()}/os`,
  },
});
