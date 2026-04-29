/**
 * Codemode event payload sketch.
 *
 * Event type strings intentionally use no https:// prefix.
 */

import { z } from "zod";

const ProviderPath = z.array(z.string().min(1)).min(1);

export const CodemodeEventType = {
  toolProviderRegistered: "events.iterate.com/codemode/tool-provider-registered",
  toolProviderDescribed: "events.iterate.com/codemode/tool-provider-described",
  scriptExecutionRequested: "events.iterate.com/codemode/script-execution-requested",
  scriptExecutionSucceeded: "events.iterate.com/codemode/script-execution-succeeded",
  scriptExecutionFailed: "events.iterate.com/codemode/script-execution-failed",
  toolFunctionCallRequested: "events.iterate.com/codemode/tool-function-call-requested",
  toolFunctionCallSucceeded: "events.iterate.com/codemode/tool-function-call-succeeded",
  toolFunctionCallFailed: "events.iterate.com/codemode/tool-function-call-failed",
  logEmitted: "events.iterate.com/codemode/log-emitted",
} as const;

export const ToolProviderRegisteredPayload = z.object({
  path: ProviderPath,
  descriptor: z.unknown(),
});

export const ToolProviderDescribedPayload = z.object({
  path: ProviderPath,
  toolProviderRegisteredOffset: z.number().int().positive().optional(),
  typeDefinitions: z.string(),
});

export const ScriptExecutionRequestedPayload = z.object({
  code: z.string().min(1),
});

export const ScriptExecutionSucceededPayload = z.object({
  scriptExecutionRequestedOffset: z.number().int().positive(),
  result: z.unknown(),
});

export const ScriptExecutionFailedPayload = z.object({
  scriptExecutionRequestedOffset: z.number().int().positive(),
  error: z.string(),
});

export const ToolFunctionCallRequestedPayload = z.object({
  path: ProviderPath,
  payload: z.unknown(),
  scriptExecutionRequestedOffset: z.number().int().positive().optional(),
});

export const ToolFunctionCallSucceededPayload = z.object({
  toolFunctionCallRequestedOffset: z.number().int().positive(),
  path: ProviderPath,
  result: z.unknown(),
  scriptExecutionRequestedOffset: z.number().int().positive().optional(),
});

export const ToolFunctionCallFailedPayload = z.object({
  toolFunctionCallRequestedOffset: z.number().int().positive(),
  path: ProviderPath,
  error: z.string(),
  scriptExecutionRequestedOffset: z.number().int().positive().optional(),
});

export const LogEmittedPayload = z.object({
  message: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  scriptExecutionRequestedOffset: z.number().int().positive().optional(),
  toolFunctionCallRequestedOffset: z.number().int().positive().optional(),
});

/**
 * Open question: should tool-provider-described be durable stream history?
 *
 * Arguments for appending it:
 * - editor/type loading becomes observable
 * - future replay can recover type info without calling providers again
 *
 * Arguments against appending it:
 * - descriptions may be large and frequently regenerated
 * - descriptions may depend on provider availability at editor-open time
 */
export const maybeAppendToolProviderDescribed = true;
