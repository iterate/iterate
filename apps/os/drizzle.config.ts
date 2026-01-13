import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: `backend/db/migrations`,
  schema: `backend/db/schema.ts`,
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.PSCALE_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/os",
  },
});
