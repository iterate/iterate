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

export const DynamicWorkerConfig = z.object({
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()),
  mainModule: z.string(),
  modules: z.record(z.string(), z.string()),
});
export type DynamicWorkerConfig = z.infer<typeof DynamicWorkerConfig>;

export const DynamicWorkerState = z.object({
  workersBySlug: z.record(z.string(), DynamicWorkerConfig),
});
export type DynamicWorkerState = z.infer<typeof DynamicWorkerState>;
