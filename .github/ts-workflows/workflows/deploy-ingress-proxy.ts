import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflareApps } from "../utils/cloudflare-apps.ts";
import { createCloudflareAppWorkflow } from "../utils/cloudflare-app-workflow.ts";

const workflow: Workflow = await createCloudflareAppWorkflow(
  import.meta,
  cloudflareApps["ingress-proxy"],
);

export default workflow;
