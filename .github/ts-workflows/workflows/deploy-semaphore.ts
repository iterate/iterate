import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflarePreviewApps } from "../../../scripts/preview/apps.ts";
import { createCloudflareAppWorkflow } from "../utils/cloudflare-app-workflow.ts";

const workflow: Workflow = await createCloudflareAppWorkflow(
  import.meta,
  cloudflarePreviewApps.semaphore,
);

export default workflow;
