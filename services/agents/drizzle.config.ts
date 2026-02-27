import { defineConfig } from "drizzle-kit";

const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
};

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url:
      firstNonEmpty(process.env.DATABASE_URL, process.env.AGENTS_SERVICE_DB_PATH) ??
      "agents.sqlite",
  },
});
