import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";
import { env } from "../../env";
import postgres from "postgres";

const pg = () =>
  postgres(env.ITERATE_POSTGRES.connectionString, {
    // Use connection pooling with a small max for Cloudflare Workers
    max: 1,
    // If you are not using array types in your Postgres schema, disable `fetch_types` to avoid an additional round-trip (unnecessary latency)
    fetch_types: false,
    // Important for Cloudflare Workers - don't keep connections alive
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });

export const getDb = () => drizzle(pg(), { schema, casing: "snake_case" });

export type DB = ReturnType<typeof getDb>;
