import { WorkflowEntrypoint } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client.ts";
import type { CloudflareEnv } from "../../env.ts";
import { invalidateOrganizationQueries } from "../utils/websocket-utils.ts";

export type EstateBuilderWorkflowInput = {
  estateId: string;
  commitHash: string;
  commitMessage: string;
  repoUrl: string;
  installationToken: string;
  connectedRepoPath?: string;
  branch?: string;
  webhookId?: string;
  workflowRunId?: string;
  isManual?: boolean;
};

export class EstateBuilderWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  EstateBuilderWorkflowInput
> {
  async run(
    event: Readonly<CloudflareWorkersModule.WorkflowEvent<EstateBuilderWorkflowInput>>,
    step: CloudflareWorkersModule.WorkflowStep,
  ) {
    const { payload, instanceId: buildId } = event;

    await step.do(
      "trigger build",
      {
        retries: {
          limit: 3,
          delay: "1 minute",
          backoff: "exponential",
        },
        timeout: "10 minutes",
      },
      async () => {
        const container = getContainer(this.env.ESTATE_BUILD_MANAGER, payload.estateId);
        using _build = await container.build({
          buildId,
          repo: payload.repoUrl,
          branch: payload.branch || "main",
          path: payload.connectedRepoPath || "/",
          authToken: payload.installationToken,
        });
      },
    );

    await step.do("create build record", async () => {
      const db = getDb();
      await db.insert(schema.builds).values({
        id: buildId,
        status: "in_progress",
        commitHash: payload.commitHash,
        commitMessage: payload.isManual
          ? `[Manual] ${payload.commitMessage}`
          : payload.commitMessage,
        webhookIterateId:
          payload.webhookId || `${payload.isManual ? "manual" : "auto"}-${Date.now()}`,
        files: [],
        estateId: payload.estateId,
        iterateWorkflowRunId: payload.workflowRunId,
      });

      // Get the organization ID for WebSocket invalidation
      const estateWithOrg = await db.query.estate.findFirst({
        where: eq(schema.estate.id, payload.estateId),
        with: {
          organization: true,
        },
      });

      // Invalidate organization queries to show the new in-progress build
      if (estateWithOrg?.organization) {
        await invalidateOrganizationQueries(this.env, estateWithOrg.organization.id, {
          type: "INVALIDATE",
          invalidateInfo: {
            type: "TRPC_QUERY",
            paths: ["estate.getBuilds"],
          },
        });
      }
    });
  }
}
