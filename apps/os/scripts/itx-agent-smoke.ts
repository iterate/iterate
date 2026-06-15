import process from "node:process";

import { os } from "@orpc/server";
import { z } from "zod";

import { withItx } from "../src/itx/client.ts";

const ASSISTANT_RESPONSE_TYPE = "events.iterate.com/agents/web-message-sent";
const USER_MESSAGE_TYPE = "events.iterate.com/agents/user-message-received";

const ItxAgentSmokeInput = z.object({
  agentPath: z
    .string()
    .trim()
    .refine((value) => value.startsWith("/agents/"), {
      message: "Agent path must start with /agents/.",
    })
    .describe("Agent stream path, e.g. /agents/smoke."),
  baseUrl: z.string().optional().describe("OS base URL. Defaults to APP_CONFIG_BASE_URL."),
  project: z.string().trim().min(1).describe("Project id or slug to connect into over ITX."),
  message: z.string().trim().min(1).describe("Single user message to send to the agent."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(180_000)
    .describe("Maximum time to wait for an assistant response."),
});

export const itxAgentSmokeScript = os
  .meta({
    description: "Send one user message to an agent over ITX and wait for the assistant response.",
  })
  .input(ItxAgentSmokeInput)
  .handler(async ({ input }) => {
    const baseUrl = input.baseUrl ?? process.env.APP_CONFIG_BASE_URL?.trim();
    if (!baseUrl) throw new Error("No base URL: pass --base-url or set APP_CONFIG_BASE_URL.");
    const token =
      process.env.OS_ADMIN_API_SECRET?.trim() ||
      process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
      "";
    if (!token) {
      throw new Error("APP_CONFIG_ADMIN_API_SECRET (or OS_ADMIN_API_SECRET) is required.");
    }

    const startedAt = Date.now();
    using itx = withItx({ baseUrl, context: input.project, token });

    const stream = await itx.streams.get(input.agentPath);
    const userEvent = await stream.append({
      event: {
        type: USER_MESSAGE_TYPE,
        payload: {
          content: input.message,
          origin: "web",
        },
      },
    });

    const responseEvent = await stream.waitForEvent({
      afterOffset: userEvent.offset,
      timeoutMs: input.timeoutMs,
      predicate: (event) => {
        if (event.type.endsWith("error-occurred")) {
          throw new Error(`Agent stream reported an error: ${JSON.stringify(event)}`);
        }
        return event.type === ASSISTANT_RESPONSE_TYPE;
      },
    });
    const assistantMessage = (responseEvent.payload as { message?: unknown }).message;

    process.stdout.write(
      `${JSON.stringify(
        {
          agentPath: input.agentPath,
          assistantMessage: typeof assistantMessage === "string" ? assistantMessage : null,
          elapsedMs: Date.now() - startedAt,
          project: input.project,
          responseEvent,
          userEvent,
        },
        null,
        2,
      )}\n`,
    );

    // The Cap'n Web WebSocket would otherwise keep the process alive.
    process.exit(0);
  });
