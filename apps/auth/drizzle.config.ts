import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/migrations",
  casing: "snake_case",
  driver: "d1-http",
});
