import { expect, test } from "vitest";
import { z } from "zod";
import * as jsonSchemaToTypescript from "@mmkal/json-schema-to-typescript";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { slackAgentTools } from "./slack-agent-tools.ts";
import { toolSpecsToImplementations } from "./tool-spec-to-runtime-tool.ts";
import { defaultContextRules } from "./default-context-rules.ts";
import { generateTypes } from "./codemode.ts";
import type { AugmentedCoreReducedState } from "./agent-core-schemas.ts";
import { zodToOpenAIJSONSchema } from "./zod-to-openai-json-schema.ts";

test("zod.toJSONSchema", () => {
  const schema = z.object({
    name: z.string(),
    dict: z.record(z.string(), z.object({ foo: z.string() })).nullable(),
  });
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  });
  expect(jsonSchema).toMatchInlineSnapshot(`
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "dict": {
          "anyOf": [
            {
              "additionalProperties": {
                "properties": {
                  "foo": {
                    "type": "string",
                  },
                },
                "required": [
                  "foo",
                ],
                "type": "object",
              },
              "propertyNames": {
                "type": "string",
              },
              "type": "object",
            },
            {
              "type": "null",
            },
          ],
        },
        "name": {
          "type": "string",
        },
      },
      "required": [
        "name",
        "dict",
      ],
      "type": "object",
    }
  `);

  const typescript = jsonSchemaToTypescript.compileSync(jsonSchema as {}, "TestSchema", {
    bannerComment: "",
    additionalProperties: false,
  });
  expect(typescript).toMatchInlineSnapshot(`
    "export interface TestSchema {
    name: string
    dict: ({
    [k: string]: {
    foo: string
    }
    } | null)
    }
    "
  `);
});

test("connectMCPServer", () => {
  const toolDefs = { connectMCPServer: iterateAgentTools.connectMCPServer };
  const fakeDO = {
    ...Object.fromEntries(
      Object.entries(toolDefs).map(([key]) => [
        key,
        () => {
          throw new Error(`method ${key} not implemented in this fake DO`);
        },
      ]),
    ),
    toolDefinitions: () => toolDefs,
  };
  const runtimeTools = toolSpecsToImplementations({
    toolSpecs: defaultContextRules[0].tools!.filter(
      (t) => t.type === "agent_durable_object_tool" && t.methodName === "connectMCPServer",
    ),
    theDO: fakeDO as never,
  });
  expect(runtimeTools).toMatchInlineSnapshot(`
    [
      {
        "description": "Connect to a remote MCP (Model Context Protocol) server.
    This will make additional tools available to you.",
        "execute": [Function],
        "metadata": {
          "source": "durable-object",
          "toolSpecHash": "-ossx7x",
        },
        "name": "connectMCPServer",
        "parameters": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "mode": {
              "description": "The integration mode for the MCP server. personal means each user gets their own isntance of the MCP server and authenticates individually, company means a single MCP server is shared by everone in the company it is authenticated once for all users",
              "enum": [
                "personal",
                "company",
              ],
              "type": "string",
            },
            "onBehalfOfIterateUserId": {
              "description": "The iterate user ID to connect on behalf of.",
              "type": "string",
            },
            "requiresHeadersAuth": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "properties": {},
                  "type": "object",
                },
                {
                  "additionalProperties": false,
                  "type": "null",
                },
              ],
              "description": "Set when headers are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each header.",
            },
            "requiresQueryParamsAuth": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "properties": {},
                  "type": "object",
                },
                {
                  "additionalProperties": false,
                  "type": "null",
                },
              ],
              "description": "Set when query params are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each query parameter.",
            },
            "serverUrl": {
              "description": "The URL of the MCP server",
              "type": "string",
            },
          },
          "required": [
            "serverUrl",
            "requiresHeadersAuth",
            "requiresQueryParamsAuth",
            "onBehalfOfIterateUserId",
          ],
          "type": "object",
        },
        "statusIndicatorText": "🔌 connecting to mcp server",
        "strict": false,
        "type": "function",
        "unfiddledInputJSONSchema": [Function],
        "unfiddledOutputJSONSchema": undefined,
      },
    ]
  `);
  const { typescript } = generateTypes(runtimeTools);
  expect(typescript()).toMatchInlineSnapshot(`
    "/**
     * Connect to a remote MCP (Model Context Protocol) server.
     * This will make additional tools available to you.
     */
    declare function connectMCPServer(input: {
      /**
       * The URL of the MCP server
       */
      serverUrl: string;
      /**
       * The integration mode for the MCP server. personal means each user gets their own isntance of the MCP server and authenticates individually, company means a single MCP server is shared by everone in the company it is authenticated once for all users
       */
      mode?: ("personal" | "company");
      /**
       * Set when headers are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each header.
       */
      requiresHeadersAuth: ({
        [k: string]: {
          placeholder: string;
          description: string;
          sensitive: boolean;
        };
      } | null);
      /**
       * Set when query params are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each query parameter.
       */
      requiresQueryParamsAuth: ({
        [k: string]: {
          placeholder: string;
          description: string;
          sensitive: boolean;
        };
      } | null);
      /**
       * The iterate user ID to connect on behalf of.
       */
      onBehalfOfIterateUserId: string;
    }): Promise<unknown>"
  `);
});

