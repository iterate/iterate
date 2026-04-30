/**
 * Core types for the codemode system.
 *
 * - ToolProvider: resolved interface (local or remote, same shape)
 * - ToolProviderDescriptor: serializable wire format with one Callable
 * - CodemodeEvent: discriminated union of all streaming execution events
 */

import { z } from "zod";
import { Callable } from "../callable/types.ts";

// ── ToolProvider (resolved interface) ────────────────────────────────

export interface ToolProvider {
  executeToolFunction(path: string[], payload: unknown): Promise<unknown>;
  describeToolFunctions(): Promise<{ typeDefinitions: string }>;
}

export const DESCRIBE_TOOL_FUNCTION_NAME = "__describe";

// ── ToolProviderDescriptor (wire format) ───────────────────────────────

export const ToolProviderDescriptor = z
  .object({
    path: z.array(z.string().min(1)).min(1),
    callable: Callable,
  })
  .strict();

export type ToolProviderDescriptor = z.infer<typeof ToolProviderDescriptor>;

// ── CodemodeEvent (streaming execution events) ───────────────────────

const BaseEvent = z.object({
  blockId: z.string(),
  timestamp: z.string(),
});

const CodemodeToolProviderRegistered = BaseEvent.extend({
  type: z.literal("codemode-tool-provider-registered"),
  path: z.array(z.string()),
});

const CodemodeToolProviderDescribed = BaseEvent.extend({
  type: z.literal("codemode-tool-provider-described"),
  path: z.array(z.string()),
  typeDefinitions: z.string(),
});

const CodemodeBlockAdded = BaseEvent.extend({
  type: z.literal("codemode-block-added"),
  code: z.string(),
});

const CodemodeLogEmitted = BaseEvent.extend({
  type: z.literal("codemode-log-emitted"),
  level: z.enum(["log", "warn", "error"]),
  message: z.string(),
});

const CodemodeToolFunctionCallRequested = BaseEvent.extend({
  type: z.literal("codemode-tool-function-call-requested"),
  callId: z.string(),
  path: z.array(z.string()),
  payload: z.unknown(),
});

const CodemodeToolFunctionCallSucceeded = BaseEvent.extend({
  type: z.literal("codemode-tool-function-call-succeeded"),
  callId: z.string(),
  result: z.unknown(),
});

const CodemodeToolFunctionCallFailed = BaseEvent.extend({
  type: z.literal("codemode-tool-function-call-failed"),
  callId: z.string(),
  error: z.string(),
});

const CodemodeBlockResultAdded = BaseEvent.extend({
  type: z.literal("codemode-block-result-added"),
  result: z.unknown(),
  error: z.string().optional(),
});

export const CodemodeEvent = z.discriminatedUnion("type", [
  CodemodeToolProviderRegistered,
  CodemodeToolProviderDescribed,
  CodemodeBlockAdded,
  CodemodeLogEmitted,
  CodemodeToolFunctionCallRequested,
  CodemodeToolFunctionCallSucceeded,
  CodemodeToolFunctionCallFailed,
  CodemodeBlockResultAdded,
]);

export type CodemodeEvent = z.infer<typeof CodemodeEvent>;
