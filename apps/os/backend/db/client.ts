import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const envOrError = await import("../../env.ts").catch(String);
const getEnv = () => {
  if (typeof envOrError === "string") {
    throw new Error(
      `${envOrError} - this occurs when trying to use "env" outside of a cloudflare environment`,
    );
  }
  return envOrError.env;
};

const pg = (connectionString: string) =>
  postgres(connectionString, {
    // Use connection pooling with a small max for Cloudflare Workers
    max: 5,
    // If you are not using array types in your Postgres schema, disable `fetch_types` to avoid an additional round-trip (unnecessary latency)
    fetch_types: false,
    // Important for Cloudflare Workers - don't keep connections alive
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });

export const getDb = (connectionString = getEnv().ITERATE_POSTGRES.connectionString) =>
  drizzle(pg(connectionString), { schema, casing: "snake_case" });

export type DB = ReturnType<typeof getDb>;

export * as schema from "./schema.ts";
