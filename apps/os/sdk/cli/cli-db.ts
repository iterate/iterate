/**
 * Basically the same as the backend/db/client.ts file, but without cloudflare specific stuff.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../backend/db/schema.ts";

if (!process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING) {
  throw new Error("DRIZZLE_RW_POSTGRES_CONNECTION_STRING is not set");
}

const pg = postgres(process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING, {
  max: 5,
  // If you are not using array types in your Postgres schema, disable `fetch_types` to avoid an additional round-trip (unnecessary latency)
  fetch_types: false,
});

export const db = drizzle(pg, { schema, casing: "snake_case" });

export type DB = typeof db;

export * as schema from "../../backend/db/schema.ts";
