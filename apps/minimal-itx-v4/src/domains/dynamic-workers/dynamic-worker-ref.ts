import { z } from "zod";
import type {
  DynamicWorkerRef as DynamicWorkerRefType,
  DynamicWorkerSource as DynamicWorkerSourceType,
} from "../../../types-and-schemas.ts";

export const DynamicWorkerSource = z.discriminatedUnion("type", [
  z.strictObject({
    mainModule: z.string(),
    modules: z.record(z.string(), z.string()),
    type: z.literal("inline"),
  }),
  z.strictObject({
    repoPath: z.string(),
    sourcePath: z.string(),
    type: z.literal("repo"),
  }),
]);
export type DynamicWorkerSource = DynamicWorkerSourceType;

export const DynamicWorkerRef = z.strictObject({
  cacheKey: z.string().optional(),
  source: DynamicWorkerSource,
  target: z.discriminatedUnion("type", [
    z.strictObject({
      entrypoint: z.string().optional(),
      props: z.record(z.string(), z.json()).optional(),
      type: z.literal("worker-entrypoint"),
    }),
    z.strictObject({
      className: z.string(),
      type: z.literal("durable-object"),
    }),
  ]),
});
export type DynamicWorkerRef = DynamicWorkerRefType;
