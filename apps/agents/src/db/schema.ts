import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const agentsTable = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    projectSlug: text("project_slug").notNull().default("public"),
    streamPath: text("stream_path").notNull(),
    agentInstance: text("agent_instance").notNull(),
    publicBaseUrl: text("public_base_url").notNull(),
    callbackUrl: text("callback_url").notNull(),
    debugUrl: text("debug_url").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agents_project_slug_stream_path_unique").on(table.projectSlug, table.streamPath),
    index("idx_agents_created_at").on(table.createdAt),
    index("idx_agents_updated_at").on(table.updatedAt),
  ],
);
