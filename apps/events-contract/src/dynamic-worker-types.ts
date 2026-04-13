import { z } from "zod";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";

export const DynamicWorkerConfiguredEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/dynamic-worker/configured"),
  payload: z
    .strictObject({
      slug: z.string().trim().min(1),
      compatibilityDate: z.string().trim().min(1).optional(),
      compatibilityFlags: z.array(z.string().trim().min(1)).optional(),
      outboundGateway: z
        .strictObject({
          entrypoint: z.literal("DynamicWorkerEgressGateway"),
          props: z
            .strictObject({
              secretHeaderName: z.string().trim().min(1).optional(),
              secretHeaderValue: z.string().trim().min(1).optional(),
            })
            .optional()
            .superRefine((props, ctx) => {
              if (props == null) {
                return;
              }

              if ((props.secretHeaderName == null) !== (props.secretHeaderValue == null)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: "Provide both secretHeaderName and secretHeaderValue together.",
                  path: ["secretHeaderName"],
                });
              }
            }),
        })
        .optional(),
      script: z.string().trim().min(1).optional(),
      modules: z.record(z.string(), z.string().trim().min(1)).optional(),
    })
    .superRefine((value, ctx) => {
      const hasScript = value.script != null;
      const hasModules = value.modules != null;

      if (!hasScript && !hasModules) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide either `script` or `modules`.",
          path: ["script"],
        });
      }

      if (hasScript && hasModules) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide either `script` or `modules`, not both.",
          path: ["script"],
        });
      }

      if (hasModules && value.modules!["processor.ts"] == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`modules` must contain a `processor.ts` entry.",
          path: ["modules"],
        });
      }
    }),
});
export const DynamicWorkerConfiguredEvent = GenericEventBase.extend(
  DynamicWorkerConfiguredEventInput.pick({ type: true, payload: true }).shape,
);
export type DynamicWorkerConfiguredEventInput = z.infer<typeof DynamicWorkerConfiguredEventInput>;
export type DynamicWorkerConfiguredEvent = z.infer<typeof DynamicWorkerConfiguredEvent>;

export const DynamicWorkerEnvVarSetEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/dynamic-worker/env-var-set"),
  payload: z.strictObject({
    key: z.string().trim().min(1),
    value: z.string(),
  }),
});
export const DynamicWorkerEnvVarSetEvent = GenericEventBase.extend(
  DynamicWorkerEnvVarSetEventInput.pick({ type: true, payload: true }).shape,
);
export type DynamicWorkerEnvVarSetEventInput = z.infer<typeof DynamicWorkerEnvVarSetEventInput>;
export type DynamicWorkerEnvVarSetEvent = z.infer<typeof DynamicWorkerEnvVarSetEvent>;

export const DynamicWorkerOutboundGateway = z.strictObject({
  entrypoint: z.literal("DynamicWorkerEgressGateway"),
  props: z
    .strictObject({
      secretHeaderName: z.string().optional(),
      secretHeaderValue: z.string().optional(),
    })
    .optional(),
});
export type DynamicWorkerOutboundGateway = z.infer<typeof DynamicWorkerOutboundGateway>;

export const DynamicWorkerConfig = z.object({
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()),
  mainModule: z.string(),
  modules: z.record(z.string(), z.string()),
  outboundGateway: DynamicWorkerOutboundGateway.optional(),
});
export type DynamicWorkerConfig = z.infer<typeof DynamicWorkerConfig>;

export const DynamicWorkerState = z
  .object({
    envVarsByKey: z.record(z.string(), z.string()).default({}),
    workersBySlug: z.record(z.string(), DynamicWorkerConfig).default({}),
  })
  .default({ envVarsByKey: {}, workersBySlug: {} });
export type DynamicWorkerState = z.infer<typeof DynamicWorkerState>;