test("iterate agent tools", async () => {
  const toolDefs = { ...iterateAgentTools, ...slackAgentTools };
  const fakeDO = {
    ...Object.fromEntries(
      Object.entries(toolDefs).map(([key]) => [
        key,
        () => {
          throw new Error(`method ${key} not implemented in this fake DO`);
        },
      ]),
    ),
    toolDefinitions: () => toolDefs,
  };
  const runtimeTools = toolSpecsToImplementations({
    toolSpecs: defaultContextRules[0].tools!,
    theDO: fakeDO as never,
  });

  const { typescript } = generateTypes(runtimeTools);

  expect(typescript()).toMatchInlineSnapshot(`
    "/**
     * This ends your turn without sending a message to the user. Use this when you believe the other users are now talking amongst themselves and not expecting a response from you. For example:
     * User A: @iterate can you make a linear issue?
     * @iterate (You, the agent): Yes I've done that
     * User B:L @UserA why did you do that
     * @iterate: doNothing({ reason: 'Users are talking to each other' }). This should never be called in parallel with another tool.
     */
    declare function doNothing(input: {
      /**
       * Very short reason for why you are not responding. For example 'User X and Y are talking amongst themselves' or 'the conversation has moved on to a tangent i can't help with'
       */
      reason: string;
    }): Promise<unknown>

    /**
     * Connect to a remote MCP (Model Context Protocol) server.
     * This will make additional tools available to you.
     */
    declare function connectMCPServer(input: {
      /**
       * The URL of the MCP server
       */
      serverUrl: string;
      /**
       * The integration mode for the MCP server. personal means each user gets their own isntance of the MCP server and authenticates individually, company means a single MCP server is shared by everone in the company it is authenticated once for all users
       */
      mode?: ("personal" | "company");
      /**
       * Set when headers are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each header.
       */
      requiresHeadersAuth: ({
        [k: string]: {
          placeholder: string;
          description: string;
          sensitive: boolean;
        };
      } | null);
      /**
       * Set when query params are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each query parameter.
       */
      requiresQueryParamsAuth: ({
        [k: string]: {
          placeholder: string;
          description: string;
          sensitive: boolean;
        };
      } | null);
      /**
       * The iterate user ID to connect on behalf of.
       */
      onBehalfOfIterateUserId: string;
    }): Promise<unknown>

    /**
     * Get the debug URL for this agent instance. Only use this when EXPLICITLY asked by the user.
     */
    declare function getAgentDebugURL(): Promise<unknown>

    /**
     * Set a reminder for yourself to receive at a future time or on a recurring basis. You will receive the message string verbatim. So phrase it in a way that's addressed to yourself. E.g. 'You should now ask the user if they need anything else' etc
     */
    declare function remindMyselfLater(input: {
      /**
       * The message you wish to be reminded of later. This will be shared with you verbatim in the form of a developer message later.
       */
      message: string;
      /**
       * The type of reminder scheduling: 'numberOfSecondsFromNow' for delays in seconds, 'atSpecificDateAndTime' for specific dates/times, or 'recurringCron' for repeating schedules
       */
      type: ("numberOfSecondsFromNow" | "atSpecificDateAndTime" | "recurringCron");
      /**
       * The timing specification interpreted based on type: for 'numberOfSecondsFromNow' use a positive number (e.g., '300' for 5 minutes), for 'atSpecificDateAndTime' use an ISO 8601 date-time string (e.g., '2024-12-25T10:00:00Z'), for 'recurringCron' use a cron expression (e.g., '0 9 * * 1' for every Monday at 9am)
       */
      when: string;
    }): Promise<unknown>

    /**
     * List all active reminders that have been set.
     */
    declare function listMyReminders(): Promise<unknown>

    /**
     * Cancel a previously set reminder by its ID.
     */
    declare function cancelReminder(input: {
      iterateReminderId: string;
    }): Promise<unknown>

    /**
     * After you call this tool, you will not get a turn after any user messages, unless they explicitly mention you. Use this only when someone asks you to stop/ be quiet/enough/ shut-up, or reacts with 🤫/💤/🤐 to one of your messages. Or when you are explicitly asked to use it. This will cause you to add a zipper mouth emoji reaction to the most recent user message automatically (you don't need to do this)
     */
    declare function stopRespondingUntilMentioned(input: {
      /**
       * Very short reason for why you want to disengage from this slack thread until mentioned. For example 'User X told me to shut up' or 'User Y responded with 🤫 to my message' or 'the conversation has moved on to a tangent i can't help with'
       */
      reason: string;
    }): Promise<unknown>

    /**
     * Add an emoji reaction to a Slack message
     */
    declare function addSlackReaction(input: {
      /**
       * The ts of the message to react to
       */
      messageTs: string;
      /**
       * The emoji name (without colons, e.g., 'thumbsup')
       */
      name: string;
    }): Promise<unknown>

    /**
     * Remove an emoji reaction from a Slack message
     */
    declare function removeSlackReaction(input: {
      /**
       * The ts of the message to remove reaction from
       */
      messageTs: string;
      /**
       * The emoji name (without colons, e.g., 'thumbsup')
       */
      name: string;
    }): Promise<unknown>

    /**
     * Update a message in a Slack channel. This is useful for updating the content of a message after it has been sent.
     */
    declare function updateSlackMessage(input: {
      /**
       * The timestamp of the message to update
       */
      ts: string;
      /**
       * Updated message text
       */
      text?: string;
    }): Promise<unknown>

    /**
     * Get the content of a URL, including Slack message threads
     */
    declare function getURLContent(input: {
      url: string;
      /**
       * Set to true to capture a screenshot of the webpage. Screenshots are useful for visual content, layout issues, text which is isn't matched, or when you need to see what the page looks like. Defaults to false.
       */
      includeScreenshotOfPage?: boolean;
      /**
       * Set to true to extract text content from the webpage. This includes the full text, title, and other metadata. Defaults to true.
       */
      includeTextContent?: boolean;
    }): Promise<unknown>

    /**
     * Search the web using exa (think of it like a better google)
     */
    declare function searchWeb(input: {
      /**
       * The search query string for finding relevant web content
       */
      query: string;
    }): Promise<unknown>

    /**
     * Create or edit an image using the Replicate API. Multiple input images can be provided, but inputImages is optional.
     */
    declare function generateImage(input: {
      prompt: string;
      inputImages?: string[];
      /**
       * The replicate model to use. Only set this when explicitly asked to do so. Must be in the form 'owner/name' or 'owner/name:tag'
       */
      model?: string;
      quality?: ("low" | "medium" | "high");
      background?: ("auto" | "transparent" | "opaque");
      overrideReplicateParams?: {
        [k: string]: unknown;
      };
    }): Promise<unknown>

    /**
     * Generate a video using OpenAI's SORA 2 model. The video generation is asynchronous and may take several minutes to complete.
     */
    declare function generateVideo(input: {
      /**
       * Text prompt that describes the video to generate
       */
      prompt: string;
      /**
       * Optional image or video file id that guides generation. Must match the generated video size
       */
      inputReferenceFileId?: string;
      /**
       * The video generation model to use. Defaults to sora-2
       */
      model?: ("sora-2" | "sora-2-pro");
      /**
       * Clip duration in seconds
       */
      seconds?: ("4" | "8" | "12");
      /**
       * Output resolution formatted as width x height
       */
      size?: ("720x1280" | "1280x720" | "1024x1792" | "1792x1024");
    }): Promise<unknown>

    /**
     * Send a slack message to the thread you are currently active in.
     */
    declare function sendSlackMessage(input: {
      /**
       * The message text (required if blocks not provided)
       */
      text: string;
      /**
       * Whether to send as ephemeral message (visible only to specific user). Requires 'user' field when true.
       */
      ephemeral?: boolean;
      /**
       * Slack user ID to send ephemeral message to (required when ephemeral=true)
       */
      user?: string;
      /**
       * Array of slack block objects
       */
      blocks?: {
        [k: string]: unknown;
      }[];
      /**
       * Optional. Set this to true only if you want to yield to the user and end your turn. For example because you've asked them for input on something or if you think you're done and there's nothing left for you to do.
       */
      endTurn?: boolean;
    }): Promise<unknown>"
  `);
});

test("generateTypes", async () => {
  const { typescript } = generateTypes(getSampleTools());
  expect(typescript()).toMatchInlineSnapshot(`
    "/**
     * Add two numbers
     */
    declare function add(input: {
      left: number;
      right: number;
    }): Promise<unknown>

    /**
     * Subtract two numbers
     */
    declare function subtract(input: [number, number]): Promise<unknown>"
  `);
});

function getSampleTools(): AugmentedCoreReducedState["runtimeTools"] {
  return [
    {
      name: "add",
      description: "Add two numbers",
      parameters: zodToOpenAIJSONSchema(
        z.object({
          left: z.number(),
          right: z.number(),
        }),
      ),
      type: "function",
      execute: async (input) => {
        const { left, right } = JSON.parse(input.arguments);
        return left + right;
      },
      strict: false,
    },
    {
      name: "subtract",
      description: "Subtract two numbers",
      parameters: z.toJSONSchema(z.tuple([z.number(), z.number()])),
      type: "function",
      execute: (async (input: { arguments: string }) => {
        const [left, right] = JSON.parse(input.arguments);
        return left - right;
      }) as never,
      strict: false,
    },
  ];
}
