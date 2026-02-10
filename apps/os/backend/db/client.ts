import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { env } from "../../env.ts";
import * as schema from "./schema.ts";

export const getDb = () => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  return drizzle({ client: pool, schema, casing: "snake_case" });
};

/** Accepts any env-like object with DATABASE_URL */
export const getDbWithEnv = (envParam: { DATABASE_URL: string }) => {
  const pool = new Pool({ connectionString: envParam.DATABASE_URL });
  return drizzle({ client: pool, schema, casing: "snake_case" });
};

export type DB = ReturnType<typeof getDb>;
