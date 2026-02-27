import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentRoutesTable = sqliteTable(
  "agent_routes",
  {
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    provider: text("provider").notNull(),
    sessionId: text("session_id").notNull(),
    streamPath: text("stream_path").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_routes_pk",
      columns: [table.sourceKind, table.sourceId],
    }),
  ],
);

export const agentProvisioningTable = sqliteTable("agent_provisioning", {
  agentPath: text("agent_path").primaryKey().notNull(),
  provider: text("provider").notNull(),
  sessionId: text("session_id").notNull(),
  streamPath: text("stream_path").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
