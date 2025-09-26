import { createHash } from "crypto";
import { zodTextFormat as openAIBrokenZodTextFormatButWhichHasCorrectTypeScriptTypes } from "openai/helpers/zod";
import { expect, vi } from "vitest";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { z } from "zod";
import type { AppRouter } from "../backend/trpc/root.ts";
import type { AgentCoreEvent } from "../backend/agent/agent-core-schemas.ts";
import type { MCPEvent } from "../backend/agent/mcp/mcp-slice.ts";
import { type SlackSliceEvent } from "../backend/agent/slack-slice.ts";
import type { SlackWebhookPayload } from "../backend/agent/slack.types.ts";

type AgentEvent = AgentCoreEvent | MCPEvent | SlackSliceEvent;

export const baseURL = import.meta.env.VITE_PUBLIC_URL!;
export const authClient = createAuthClient({
  baseURL: `${baseURL}/api/auth`,
  plugins: [adminClient()],
});

/** fix openai's broken implementation which gets `400: expected object but got string` */
export const zodTextFormat: typeof openAIBrokenZodTextFormatButWhichHasCorrectTypeScriptTypes = (
  zodSchema,
  name,
) => {
  return {
    type: "json_schema",
    schema: z.toJSONSchema(zodSchema),
    name,
  } as ReturnType<typeof openAIBrokenZodTextFormatButWhichHasCorrectTypeScriptTypes> as never;
};
