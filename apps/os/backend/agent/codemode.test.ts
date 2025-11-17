import { expect, test } from "vitest";
import { z } from "zod";
import * as jsonSchemaToTypescript from "@mmkal/json-schema-to-typescript";
import * as quicktype from "quicktype-core";
import dedent from "dedent";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { slackAgentTools } from "./slack-agent-tools.ts";
import { toolSpecsToImplementations } from "./tool-spec-to-runtime-tool.ts";
import { defaultContextRules } from "./default-context-rules.ts";
import { generateTypes, prettyPrint } from "./codemode.ts";
import type { AugmentedCoreReducedState } from "./agent-core-schemas.ts";
import { zodToOpenAIJSONSchema } from "./zod-to-openai-json-schema.ts";

test("quicktype sync", () => {
  const jsonInput = quicktype.jsonInputForTargetLanguage("typescript");
  jsonInput.addSourceSync({
    name: "Queries",
    samples: [
      JSON.stringify({ foo: "bar", x: { y: 1 } }), //
      JSON.stringify({ foo: "baz", x: { y: 2 } }), //
      JSON.stringify({ foo: "baz", x: { y: 3 } }), //
      JSON.stringify({ foo: "baz", x: { y: 4, z: null } }), //
    ],
  });

  const inputData = new quicktype.InputData();
  inputData.addInput(jsonInput);
  const x = quicktype.quicktypeMultiFileSync({
    inputData,
    lang: "typescript",
    rendererOptions: {
      "just-types": true,
      "prefer-unions": true,
      "array-type": "array",
      "include-location": true,
      sendable: true,
      "prefer-types": true,
      "extra-comments": true,
      "copy-with": "JSON.parse",
      "any-type": "dynamic",
      "null-safety": false,
    },
  });

  const result = x.get("stdout")?.lines.join("\n");
  expect(result).toMatchInlineSnapshot(`
    "export type Queries = {
        foo: string;
        x:   X;
    }

    export type X = {
        y:  number;
        z?: null;
    }
    "
  `);
});

test("prettyPrint", () => {
  expect(
    prettyPrint(dedent`
      declare module Foo {
        /**
               * hello
               * goodbye
         */
        type Input = {
          foo: string;
        }
        /**
      * wow
             * this indentation is horrible
                 */   
        type Output = {
          bar: string;
        }
      }
      declare function foo(input: Foo.Input): Promise<Foo.Output>
    `),
  ).toMatchInlineSnapshot(`
    "declare module Foo {
      /**
       * hello
       * goodbye
       */
      type Input = {
        foo: string;
      };

      /**
       * wow
       * this indentation is horrible
       */
      type Output = {
        bar: string;
      };
    }

    declare function foo(input: Foo.Input): Promise<Foo.Output>"
  `);
});

