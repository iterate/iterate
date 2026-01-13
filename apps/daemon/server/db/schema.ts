import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const harnessTypes = ["claude-code", "opencode", "pi"] as const;
export type HarnessType = (typeof harnessTypes)[number];

export const sessionStatuses = ["stopped", "running", "error"] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

/**
 * Sessions table - stores agent session metadata.
 *
 * The slug is the primary key and matches the tmux session name (agent_{slug}).
 * Status is synced from tmux via the sync-sessions.ts script.
 *
 * IMPORTANT: If you modify this schema, also update the schema in
 * scripts/sync-sessions.ts to keep them in sync.
 */
export const sessions = sqliteTable("sessions", {
  slug: text().primaryKey(),
  harnessType: text("harness_type", { enum: harnessTypes }).notNull().default("claude-code"),
  workingDirectory: text("working_directory"),
  status: text({ enum: sessionStatuses }).notNull().default("running"),
  initialPrompt: text("initial_prompt"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

// Backwards compatibility aliases
export const agentTypes = harnessTypes;
export type AgentType = HarnessType;
export const agentStatuses = sessionStatuses;
export type AgentStatus = SessionStatus;
export type Agent = Session;
export type NewAgent = NewSession;
export const agents = sessions;
