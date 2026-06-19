import { z } from "zod";

export const DynamicWorkerSourceRef = z.discriminatedUnion("type", [
  z.looseObject({
    mainModule: z.string(),
    modules: z.record(z.string(), z.string()),
    type: z.literal("inline"),
  }),
  z.looseObject({
    repoPath: z.string(),
    sourcePath: z.string(),
    type: z.literal("from-repo"),
  }),
]);
export type DynamicWorkerSourceRef = z.infer<typeof DynamicWorkerSourceRef>;

export const DynamicWorkerRef = z.discriminatedUnion("type", [
  z.looseObject({
    cacheKey: z.string().optional(),
    entrypoint: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    source: DynamicWorkerSourceRef,
    type: z.literal("worker-entrypoint"),
  }),
  z.looseObject({
    cacheKey: z.string().optional(),
    className: z.string(),
    source: DynamicWorkerSourceRef,
    type: z.literal("durable-object"),
  }),
]);
export type DynamicWorkerRef = z.infer<typeof DynamicWorkerRef>;
