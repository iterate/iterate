import { z } from "zod";
import { DynamicWorkerRef } from "../dynamic-workers/schemas.ts";
import type { CapabilityRecord as CapabilityRecordType } from "./types.ts";

export const CapabilityRecord = z.discriminatedUnion("type", [
  z.strictObject({
    path: z.array(z.string()),
    type: z.literal("live"),
  }),
  z.strictObject({
    path: z.array(z.string()),
    type: z.literal("dynamic-worker"),
    workerRef: DynamicWorkerRef,
  }),
]) satisfies z.ZodType<CapabilityRecordType, unknown>;
