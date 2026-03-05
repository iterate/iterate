import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { typeid } from "typeid-js";
import { z } from "zod";

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

export const createDeploymentSchema = z.object({
  provider: z.enum(["docker", "fly"]),
  slug: z
    .string()
    .min(1, "Slug is required")
    .regex(/^[a-z0-9-]+$/, "Lowercase alphanumeric and hyphens only"),
  opts: z.string().transform((s, ctx) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid JSON" });
      return z.NEVER;
    }
  }),
});
