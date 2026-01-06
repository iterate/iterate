import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../../env.ts";
import * as schema from "./schema.ts";

export const getDb = () => {
  const client = postgres(env.DATABASE_URL, {
    prepare: false,
  });
  return drizzle(client, { schema, casing: "snake_case" });
};

export type DB = ReturnType<typeof getDb>;
