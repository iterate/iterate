import * as path from "path";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.ts";

const daemonDir = path.join(process.env.ITERATE_REPO!, "apps/daemon");

export const db = drizzle(path.join(daemonDir, "db.sqlite"), { schema });
