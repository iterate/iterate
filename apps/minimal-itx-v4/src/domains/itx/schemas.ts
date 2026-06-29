import { z } from "zod";
import { WorkerRef } from "../workers/schemas.ts";
import type {
  CapabilityProvidedPayload as CapabilityProvidedPayloadType,
  CapabilityRecord as CapabilityRecordType,
  RevokeCapabilityInput,
} from "./types.ts";

export const CapabilityProvidedPayload = z.discriminatedUnion("type", [
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
]) satisfies z.ZodType<CapabilityProvidedPayloadType, unknown>;

export const CapabilityRecord = z.discriminatedUnion("type", [
  z.strictObject({
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    type: z.literal("live"),
  }),
  z.strictObject({
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    type: z.literal("worker"),
    workerRef: WorkerRef,
  }),
]) satisfies z.ZodType<CapabilityRecordType, unknown>;

export const CapabilityRevokedPayload = z.strictObject({
  path: z.array(z.string()),
  providedAtOffset: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<RevokeCapabilityInput, unknown>;
