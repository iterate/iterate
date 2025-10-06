import type { Config } from "drizzle-kit";

export default {
  out: `backend/drizzle/migrations`,
  schema: `backend/db/schema.ts`,
  dialect: "sqlite",
} satisfies Config;
