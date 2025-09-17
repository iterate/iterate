import dedent from "dedent";
import z from "zod";
import { defineDOTools } from "./do-tools.ts";

export type IterateAgentToolInterface = typeof iterateAgentTools.$infer.interface;
export type IterateAgentToolInputs = typeof iterateAgentTools.$infer.inputTypes;
export const iterateAgentTools = defineDOTools({
  ping: {
    description: "Simple ping method that returns a pong response",
  },
  flexibleTestTool: {
    description:
      "Flexible testing tool that can simulate slow responses, errors, or return secrets based on behaviour",
    input: z.discriminatedUnion("behaviour", [
      z.object({
        behaviour: z.literal("slow-tool"),
        recordStartTime: z
          .boolean()
          .default(false)
          .describe("Whether to record the start time of the tool call"),
        delay: z.number().describe("Delay in milliseconds before responding"),
        response: z.string().describe("Response message to return after delay"),
      }),
      z.object({
        behaviour: z.literal("raise-error"),
        error: z.string().describe("Error message to throw"),
      }),
      z.object({
        behaviour: z.literal("return-secret"),
        secret: z.string().describe("Secret value to return"),
      }),
    ]),
  },
  reverse: {
    description: "Reverse a string",
    input: z.object({ message: z.string() }),
  },
  doNothing: {
    description:
      "This ends your turn without sending a message to the user. Use this when you believe the other users are now talking amongst themselves and not expecting a response from you. For example: \nUser A: @iterate can you make a linear issue?\n @iterate (You, the agent): Yes I've done that\n User B:L @UserA why did you do that \n @iterate: doNothing({ reason: 'Users are talking to each other' }). This should never be called in parallel with another tool.",
    input: z.object({
      reason: z
        .string()
        .describe(
          "Very short reason for why you are not responding. For example 'User X and Y are talking amongst themselves' or 'the conversation has moved on to a tangent i can't help with'",
        ),
    }),
  },
  getAgentDebugURL: {
    description:
      "Get the debug URL for this agent instance. Only use this when EXPLICITLY asked by the user.",
  },
  remindMyselfLater: {
    input: z.object({
      message: z
        .string()
        .describe(
          "The message you wish to be reminded of later. This will be shared with you verbatim in the form of a developer message later.",
        ),
      type: z
        .enum(["numberOfSecondsFromNow", "atSpecificDateAndTime", "recurringCron"])
        .describe(
          "The type of reminder scheduling: 'numberOfSecondsFromNow' for delays in seconds, 'atSpecificDateAndTime' for specific dates/times, or 'recurringCron' for repeating schedules",
        ),
      when: z
        .string()
        .describe(
          "The timing specification interpreted based on type: for 'numberOfSecondsFromNow' use a positive number (e.g., '300' for 5 minutes), for 'atSpecificDateAndTime' use an ISO 8601 date-time string (e.g., '2024-12-25T10:00:00Z'), for 'recurringCron' use a cron expression (e.g., '0 9 * * 1' for every Monday at 9am)",
        ),
    }),
    description:
      "Set a reminder for yourself to receive at a future time or on a recurring basis. You will receive the message string verbatim. So phrase it in a way that's addressed to yourself. E.g. 'You should now ask the user if they need anything else' etc",
  },
  listMyReminders: {
    description: "List all active reminders that have been set.",
    input: z.object({}),
  },
  cancelReminder: {
    description: "Cancel a previously set reminder by its ID.",
    input: z.object({ iterateReminderId: z.string() }),
  },
  // connectMCPServer: {
  //   description: dedent`
  //     Connect to a remote MCP (Model Context Protocol) server.
  //     This will make additional tools available to you.
  //   `,
  //   input: z.object({
  //     serverUrl: z.string().describe("The URL of the MCP server"),
  //     mode: IntegrationMode.default("personal").describe(
  //       "The integration mode for the MCP server. personal means each user gets their own isntance of the MCP server and authenticates individually, company means a single MCP server is shared by everone in the company it is authenticated once for all users",
  //     ),
  //     requiresOAuth: z
  //       .boolean()
  //       .nullable()
  //       .describe(
  //         "Whether this MCP server requires OAuth authentication (use for OAuth servers that require authentication)",
  //       ),
  //     requiresHeadersAuth: z
  //       .record(z.string(), z.string())
  //       .nullable()
  //       .describe(
  //         "Set when headers are required to authenticate (use for non-OAuth servers that require authentication). Use curly braces to present the user with a form to fill in the value, example: { 'Authorization': 'Bearer {apiKey}' }",
  //       ),
  //     requiresQueryParamsAuth: z
  //       .record(z.string(), z.string())
  //       .nullable()
  //       .describe(
  //         "Set when query params are required to authenticate (use for non-OAuth servers that require authentication). Use curly braces to present the user with a form to fill in the value, example: { 'apiKey': '{apiKey}', 'accountId': '123' }",
  //       ),
  //     onBehalfOfIterateUserId: z.string().describe("The iterate user ID to connect on behalf of."),
  //   }),
  // },
});
