import { migrateSqliteFile } from "./sqlite.ts";
import { resolveSqliteFilenameFromEnv } from "./storage-path.ts";

const filename = resolveSqliteFilenameFromEnv(process.env);

await migrateSqliteFile(filename);
console.log(`migrated ${filename}`);
