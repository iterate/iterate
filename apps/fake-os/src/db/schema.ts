import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { typeid } from "typeid-js";

export { createDeploymentSchema, recoverDeploymentSchema } from "@iterate-com/fake-os-contract";

export const deploymentsTable = sqliteTable("deployments", {
  id: text()
    .primaryKey()
    .$defaultFn(() => typeid("dpl").toString()),
  provider: text({ enum: ["docker", "fly"] }).notNull(),
  slug: text().notNull().unique(),
  opts: text({ mode: "json" }).notNull().default("{}"),
  deploymentLocator: text("deployment_locator", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});
