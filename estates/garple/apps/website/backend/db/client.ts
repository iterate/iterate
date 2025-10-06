import { drizzle } from "drizzle-orm/d1";
import { env } from "../../env.ts";
import * as schema from "./schema.ts";

export const db = drizzle(env.D1, { schema });
