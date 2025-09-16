import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";
import { env } from "cloudflare:workers";
import postgres from "postgres";

const pg = postgres(env.ITERATE_POSTGRES.connectionString, {
  // Limit the connections for the Worker request to 5 due to Workers' limits on concurrent external connections
  max: 5,
  // If you are not using array types in your Postgres schema, disable `fetch_types` to avoid an additional round-trip (unnecessary latency)
  fetch_types: false,
});

export const db = drizzle(pg, { schema, casing: "snake_case" });
