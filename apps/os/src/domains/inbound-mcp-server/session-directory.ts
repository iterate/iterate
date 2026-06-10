// Inbound-MCP session listing: the domain function both the oRPC projects
// router and itx.mcp delegate to (the DO catalog is the session registry).

import { env } from "cloudflare:workers";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { ProjectMcpServerConnectionStructuredName } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";

export async function listInboundMcpSessions(input: { projectId: string }) {
  const records = await listD1ObjectCatalogRecordsByIndex<ProjectMcpServerConnectionStructuredName>(
    env.DB,
    {
      className: "ProjectMcpServerConnection",
      indexName: "projectId",
      indexValue: input.projectId,
    },
  );

  return {
    sessions: records.map((record) => ({
      name: record.name,
      projectId: record.structuredName.projectId,
      projectSlug: record.structuredName.projectSlug,
      streamPath: StreamPath.parse(record.structuredName.streamPath),
      clientId: record.structuredName.clientId,
      clientName: record.structuredName.clientName,
      userId: record.structuredName.userId,
      createdAt: record.createdAt,
      lastWokenAt: record.lastWokenAt,
    })),
  };
}
