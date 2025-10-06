import type { user, organization, estate, agentInstance, iterateConfig } from "../db/schema.ts";
import type { AgentCoreEvent, AugmentedCoreReducedState } from "./agent-core-schemas.ts";

export interface AgentTraceExportMetadata {
  agentTraceExportId: string;
  braintrustPermalink?: string;
  posthogTraceId: string;
  debugUrl: string;
  user: typeof user.$inferSelect | null;
  estate: typeof estate.$inferSelect;
  organization: typeof organization.$inferSelect;
  agentInstance: typeof agentInstance.$inferSelect;
  iterateConfig: typeof iterateConfig.$inferSelect | null;
}

export interface FileMetadata {
  filename: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

export interface AgentTraceExport {
  version: string;
  exportedAt: string;
  metadata: AgentTraceExportMetadata;
  fileMetadata: Record<string, FileMetadata>;
  events: AgentCoreEvent[];
  reducedStateSnapshots: Record<number, AugmentedCoreReducedState>;
}
