import { z } from "zod";
import {
  createPreviewEnvironmentViaOrpc,
  destroyPreviewEnvironmentViaOrpc,
  listPreviewEnvironmentsViaOrpc,
} from "./preview-environments.ts";

const PreviewWorkflowCommand = z.enum(["create", "destroy", "list-for-pr"]);

async function main() {
  const command = PreviewWorkflowCommand.parse(process.argv[2]);

  switch (command) {
    case "create": {
      const previewEnvironment = await createPreviewEnvironmentViaOrpc({
        previewEnvironmentAppSlug: process.env.PREVIEW_ENVIRONMENT_APP_SLUG,
        repositoryFullName: process.env.REPOSITORY_FULL_NAME,
        pullRequestNumber: Number(process.env.PULL_REQUEST_NUMBER),
        pullRequestHeadRefName: process.env.PULL_REQUEST_HEAD_REF_NAME,
        pullRequestHeadSha: process.env.PULL_REQUEST_HEAD_SHA,
        workflowRunUrl: process.env.WORKFLOW_RUN_URL,
        leaseMs: Number(process.env.PREVIEW_LEASE_MS),
        previewEnvironmentIdentifier: process.env.PREVIEW_ENVIRONMENT_IDENTIFIER,
      });
      console.log(JSON.stringify(previewEnvironment));
      return;
    }
    case "destroy": {
      const result = await destroyPreviewEnvironmentViaOrpc({
        previewEnvironmentIdentifier: process.env.PREVIEW_ENVIRONMENT_IDENTIFIER,
        previewEnvironmentSemaphoreLeaseId: process.env.PREVIEW_ENVIRONMENT_SEMAPHORE_LEASE_ID,
        destroyReason: process.env.DESTROY_REASON ?? "pull-request-closed",
      });
      console.log(JSON.stringify(result));
      return;
    }
    case "list-for-pr": {
      const previewEnvironments = await listPreviewEnvironmentsViaOrpc({
        repositoryFullName: process.env.REPOSITORY_FULL_NAME,
        pullRequestNumber: Number(process.env.PULL_REQUEST_NUMBER),
      });
      console.log(JSON.stringify(previewEnvironments));
      return;
    }
  }
}

await main();
