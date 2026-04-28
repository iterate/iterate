/**
 * Core types for the codemode system.
 *
 * - ToolProvider: resolved interface (local or remote, same shape)
 * - CallableToolProvider: serializable wire format (Callable-based)
 * - CodemodeEvent: discriminated union of all streaming execution events
 */

import { z } from "zod";
import { Callable } from "../callable/types.ts";

// ── ToolProvider (resolved interface) ────────────────────────────────

export interface ToolProviderDescription {
  typeDefinitions: string;
}

export interface ToolProvider {
  execute(path: string[], payload: unknown): Promise<unknown>;
  describe(): Promise<ToolProviderDescription>;
}

// ── CallableToolProvider (wire format) ───────────────────────────────

export const CallableToolProvider = z.object({
  path: z.array(z.string().min(1)).min(1),
  execute: Callable,
  describe: Callable.optional(),
});

export type CallableToolProvider = z.infer<typeof CallableToolProvider>;

// ── CodemodeEvent (streaming execution events) ───────────────────────

const BaseEvent = z.object({
  blockId: z.string(),
  timestamp: z.string(),
});

export const CodemodeToolProviderRegistered = BaseEvent.extend({
  type: z.literal("codemode-tool-provider-registered"),
  path: z.array(z.string()),
});

export const CodemodeToolProviderDescribed = BaseEvent.extend({
  type: z.literal("codemode-tool-provider-described"),
  path: z.array(z.string()),
  typeDefinitions: z.string(),
});

export const CodemodeBlockAdded = BaseEvent.extend({
  type: z.literal("codemode-block-added"),
  code: z.string(),
});

export const CodemodeLogEmitted = BaseEvent.extend({
  type: z.literal("codemode-log-emitted"),
  level: z.enum(["log", "warn", "error"]),
  message: z.string(),
});

export const CodemodeToolCallRequested = BaseEvent.extend({
  type: z.literal("codemode-tool-call-requested"),
  callId: z.string(),
  path: z.array(z.string()),
  payload: z.unknown(),
});

export const CodemodeToolCallSucceeded = BaseEvent.extend({
  type: z.literal("codemode-tool-call-succeeded"),
  callId: z.string(),
  result: z.unknown(),
});

export const CodemodeToolCallFailed = BaseEvent.extend({
  type: z.literal("codemode-tool-call-failed"),
  callId: z.string(),
  error: z.string(),
});

export const CodemodeBlockResultAdded = BaseEvent.extend({
  type: z.literal("codemode-block-result-added"),
  result: z.unknown(),
  error: z.string().optional(),
});

export const CodemodeEvent = z.discriminatedUnion("type", [
  CodemodeToolProviderRegistered,
  CodemodeToolProviderDescribed,
  CodemodeBlockAdded,
  CodemodeLogEmitted,
  CodemodeToolCallRequested,
  CodemodeToolCallSucceeded,
  CodemodeToolCallFailed,
  CodemodeBlockResultAdded,
]);

export type CodemodeEvent = z.infer<typeof CodemodeEvent>;
