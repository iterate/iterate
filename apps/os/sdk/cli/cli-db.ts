/**
 * Basically the same as the backend/db/client.ts file, but without cloudflare specific stuff.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../backend/db/schema.ts";

if (!process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING) {
  throw new Error("DRIZZLE_RW_POSTGRES_CONNECTION_STRING is not set");
}

export const createDb = (connectionString: string) => {
  return drizzle(
    postgres(connectionString, {
      max: 5,
      fetch_types: false,
    }),
    { schema, casing: "snake_case" },
  );
};

export const db = createDb(process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING!);

export type DB = typeof db;

export * as schema from "../../backend/db/schema.ts";
