import { desc, isNull } from "drizzle-orm";
import { schema } from "./client.ts";

/**
 * usage: `db.query.installation.findMany({ with: recentActiveSources })`
 */
export const recentActiveSources = {
  sources: {
    orderBy: desc(schema.iterateConfigSource.updatedAt),
    where: isNull(schema.iterateConfigSource.deactivatedAt),
  },
};
