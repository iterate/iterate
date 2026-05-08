import { createD1Client } from "sqlfu";
import { env } from "../env.ts";

export const db = createD1Client(env.DB);
export type DB = typeof db;
