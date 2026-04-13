import { os, runIfMain } from "../sdk.ts";
import { DeployCommandInput, runDeployCommand } from "../lib/deploy-command.ts";

export const handler = os
  .input(DeployCommandInput)
  .meta({
    description:
      "Bundle a processor module into stream/dynamic-worker/configured and append it to a stream",
  })
  .handler(async ({ context, input }) => {
    const result = await runDeployCommand(input);

    context.logger.info(
      `Deployed ${result.file} (${result.processorExportName}) to ${result.streamPath} as ${result.processorSlug}`,
    );

    return result;
  });

runIfMain(import.meta.url, handler);
