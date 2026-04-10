import { z } from "zod";
import { os, runIfMain } from "../sdk.ts";
import { deployProcessor } from "../lib/deploy-processor.ts";

const DeployProcessorInput = z.object({
  file: z.string().trim().min(1).describe("Path to a module that exports a processor"),
  streamPath: z.string().trim().min(1).describe("Stream path to configure, e.g. /jonas/agent"),
  eventJson: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional JSON event to append after the processor is configured"),
  baseUrl: z
    .string()
    .trim()
    .url()
    .optional()
    .describe("Events base URL, defaults to BASE_URL or https://events.iterate.com"),
  projectSlug: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional x-iterate-project header value"),
  slug: z.string().trim().min(1).optional().describe("Optional dynamic worker slug override"),
  processorExportName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Named export to use when the module exports more than one processor"),
  outboundGateway: z
    .boolean()
    .default(true)
    .describe("Route outbound fetch through DynamicWorkerEgressGateway"),
  nodejsCompat: z
    .boolean()
    .default(false)
    .describe("Enable Cloudflare Workers nodejs_compat for node:* builtins"),
});

export const handler = os
  .input(DeployProcessorInput)
  .meta({
    description:
      "Bundle a processor module into stream/dynamic-worker/configured and append it to a stream",
  })
  .handler(async ({ context, input }) => {
    const result = await deployProcessor({
      ...input,
      compatibilityFlags: input.nodejsCompat ? ["nodejs_compat"] : undefined,
    });

    context.logger.info(
      `Deployed ${result.file} (${result.processorExportName}) to ${result.streamPath} as ${result.processorSlug}`,
    );

    return {
      baseUrl: result.baseUrl,
      configuredEventType: result.configuredEvent.type,
      file: result.file,
      outboundGateway: result.outboundGateway,
      processorExportName: result.processorExportName,
      processorSlug: result.processorSlug,
      projectSlug: result.projectSlug,
      seedEventType: result.seedEvent?.type,
      streamPath: result.streamPath,
    };
  });

runIfMain(import.meta.url, handler);
