import { drizzle } from "drizzle-orm/d1";
import { env } from "../env.ts";
import * as schema from "./schema.ts";

export const db = drizzle(env.DB, { casing: "snake_case", schema });
export type DB = typeof db;

export * as schema from "./schema.ts";
