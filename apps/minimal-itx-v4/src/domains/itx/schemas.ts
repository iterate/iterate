import { z } from "zod";
import { WorkerRef } from "../workers/schemas.ts";
import type { CapabilityRecord as CapabilityRecordType } from "./types.ts";

export const CapabilityRecord = z.discriminatedUnion("type", [
  z.strictObject({
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    type: z.literal("live"),
  }),
  z.strictObject({
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    type: z.literal("worker"),
    workerRef: WorkerRef,
  }),
]) satisfies z.ZodType<CapabilityRecordType, unknown>;
