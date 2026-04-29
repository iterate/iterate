/**
 * Drizzle schema + types. The actual db instance is created in the entrypoint
 * (entry.facet.ts or entry.standalone.ts) since each uses a different driver.
 */
export * as schema from "./schema";
export { thingsTable } from "./schema";

// Re-export the db type from sqlite-core so both entrypoints produce compatible types
export type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
