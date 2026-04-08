import { resolve } from "node:path";
import { os } from "@orpc/server";
import { z } from "zod";
import { buildDynamicWorkerConfiguredEvent } from "../src/durable-objects/dynamic-worker-bundler.ts";
import { router as demoRouter } from "./demo/router.ts";

const DynamicWorkerConfiguredEventInput = z.object({
  entryFile: z.string().trim().min(1).describe("Path to the processor entry file"),
  slug: z.string().trim().min(1).optional().describe("Dynamic worker slug"),
  compatibilityDate: z.string().trim().min(1).optional().describe("Compatibility date"),
  compatibilityFlags: z.array(z.string().trim().min(1)).optional().describe("Compatibility flags"),
  outboundGateway: z
    .boolean()
    .optional()
    .default(false)
    .describe("Route outbound fetch through DynamicWorkerEgressGateway"),
  secretHeaderName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional egress secret header name"),
  secretHeaderValue: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional egress secret header value"),
});

export const router = {
  ...demoRouter,
  "dynamic-worker-configured-event": os
    .input(DynamicWorkerConfiguredEventInput)
    .meta({
      description:
        "Bundle a current-shape processor into a dynamic-worker/configured event payload",
    })
    .handler(async ({ input }) => {
      if ((input.secretHeaderName == null) !== (input.secretHeaderValue == null)) {
        throw new Error("Provide both secretHeaderName and secretHeaderValue together.");
      }

      const shouldUseOutboundGateway =
        input.outboundGateway ||
        (input.secretHeaderName != null && input.secretHeaderValue != null);

      return await buildDynamicWorkerConfiguredEvent({
        compatibilityDate: input.compatibilityDate,
        compatibilityFlags: input.compatibilityFlags,
        entryFile: resolve(process.cwd(), input.entryFile),
        outboundGateway: !shouldUseOutboundGateway
          ? undefined
          : {
              entrypoint: "DynamicWorkerEgressGateway",
              ...(input.secretHeaderName == null || input.secretHeaderValue == null
                ? {}
                : {
                    props: {
                      secretHeaderName: input.secretHeaderName,
                      secretHeaderValue: input.secretHeaderValue,
                    },
                  }),
            },
        slug: input.slug,
      });
    }),
};