test("quicktype string", () => {
  const jsonInput = quicktype.jsonInputForTargetLanguage("typescript");
  jsonInput.addSourceSync({
    name: "Queries",
    samples: [
      JSON.stringify("hi"), //
      JSON.stringify("there"), //
      JSON.stringify("how"), //
      JSON.stringify("are"), //
      JSON.stringify("you"), //
      JSON.stringify("doing"), //
    ],
  });

  const inputData = new quicktype.InputData();
  inputData.addInput(jsonInput);
  const x = quicktype.quicktypeMultiFileSync({
    inputData,
    lang: "typescript",
    rendererOptions: {
      "just-types": true,
      "prefer-unions": true,
    },
  });

  const result = x.get("stdout")?.lines.join("\n");
  expect(result).toMatchInlineSnapshot(`
    "type Queries = string;
    "
  `);
});

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
    "/** Namespace containing the input type for the connectMCPServer tool. */
    declare namespace connectMCPServer {
      export interface Input {
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
      }
    }

    /**
     * Connect to a remote MCP (Model Context Protocol) server.
     * This will make additional tools available to you.
     */
    declare function connectMCPServer(input: connectMCPServer.Input): Promise<unknown>"
  `);
});

test("tool with sample output", () => {
  const toolDefs = {
    listMyReminders: iterateAgentTools.listMyReminders,
    remindMyselfLater: iterateAgentTools.remindMyselfLater,
  };
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
      (t) => t.type === "agent_durable_object_tool" && t.methodName in toolDefs,
    ),
    theDO: fakeDO as never,
  });
  const { typescript } = generateTypes(runtimeTools as never, {
    outputSamples: {
      listMyReminders: [
        {
          reminders: [
            { id: 1, time: new Date("2025-01-01").toISOString(), message: "foo", when: "300s" },
          ],
        },
        { reminders: [] },
      ],
      remindMyselfLater: [{ reminderId: 1 }],
    },
  });
  expect(typescript()).toMatchInlineSnapshot(`
    "/** Namespace containing the input and output types for the remindMyselfLater tool. */
    declare namespace remindMyselfLater {
      export interface Input {
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
      }

      export interface Output {
        reminderId: number;
      }
    }

    /**
     * Set a reminder for yourself to receive at a future time or on a recurring basis. You will receive the message string verbatim. So phrase it in a way that's addressed to yourself. E.g. 'You should now ask the user if they need anything else' etc
     */
    declare function remindMyselfLater(input: remindMyselfLater.Input): Promise<remindMyselfLater.Output>

    /** Namespace containing the output type for the listMyReminders tool. */
    declare namespace listMyReminders {
      export interface Output {
        reminders: Reminder[];
      }

      export interface Reminder {
        id: number;
        time: Date;
        message: string;
        when: string;
      }
    }

    /**
     * List all active reminders that have been set.
     */
    declare function listMyReminders(input: {}): Promise<listMyReminders.Output>"
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
    "/** Namespace containing the input type for the doNothing tool. */
    declare namespace doNothing {
      export interface Input {
        /**
         * Very short reason for why you are not responding. For example 'User X and Y are talking amongst themselves' or 'the conversation has moved on to a tangent i can't help with'
         */
        reason: string;
      }
    }

    /**
     * This ends your turn without sending a message to the user. Use this when you believe the other users are now talking amongst themselves and not expecting a response from you. For example:
     * User A: @iterate can you make a linear issue?
     * @iterate (You, the agent): Yes I've done that
     * User B:L @UserA why did you do that
     * @iterate: doNothing({ reason: 'Users are talking to each other' }). This should never be called in parallel with another tool.
     */
    declare function doNothing(input: doNothing.Input): Promise<unknown>

    /** Namespace containing the input type for the connectMCPServer tool. */
    declare namespace connectMCPServer {
      export interface Input {
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
      }
    }

    /**
     * Connect to a remote MCP (Model Context Protocol) server.
     * This will make additional tools available to you.
     */
    declare function connectMCPServer(input: connectMCPServer.Input): Promise<unknown>

    /**
     * Get the debug URL for this agent instance. Only use this when EXPLICITLY asked by the user.
     */
    declare function getAgentDebugURL(input: {}): Promise<unknown>

    /** Namespace containing the input type for the remindMyselfLater tool. */
    declare namespace remindMyselfLater {
      export interface Input {
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
      }
    }

    /**
     * Set a reminder for yourself to receive at a future time or on a recurring basis. You will receive the message string verbatim. So phrase it in a way that's addressed to yourself. E.g. 'You should now ask the user if they need anything else' etc
     */
    declare function remindMyselfLater(input: remindMyselfLater.Input): Promise<unknown>

    /**
     * List all active reminders that have been set.
     */
    declare function listMyReminders(input: {}): Promise<unknown>

    /** Namespace containing the input type for the cancelReminder tool. */
    declare namespace cancelReminder {
      export interface Input {
        iterateReminderId: string;
      }
    }

    /**
     * Cancel a previously set reminder by its ID.
     */
    declare function cancelReminder(input: cancelReminder.Input): Promise<unknown>

    /** Namespace containing the input type for the stopRespondingUntilMentioned tool. */
    declare namespace stopRespondingUntilMentioned {
      export interface Input {
        /**
         * Very short reason for why you want to disengage from this slack thread until mentioned. For example 'User X told me to shut up' or 'User Y responded with 🤫 to my message' or 'the conversation has moved on to a tangent i can't help with'
         */
        reason: string;
      }
    }

    /**
     * After you call this tool, you will not get a turn after any user messages, unless they explicitly mention you. Use this only when someone asks you to stop/ be quiet/enough/ shut-up, or reacts with 🤫/💤/🤐 to one of your messages. Or when you are explicitly asked to use it. This will cause you to add a zipper mouth emoji reaction to the most recent user message automatically (you don't need to do this)
     */
    declare function stopRespondingUntilMentioned(input: stopRespondingUntilMentioned.Input): Promise<unknown>

    /** Namespace containing the input type for the addSlackReaction tool. */
    declare namespace addSlackReaction {
      export interface Input {
        /**
         * The ts of the message to react to
         */
        messageTs: string;
        /**
         * The emoji name (without colons, e.g., 'thumbsup')
         */
        name: string;
      }
    }

    /**
     * Add an emoji reaction to a Slack message
     */
    declare function addSlackReaction(input: addSlackReaction.Input): Promise<unknown>

    /** Namespace containing the input type for the removeSlackReaction tool. */
    declare namespace removeSlackReaction {
      export interface Input {
        /**
         * The ts of the message to remove reaction from
         */
        messageTs: string;
        /**
         * The emoji name (without colons, e.g., 'thumbsup')
         */
        name: string;
      }
    }

    /**
     * Remove an emoji reaction from a Slack message
     */
    declare function removeSlackReaction(input: removeSlackReaction.Input): Promise<unknown>

    /** Namespace containing the input type for the updateSlackMessage tool. */
    declare namespace updateSlackMessage {
      export interface Input {
        /**
         * The timestamp of the message to update
         */
        ts: string;
        /**
         * Updated message text
         */
        text?: string;
      }
    }

    /**
     * Update a message in a Slack channel. This is useful for updating the content of a message after it has been sent.
     */
    declare function updateSlackMessage(input: updateSlackMessage.Input): Promise<unknown>

    /** Namespace containing the input type for the getURLContent tool. */
    declare namespace getURLContent {
      export interface Input {
        url: string;
        /**
         * Set to true to capture a screenshot of the webpage. Screenshots are useful for visual content, layout issues, text which is isn't matched, or when you need to see what the page looks like. Defaults to false.
         */
        includeScreenshotOfPage?: boolean;
        /**
         * Set to true to extract text content from the webpage. This includes the full text, title, and other metadata. Defaults to true.
         */
        includeTextContent?: boolean;
      }
    }

    /**
     * Get the content of a URL, including Slack message threads
     */
    declare function getURLContent(input: getURLContent.Input): Promise<unknown>

    /** Namespace containing the input type for the searchWeb tool. */
    declare namespace searchWeb {
      export interface Input {
        /**
         * The search query string for finding relevant web content
         */
        query: string;
      }
    }

    /**
     * Search the web using exa (think of it like a better google)
     */
    declare function searchWeb(input: searchWeb.Input): Promise<unknown>

    /** Namespace containing the input type for the generateImage tool. */
    declare namespace generateImage {
      export interface Input {
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
      }
    }

    /**
     * Create or edit an image using the Replicate API. Multiple input images can be provided, but inputImages is optional.
     */
    declare function generateImage(input: generateImage.Input): Promise<unknown>

    /** Namespace containing the input type for the generateVideo tool. */
    declare namespace generateVideo {
      export interface Input {
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
      }
    }

    /**
     * Generate a video using OpenAI's SORA 2 model. The video generation is asynchronous and may take several minutes to complete.
     */
    declare function generateVideo(input: generateVideo.Input): Promise<unknown>

    /** Namespace containing the input type for the sendSlackMessage tool. */
    declare namespace sendSlackMessage {
      export interface Input {
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
      }
    }

    /**
     * Send a slack message to the thread you are currently active in.
     */
    declare function sendSlackMessage(input: sendSlackMessage.Input): Promise<unknown>"
  `);
});

test("generateTypes", async () => {
  const { typescript } = generateTypes(getSampleTools());
  expect(typescript()).toMatchInlineSnapshot(`
    "/** Namespace containing the input type for the add tool. */
    declare namespace add {
      export interface Input {
        left: number;
        right: number;
      }
    }

    /**
     * Add two numbers
     */
    declare function add(input: add.Input): Promise<unknown>

    /** Namespace containing the input type for the subtract tool. */
    declare namespace subtract {
      /**
       */
      export type Input = [number, number];
    }

    /**
     * Subtract two numbers
     */
    declare function subtract(input: subtract.Input): Promise<unknown>"
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
