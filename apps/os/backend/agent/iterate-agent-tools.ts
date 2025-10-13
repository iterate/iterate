import dedent from "dedent";
import z from "zod";
import { defineDOTools } from "./do-tools.ts";
import { IntegrationMode, MCPParam } from "./tool-schemas.ts";

export type IterateAgentToolInterface = typeof iterateAgentTools.$infer.interface;
export type IterateAgentToolInputs = typeof iterateAgentTools.$infer.inputTypes;
export const iterateAgentTools = defineDOTools({
  ping: {
    description: "Simple ping method that returns a pong response",
    statusIndicatorText: "🏓 pinging",
  },
  flexibleTestTool: {
    description:
      "Flexible testing tool that can simulate slow responses, errors, or return secrets based on behaviour",
    input: z.object({
      params: z.discriminatedUnion("behaviour", [
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
    }),
  },
  reverse: {
    description: "Reverse a string",
    input: z.object({ message: z.string() }),
  },
  doNothing: {
    description:
      "This ends your turn without sending a message to the user. Use this when you believe the other users are now talking amongst themselves and not expecting a response from you. For example: \nUser A: @iterate can you make a linear issue?\n @iterate (You, the agent): Yes I've done that\n User B:L @UserA why did you do that \n @iterate: doNothing({ reason: 'Users are talking to each other' }). This should never be called in parallel with another tool.",
    statusIndicatorText: "🙈 ignoring you",
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
    statusIndicatorText: "🔗 getting debug url",
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
    statusIndicatorText: "⏰ setting reminder",
  },
  listMyReminders: {
    description: "List all active reminders that have been set.",
    statusIndicatorText: "📋 listing reminders",
    input: z.object({}),
  },
  cancelReminder: {
    description: "Cancel a previously set reminder by its ID.",
    statusIndicatorText: "🚫 canceling reminder",
    input: z.object({ iterateReminderId: z.string() }),
  },
  connectMCPServer: {
    description: dedent`
      Connect to a remote MCP (Model Context Protocol) server.
      This will make additional tools available to you.
    `,
    statusIndicatorText: "🔌 connecting to mcp server",
    input: z.object({
      serverUrl: z.string().describe("The URL of the MCP server"),
      mode: IntegrationMode.default("personal").describe(
        "The integration mode for the MCP server. personal means each user gets their own isntance of the MCP server and authenticates individually, company means a single MCP server is shared by everone in the company it is authenticated once for all users",
      ),
      requiresHeadersAuth: z
        .record(
          z.string(),
          MCPParam.pick({ placeholder: true, description: true, sensitive: true }),
        )
        .nullable()
        .describe(
          "Set when headers are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each header.",
        ),
      requiresQueryParamsAuth: z
        .record(
          z.string(),
          MCPParam.pick({ placeholder: true, description: true, sensitive: true }),
        )
        .nullable()
        .describe(
          "Set when query params are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each query parameter.",
        ),
      onBehalfOfIterateUserId: z.string().describe("The iterate user ID to connect on behalf of."),
    }),
  },
  getURLContent: {
    description: "Get the content of a URL, including Slack message threads",
    statusIndicatorText: "🌐 visiting url",
    input: z.object({
      url: z.string(),
      includeScreenshotOfPage: z
        .boolean()
        .default(false)
        .describe(
          "Set to true to capture a screenshot of the webpage. Screenshots are useful for visual content, layout issues, text which is isn't matched, or when you need to see what the page looks like. Defaults to false.",
        )
        .optional(),
      includeTextContent: z
        .boolean()
        .default(true)
        .describe(
          "Set to true to extract text content from the webpage. This includes the full text, title, and other metadata. Defaults to true.",
        )
        .optional(),
    }),
  },
  searchWeb: {
    description: "Search the web using exa (think of it like a better google)",
    statusIndicatorText: "🔍 searching the web",
    input: z.object({
      query: z.string(),
      numResults: z.number().optional().default(10),
    }),
  },
  generateImage: {
    description:
      "Create or edit an image using the Replicate API. Multiple input images can be provided, but inputImages is optional.",
    statusIndicatorText: "🎨 generating image",
    input: z.object({
      prompt: z.string(),
      inputImages: z.array(z.string()).default([]),
      model: z
        .custom<`${string}/${string}` | `${string}/${string}:${string}`>((val) => {
          return typeof val === "string" && /^(?:[^/\s]+)\/(?:[^:/\s]+)(?::[^\s]+)?$/.test(val);
        }, "Model must be in the form 'owner/name' or 'owner/name:tag'")
        .default("openai/gpt-image-1")
        .describe(
          "The replicate model to use. Only set this when explicitly asked to do so. Must be in the form 'owner/name' or 'owner/name:tag'",
        ),
      quality: z.enum(["low", "medium", "high"]).default("high"),
      background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
      overrideReplicateParams: z.record(z.string(), z.any()).optional(),
    }),
  },
  exec: {
    description: "Execute a shell in a sandbox.",
    statusIndicatorText: "⚙️ running command",
    input: z.object({
      command: z.string(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  },
  generateVideo: {
    description:
      "Generate a video using OpenAI's SORA 2 model. The video generation is asynchronous and may take several minutes to complete.",
    statusIndicatorText: "🎬 generating video",
    input: z.object({
      prompt: z.string().describe("Text prompt that describes the video to generate"),
      inputReferenceFileId: z
        .string()
        .optional()
        .describe(
          "Optional image or video file id that guides generation. Must match the generated video size",
        ),
      model: z
        .enum(["sora-2", "sora-2-pro"])
        .default("sora-2")
        .describe("The video generation model to use. Defaults to sora-2"),
      seconds: z.enum(["4", "8", "12"]).default("4").describe("Clip duration in seconds"),
      size: z
        .enum(["720x1280", "1280x720", "1024x1792", "1792x1024"])
        .default("720x1280")
        .describe("Output resolution formatted as width x height"),
    }),
  },
  callGoogleAPI: {
    description: "Call a Google API endpoint with automatic authentication and token refresh",
    statusIndicatorText: "📞 calling google api",
    input: z.object({
      endpoint: z
        .string()
        .describe(
          "The API endpoint path (e.g., '/gmail/v1/users/me/messages/send' or '/calendar/v3/calendars/primary/events')",
        ),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("The HTTP method to use"),
      body: z.any().optional().describe("The request body (will be JSON stringified)"),
      queryParams: z
        .record(z.string(), z.string())
        .optional()
        .describe("Query parameters to append to the URL"),
      pathParams: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Path parameters to insert into the URL. Path parameters are placeholders in the endpoint path represented as [param] that are replaced with the values in this object.",
        ),
      userId: z.string().describe("The user ID to use for authentication"),
    }),
  },
  sendGmail: {
    description:
      "Send an email via Gmail. Can also reply to emails by providing threadId and inReplyTo.",
    statusIndicatorText: "📧 sending email",
    input: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC email addresses (comma-separated)"),
      bcc: z.string().optional().describe("BCC email addresses (comma-separated)"),
      threadId: z.string().optional().describe("Thread ID to reply to (from getGmailMessage)"),
      inReplyTo: z
        .string()
        .optional()
        .describe("Message ID to reply to (from getGmailMessage headers)"),
      userId: z.string().describe("The user ID to use for authentication"),
    }),
  },
  // requires unapproved scope: gmail.modify
  getGmailMessage: {
    description:
      "Get the full content of a specific Gmail message by ID. Returns the email with decoded text body.",
    statusIndicatorText: "📬 fetching email",
    input: z.object({
      messageId: z.string().describe("The ID of the message to retrieve"),
      userId: z.string().describe("The user ID to use for authentication"),
    }),
  },
});
