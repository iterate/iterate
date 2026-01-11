import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const agentTypes = ["claude-code", "opencode", "pi"] as const;
export type AgentType = (typeof agentTypes)[number];

export const agentStatuses = ["stopped", "running", "error"] as const;
export type AgentStatus = (typeof agentStatuses)[number];

export const agents = sqliteTable("agents", {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  harnessType: text("harness_type", { enum: agentTypes }).notNull(),
  harnessSessionId: text("harness_session_id"),
  tmuxSession: text("tmux_session"),
  workingDirectory: text("working_directory").notNull(),
  status: text({ enum: agentStatuses }).notNull().default("stopped"),
  initialPrompt: text("initial_prompt"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
