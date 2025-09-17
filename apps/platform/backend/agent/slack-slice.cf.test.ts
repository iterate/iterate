// import { CORE_INITIAL_REDUCED_STATE } from "@iterate- com/helpers/agent/agent-core-schemas";
// import { renderPromptFragment } from "@iterate-com/helpers/agent/prompt-fragments";
// import { createAgentCoreTest } from "@iterate-com/helpers/agent/test-helpers/agent-core-test-harness";
// import { applyD1Migrations, type D1Migration } from "cloudflare:test";
// import { env as rawEnv } from "cloudflare:workers";
// import { describe, expect, it, vi } from "vitest";
// import type { CloudflareEnv } from "../legacy-agent/env.ts";
// import { slackWebhookEventToIdempotencyKey } from "../utils/slack-agent-utils.ts";
// import type { SlackWebhookPayload } from "./slack.types.ts";
// import { slackSlice, slackWebhookEventToPromptFragment } from "./slack-slice.ts";

import { describe } from "vitest";

// // Dummy Slack event type – keep minimal to avoid heavy deps
// interface DummySlackMessageEvent {
//   type: "message";
//   text?: string;
//   user?: string;
// }

// describe.skip("slack-slice helper utilities", () => {
//   describe("slackWebhookEventToPromptFragment formatting", () => {
//     it.each([
//       {
//         name: "regular message",
//         webhookEvent: {
//           type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
//           data: {
//             payload: {
//               event: {
//                 type: "message",
//                 user: "U123USER",
//                 text: "Hello team!",
//                 ts: "1234567890.123456",
//               },
//             },
//           },
//           createdAt: "2024-01-29T20:41:19.701Z",
//           eventIndex: 12,
//         },
//         botUserId: "U08T48230AD",
//         expectedFragment: [
//           "User message via Slack webhook:",
//           JSON.stringify(
//             {
//               user: "U123USER",
//               text: "Hello team!",
//               ts: "1234567890.123456",
//               createdAt: "2024-01-29T20:41:19.701Z",
//             },
//             null,
//             2,
//           ),
//         ],
//       },
//       {
//         name: "bot's own message",
//         webhookEvent: {
//           type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
//           data: {
//             payload: {
//               event: {
//                 type: "message",
//                 bot_id: "U08T48230AD",
//                 user: "U08T48230AD",
//                 text: "I am the bot",
//                 ts: "1234567890.123456",
//               },
//             },
//           },
//           createdAt: "2024-01-29T20:41:19.701Z",
//           eventIndex: 12,
//         },
//         botUserId: "U08T48230AD",
//         expectedFragment: [
//           "You have sent a message via Slack:",
//           JSON.stringify(
//             {
//               user: "U08T48230AD",
//               text: "I am the bot",
//               ts: "1234567890.123456",
//               createdAt: "2024-01-29T20:41:19.701Z",
//               note: "This message was sent by you (the bot) and should appear chronologically before any user interactions with it",
//             },
//             null,
//             2,
//           ),
//         ],
//       },
//       {
//         name: "reaction added",
//         webhookEvent: {
//           type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
//           data: {
//             payload: {
//               event: {
//                 type: "reaction_added",
//                 user: "U456USER",
//                 reaction: "thumbsup",
//                 event_ts: "1234567890.654321",
//               },
//             },
//           },
//           createdAt: "2024-01-29T20:45:00.000Z",
//           eventIndex: 15,
//         },
//         botUserId: "U08T48230AD",
//         expectedFragment: [
//           "User U456USER added reaction thumbsup from slack message with ts 1234567890.654321 at 2024-01-29T20:45:00.000Z",
//         ],
//       },
//       {
//         name: "reaction removed",
//         webhookEvent: {
//           type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
//           data: {
//             payload: {
//               event: {
//                 type: "reaction_removed",
//                 user: "U789USER",
//                 reaction: "eyes",
//                 event_ts: "1234567890.789012",
//               },
//             },
//           },
//           createdAt: "2024-01-29T20:50:00.000Z",
//           eventIndex: 20,
//         },
//         botUserId: "U08T48230AD",
//         expectedFragment: [
//           "User U789USER removed reaction eyes from slack message with ts 1234567890.789012 at 2024-01-29T20:50:00.000Z",
//         ],
//       },
//     ])("$name", ({ webhookEvent, botUserId, expectedFragment }) => {
//       const result = slackWebhookEventToPromptFragment({
//         reducedState: {
//           ...CORE_INITIAL_REDUCED_STATE,
//           slackChannelId: "C123CHANNEL",
//           slackThreadId: "T456THREAD",
//         },
//         webhookEvent: webhookEvent as any,
//         botUserId,
//       });

//       expect(result.promptFragment).toEqual(expectedFragment);
//       expect(result.role).toBe("developer");
//     });
//   });

//   it("convertWebhookEventToDeveloperMessage returns prompt fragment for bot's own messages", () => {
//     const botMessage: DummySlackMessageEvent = {
//       type: "message",
//       text: "I am a bot",
//       user: "U123BOT",
//     };

//     const mockWebhookEvent = {
//       type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
//       data: {
//         payload: {
//           event: botMessage,
//         },
//         updateThreadIds: true,
//       },
//       eventIndex: 0,
//       createdAt: "2024-01-01T00:00:00.000Z",
//     };

//     const result = slackWebhookEventToPromptFragment({
//       reducedState: {
//         ...CORE_INITIAL_REDUCED_STATE,
//         slackChannelId: null,
//         slackThreadId: null,
//       },
//       webhookEvent: mockWebhookEvent as any,
//       botUserId: "U123BOT",
//     });

//     expect(result.promptFragment).toEqual([
//       "You have sent a message via Slack:",
//       JSON.stringify(
//         {
//           user: "U123BOT",
//           text: "I am a bot",
//           ts: undefined,
//           createdAt: "2024-01-01T00:00:00.000Z",
//           note: "This message was sent by you (the bot) and should appear chronologically before any user interactions with it",
//         },
//         null,
//         2,
//       ),
//     ]);
//     expect(result.role).toBe("developer");
//   });

//   it("convertWebhookEventToDeveloperMessage returns formatted prompt for user messages", () => {
//     const userMessage: DummySlackMessageEvent = {
//       type: "message",
//       text: "Hello world",
//       user: "U456USER",
//     };

//     const mockWebhookEvent = {
//       type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
//       data: {
//         payload: {
//           event: userMessage,
//         },
//         updateThreadIds: true,
//       },
//       eventIndex: 0,
//       createdAt: "2024-01-01T00:00:00.000Z",
//     };

//     const result = slackWebhookEventToPromptFragment({
//       reducedState: {
//         ...CORE_INITIAL_REDUCED_STATE,
//         slackChannelId: null,
//         slackThreadId: null,
//       },
//       webhookEvent: mockWebhookEvent as any,
//       botUserId: "U123BOT",
//     });

//     expect(result.promptFragment).toBeTruthy();
//     expect(result.role).toBe("developer");
//     // result is a PromptFragment array
//     const rendered = renderPromptFragment(result.promptFragment || []);
//     expect(rendered).toContain("Hello world");
//     expect(rendered).toContain("U456USER");
//   });
// });

// describe("SlackSlice", () => {
//   // Create test helper with mock dependencies
//   function createSlackTest(mockDeps?: Partial<any>) {
//     const defaultDeps: any = {
//       getCurrentBotUserId: vi.fn().mockResolvedValue("BOT123"),
//       ...mockDeps,
//     };

//     return {
//       test: createAgentCoreTest([slackSlice] as const, { extraDeps: defaultDeps }),
//       deps: defaultDeps,
//     };
//   }

//   const { test: slackTest } = createSlackTest();

//   slackTest("should have correct initial state", async ({ h }) => {
//     await h.initializeAgent();

//     const state = h.agentCore.state as any;
//     expect(state.slackThreadId).toBeUndefined();
//     expect(state.slackChannelId).toBeUndefined();
//     expect(state.slackChannelId).toBeUndefined(); // No channel ID means not initialized
//   });

//   describe("SLACK:UPDATE_SLICE_STATE", () => {
//     const { test: slackTest2 } = createSlackTest();

//     slackTest2("should update channel ID", async ({ h }) => {
//       await h.initializeAgent();

//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C123456",
//         },
//       });

//       const state = h.agentCore.state;
//       expect(state.slackChannelId).toBe("C123456");
//       expect(state.slackThreadId).toBeUndefined();
//     });

//     const { test: slackTest3 } = createSlackTest();

//     slackTest3("should update thread ID", async ({ h }) => {
//       await h.initializeAgent();

//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackThreadId: "1234.5678",
//         },
//       });

//       const state = h.agentCore.state;
//       expect(state.slackThreadId).toBe("1234.5678");
//     });

//     const { test: slackTest4 } = createSlackTest();

//     slackTest4("should update both channel and thread ID", async ({ h }) => {
//       await h.initializeAgent();

//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C123456",
//           slackThreadId: "1234.5678",
//         },
//       });

//       const state = h.agentCore.state;
//       expect(state.slackChannelId).toBe("C123456");
//       expect(state.slackThreadId).toBe("1234.5678");
//     });

//     const { test: slackTestExplicitUpdate } = createSlackTest();

//     slackTestExplicitUpdate("should add developer message for explicit updates", async ({ h }) => {
//       await h.initializeAgent();

//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C789012",
//           slackThreadId: "9876.5432",
//         },
//       });

//       // Check ephemeralPromptFragments for slack context
//       const slackContext = h.agentCore.state.ephemeralPromptFragments["slack-context"];
//       expect(slackContext).toBeDefined();
//     });

//     const { test: slackTestClearIds } = createSlackTest();

//     slackTestClearIds("should clear IDs when set to null", async ({ h }) => {
//       await h.initializeAgent();

//       // First set some IDs
//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C123456",
//           slackThreadId: "1234.5678",
//         },
//       });

//       // Then clear them
//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: null,
//           slackThreadId: null,
//         },
//       });

//       const state = h.agentCore.state;
//       expect(state.slackChannelId).toBe(null);
//       expect(state.slackThreadId).toBe(null);

//       // Check ephemeralPromptFragments - context should NOT be created when slackChannelId is null
//       const slackContext = h.agentCore.state.ephemeralPromptFragments["slack-context"];
//       expect(slackContext).toBeUndefined();
//     });

//     const { test: slackTestContextMessage } = createSlackTest();

//     slackTestContextMessage("should maintain current context message", async ({ h }) => {
//       await h.initializeAgent();

//       // Set context via webhook
//       const webhookPayload = {
//         event: {
//           type: "message",
//           text: "Test message",
//           channel: "C999888",
//           ts: "1234.5678",
//           thread_ts: "1234.0000",
//         },
//       };

//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Inject channel and thread ID updates
//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C999888",
//           slackThreadId: "1234.0000",
//         },
//       });

//       // Check ephemeralPromptFragments for slack context
//       const slackContext = h.agentCore.state.ephemeralPromptFragments["slack-context"];
//       expect(slackContext).toBeDefined();
//     });
//   });

//   describe("SLACK:WEBHOOK_EVENT_RECEIVED", async () => {
//     // The env object is not typed correctly, so we need to cast it to the correct type
//     const env = rawEnv as unknown as CloudflareEnv & { TEST_MIGRATIONS: D1Migration[] };
//     await applyD1Migrations(env.PLATFORM_D1, env.TEST_MIGRATIONS);

//     // Create a test with a specific mock for users map
//     const { test: slackTest5 } = createSlackTest();

//     slackTest5("should add slack users map on every slack event", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "message",
//           text: "Test message",
//           channel: "C123456",
//         },
//         authorizations: [
//           {
//             enterprise_id: null,
//             team_id: "T123456",
//             user_id: "BOT123",
//             is_bot: true,
//             is_enterprise_install: false,
//           },
//         ],
//       };

//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//         metadata: {
//           integrationSlug: "slack",
//         },
//       });

//       // Set the channel ID so that slack-context gets created
//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C123456",
//         },
//       });

//       // Check that a developer message with webhook payload was added
//       const messages = h.agentCore.state.inputItems.filter(
//         (item) => item.type === "message" && item.role === "developer",
//       );

//       // Should have 1 developer message: webhook payload (context is now in ephemeralPromptFragments)
//       expect(messages).toHaveLength(1);

//       // Check ephemeralPromptFragments for slack context
//       const slackContext = h.agentCore.state.ephemeralPromptFragments["slack-context"];
//       expect(slackContext).toBeDefined();

//       // Render the fragment to check its content
//       const contextText = renderPromptFragment(slackContext);
//       expect(contextText).toContain("<slack_user_mappings>");
//       // Since no users were mentioned, the user mappings should only contain the bot
//       expect(contextText).toContain("BOT123");
//     });

//     const { test: slackTest6 } = createSlackTest();

//     slackTest6("should add raw slack event as developer message", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "message",
//           text: "Hey <@U123>, can you help <@U456> with this?",
//           user: "U123", // Add the user who sent the message
//           channel: "C789",
//           ts: "1234.5678",
//           thread_ts: "1234.0000",
//         },
//       };

//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Check that a developer message was added with parsed content
//       const messages = h.agentCore.state.inputItems.filter(
//         (item) => item.type === "message" && item.role === "developer",
//       );
//       expect(messages).toHaveLength(1); // webhook payload (context is now in ephemeralPromptFragments)

//       const devMessage = messages[0]; // The webhook payload is the first message
//       if (devMessage.type === "message") {
//         const content = devMessage.content;
//         if (Array.isArray(content) && content.length > 0 && content[0].type === "input_text") {
//           // The message now includes a descriptive text before the JSON
//           const messageText = content[0].text;
//           expect(messageText).toContain("User message via Slack webhook:");

//           // Extract the JSON part after the descriptive text
//           const jsonMatch = messageText.match(/\n\n({\n[\s\S]*})/);
//           expect(jsonMatch).toBeTruthy();

//           if (jsonMatch) {
//             const parsedEvent = JSON.parse(jsonMatch[1]);
//             expect(parsedEvent.user).toBe("U123");
//             expect(parsedEvent.text).toBe("Hey <@U123>, can you help <@U456> with this?");
//             expect(parsedEvent.ts).toBe("1234.5678");
//             expect(parsedEvent.createdAt).toBeDefined();
//           }
//         }
//       }
//     });

//     const { test: slackTest7 } = createSlackTest();

//     slackTest7("should handle webhook without user mentions", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "message",
//           text: "This is a simple message",
//           channel: "C789",
//           ts: "1234.5678",
//         },
//       };

//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       const messages = h.agentCore.state.inputItems.filter(
//         (item) => item.type === "message" && item.role === "developer",
//       );
//       console.log(JSON.stringify(messages, null, 2));
//       expect(messages).toHaveLength(1); // webhook payload (context is now in ephemeralPromptFragments)

//       const devMessage = messages[0]; // The webhook payload is the first message
//       if (devMessage.type === "message") {
//         const content = devMessage.content;
//         if (Array.isArray(content) && content.length > 0 && content[0].type === "input_text") {
//           expect(content[0].text).toContain("This is a simple message");
//         }
//       }
//     });

//     const { test: slackTest8 } = createSlackTest();

//     slackTest8("should update thread ID when receiving message in new thread", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "message",
//           text: "New thread message",
//           channel: "C789",
//           ts: "1234.5678",
//           thread_ts: "1234.5678",
//         },
//       };

//       // First add the webhook event
//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Then inject an update to simulate thread ID extraction
//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C789",
//           slackThreadId: "1234.5678",
//         },
//       });

//       const state = h.agentCore.state as any;
//       expect(state.slackThreadId).toBe("1234.5678");
//       expect(state.slackChannelId).toBe("C789");
//     });

//     const { test: slackTest9 } = createSlackTest();

//     slackTest9("should trigger LLM request for message events", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "message",
//           text: "Hello bot!",
//           channel: "C789",
//           ts: "1234.5678",
//           user: "U123USER",
//         },
//       };

//       // Add webhook event - triggerLLMRequest will be determined by reducer
//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Check that LLM request was triggered
//       const events = h.getEvents();
//       const llmStartEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
//       expect(llmStartEvents).toHaveLength(1);

//       // Check that the webhook content was added as a developer message
//       const devMessages = h.agentCore.state.inputItems.filter(
//         (item) => item.type === "message" && item.role === "developer",
//       );
//       const webhookMessage = devMessages.find((msg) => {
//         if (msg.type === "message" && Array.isArray(msg.content)) {
//           const content = msg.content[0];
//           return content.type === "input_text" && content.text.includes("Hello bot!");
//         }
//         return false;
//       });
//       expect(webhookMessage).toBeDefined();
//     });

//     const { test: slackTest10 } = createSlackTest();

//     slackTest10("should not trigger LLM request for non-message events", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "reaction_added", // Allowed event type but not a message
//           reaction: "thumbsup",
//           item: {
//             type: "message",
//             channel: "C789",
//             ts: "1234.5678",
//           },
//           item_user: "U456", // Not the bot user, so should not trigger LLM
//           user: "U123",
//           channel: "C789",
//         },
//       };

//       // Add webhook event - reducer should not trigger LLM for non-message events
//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Check that LLM request was NOT triggered
//       const events = h.getEvents();
//       const llmStartEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
//       expect(llmStartEvents).toHaveLength(0);

//       // But the event should still be added as a developer message
//       const devMessages = h.agentCore.state.inputItems.filter(
//         (item) => item.type === "message" && item.role === "developer",
//       );
//       const webhookMessage = devMessages.find((msg) => {
//         if (msg.type === "message" && Array.isArray(msg.content)) {
//           const content = msg.content[0];
//           return content.type === "input_text" && content.text.includes("User U123 added reaction");
//         }
//         return false;
//       });
//       expect(webhookMessage).toBeDefined();
//     });

//     const { test: slackTestChannelExtraction } = createSlackTest();

//     slackTestChannelExtraction("should extract channel ID from webhooks", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "message",
//           text: "Test message",
//           channel: "C12345",
//           ts: "1234.5678",
//         },
//       };

//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Inject channel ID update
//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C12345",
//           slackThreadId: "1234.5678",
//         },
//       });

//       const state = h.agentCore.state as any;
//       expect(state.slackChannelId).toBe("C12345");
//     });

//     const { test: slackTestReactionWithChannel } = createSlackTest();

//     slackTestReactionWithChannel("should extract channel from reaction events", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "reaction_added",
//           reaction: "thumbsup",
//           item: {
//             type: "message",
//             channel: "C98765",
//             ts: "1234.5678",
//           },
//           channel: "C98765",
//         },
//       };

//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Inject channel ID update
//       await h.agentCore.addEvent({
//         type: "SLACK:UPDATE_SLICE_STATE",
//         data: {
//           slackChannelId: "C98765",
//         },
//       });

//       const state = h.agentCore.state as any;
//       expect(state.slackChannelId).toBe("C98765");
//     });

//     const { test: slackTestBotFiltering } = createSlackTest();

//     slackTestBotFiltering(
//       "should include bot's own messages as developer messages but not trigger LLM",
//       async ({ h }) => {
//         await h.initializeAgent();

//         const webhookPayload = {
//           event: {
//             type: "message",
//             text: "Bot's own message",
//             channel: "C123",
//             ts: "1234.5678",
//             user: "BOT123", // Same as the bot user ID
//           },
//           authorizations: [
//             {
//               enterprise_id: null,
//               team_id: "T123456",
//               user_id: "BOT123",
//               is_bot: true,
//               is_enterprise_install: false,
//             },
//           ],
//         };

//         await h.agentCore.addEvent({
//           type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//           data: {
//             payload: webhookPayload,
//           },
//         });

//         // Bot's message should be included as developer message for context
//         const devMessages = h.agentCore.state.inputItems.filter(
//           (item) => item.type === "message" && item.role === "developer",
//         );

//         // Should contain the webhook payload as a developer message
//         const webhookMessage = devMessages.find((msg) => {
//           if (msg.type === "message" && Array.isArray(msg.content)) {
//             const content = msg.content[0];
//             return content.type === "input_text" && content.text.includes("Bot's own message");
//           }
//           return false;
//         });

//         expect(webhookMessage).toBeDefined();
//         expect(webhookMessage).toHaveProperty("role", "developer");

//         // Should NOT trigger LLM computation for bot messages
//         const events = h.getEvents();
//         const llmStartEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
//         expect(llmStartEvents).toHaveLength(0);
//       },
//     );

//     const { test: slackTestNonEligibleEvent } = createSlackTest();

//     slackTestNonEligibleEvent("should filter out non-eligible event types", async ({ h }) => {
//       await h.initializeAgent();

//       const webhookPayload = {
//         event: {
//           type: "user_change", // Not in allowed event types
//           user: {
//             id: "U123",
//             name: "Updated User",
//           },
//         },
//       };

//       await h.agentCore.addEvent({
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//         data: {
//           payload: webhookPayload,
//         },
//       });

//       // Non-eligible event should be filtered out
//       const devMessages = h.agentCore.state.inputItems.filter(
//         (item) => item.type === "message" && item.role === "developer",
//       );

//       const webhookMessage = devMessages.find((msg) => {
//         if (msg.type === "message" && Array.isArray(msg.content)) {
//           const content = msg.content[0];
//           return content.type === "input_text" && content.text.includes("user_change");
//         }
//         return false;
//       });

//       expect(webhookMessage).toBeUndefined();
//     });

//     const { test: slackTestInitialization } = createSlackTest();

//     slackTestInitialization(
//       "Slack initialization is indicated by presence of slackChannelId",
//       async ({ h }) => {
//         await h.initializeAgent();

//         // Initially not initialized
//         expect((h.agentCore.state as any).slackChannelId).toBeUndefined();

//         // Register a mock for the sendSlackMessage tool
//         h.registerMockTool("sendSlackMessage", async () => ({
//           toolCallResult: { success: true },
//         }));

//         // Add the sendSlackMessage tool
//         await h.agentCore.addEvent({
//           type: "CORE:ADD_TOOL_SPECS",
//           data: {
//             specs: [
//               {
//                 type: "agent_durable_object_tool",
//                 methodName: "sendSlackMessage",
//               } as any,
//             ],
//           },
//         });

//         // Should now be initialized
//         // The test for initialization is now based on slackChannelId presence
//         // This test may need to be refactored based on the new initialization logic
//       },
//     );

//     const { test: slackTestThreadHistory } = createSlackTest();

//     slackTestThreadHistory(
//       "should add thread history context when webhook has thread_ts different from ts",
//       async ({ h }) => {
//         await h.initializeAgent();

//         // Add a webhook event with thread_ts different from ts (existing thread)
//         const webhookPayload = {
//           event: {
//             type: "message",
//             text: "Reply in existing thread",
//             user: "U123",
//             channel: "C123CHANNEL",
//             ts: "1234567890.123456",
//             thread_ts: "1234567800.000000", // Different from ts - indicates existing thread
//           },
//         };

//         await h.agentCore.addEvent({
//           type: "SLACK:WEBHOOK_EVENT_RECEIVED",
//           data: {
//             payload: webhookPayload,
//           },
//         });

//         // Inject channel and thread ID updates
//         await h.agentCore.addEvent({
//           type: "SLACK:UPDATE_SLICE_STATE",
//           data: {
//             slackChannelId: "C123CHANNEL",
//             slackThreadId: "1234567800.000000",
//           },
//         });

//         // Check that the reducer added the message to inputItems
//         const messages = h.agentCore.state.inputItems.filter((item) => item.type === "message");

//         // Should have at least 1 message: the webhook message
//         expect(messages.length).toBeGreaterThanOrEqual(1);

//         // Find the message with the webhook content
//         const webhookMessage = messages.find((msg) => {
//           if (msg.type !== "message" || msg.role !== "developer") {
//             return false;
//           }
//           const content = msg.content;
//           if (!Array.isArray(content) || content.length === 0) {
//             return false;
//           }
//           const firstContent = content[0];
//           return (
//             firstContent.type === "input_text" &&
//             firstContent.text?.includes("Reply in existing thread")
//           );
//         });
//         expect(webhookMessage).toBeDefined();

//         // Check ephemeralPromptFragments for slack context
//         const slackContext = h.agentCore.state.ephemeralPromptFragments["slack-context"];
//         expect(slackContext).toBeDefined();

//         // Render the fragment to check its content
//         const contextText = renderPromptFragment(slackContext);

//         // Should contain slack context tag
//         expect(contextText).toContain("<slack_context>");

//         // Verify that thread IDs were properly extracted and stored in state
//         expect((h.agentCore.state as any).slackChannelId).toBe("C123CHANNEL");
//         expect((h.agentCore.state as any).slackThreadId).toBe("1234567800.000000");
//       },
//     );
//   });

//   describe("Model params override behavior", () => {
//     const { test: slackTest11 } = createSlackTest();

//     slackTest11(
//       "should force toolChoice to 'required' when setting model options",
//       async ({ h }) => {
//         await h.initializeAgent();

//         // Set system prompt first
//         await h.agentCore.addEvent({
//           type: "CORE:SET_SYSTEM_PROMPT",
//           data: { prompt: "You are a helpful Slack bot." },
//         });

//         // Verify toolChoice was overridden to "required" by the slack slice
//         expect(h.agentCore.state.modelOpts.toolChoice).toBe("required");

//         // Try again with explicit toolChoice: "none"
//         await h.agentCore.addEvent({
//           type: "CORE:SET_MODEL_OPTS",
//           data: {
//             model: "gpt-4.1",
//             temperature: 0.5,
//             toolChoice: "none",
//           },
//         });

//         // Should still be overridden to "required"
//         expect(h.agentCore.state.modelOpts.toolChoice).toBe("required");
//         expect(h.agentCore.state.modelOpts.temperature).toBe(0.5);
//         expect(h.agentCore.state.modelOpts.model).toBe("gpt-4.1");

//         // Try with toolChoice: "auto"
//         await h.agentCore.addEvent({
//           type: "CORE:SET_MODEL_OPTS",
//           data: {
//             model: "gpt-4.1",
//             temperature: 0.3,
//             toolChoice: "auto",
//           },
//         });

//         // Should still be overridden to "required"
//         expect(h.agentCore.state.modelOpts.toolChoice).toBe("required");
//         expect(h.agentCore.state.modelOpts.temperature).toBe(0.3);
//       },
//     );
//   });

//   describe("slackWebhookEventToPromptFragment shouldTriggerLLM behavior", () => {
//     it.each([
//       {
//         name: "regular user message - should trigger LLM",
//         event: {
//           type: "message",
//           user: "U123USER",
//           text: "Hello bot!",
//           ts: "1234.5678",
//         },
//         botUserId: "BOT123",
//         paused: false,
//         expectedTriggerLLM: true,
//       },
//       {
//         name: "regular user message when paused - should still return true (paused is handled by reducer)",
//         event: {
//           type: "message",
//           user: "U123USER",
//           text: "Hello bot!",
//           ts: "1234.5678",
//         },
//         botUserId: "BOT123",
//         paused: true,
//         expectedTriggerLLM: true,
//       },
//       {
//         name: "bot's own message - should NOT trigger LLM",
//         event: {
//           type: "message",
//           user: "BOT123",
//           text: "I am the bot",
//           ts: "1234.5678",
//         },
//         botUserId: "BOT123",
//         paused: false,
//         expectedTriggerLLM: false,
//       },
//       {
//         name: "bot message with bot_id - should NOT trigger LLM",
//         event: {
//           type: "message",
//           bot_id: "BOT123",
//           text: "Bot message",
//           ts: "1234.5678",
//         },
//         botUserId: "BOT123",
//         paused: false,
//         expectedTriggerLLM: false,
//       },
//       {
//         name: "bot message from other app that mentions our bot - should trigger LLM",
//         event: {
//           type: "message",
//           bot_id: "OTHERBOT",
//           text: "Hi <@BOT123> can you help?",
//           ts: "1234.5679",
//         },
//         botUserId: "BOT123",
//         paused: false,
//         expectedTriggerLLM: true,
//       },
//       {
//         name: "reaction event - should NOT trigger LLM",
//         event: {
//           type: "reaction_added",
//           user: "U123USER",
//           reaction: "thumbsup",
//           event_ts: "1234.5678",
//         },
//         botUserId: "BOT123",
//         paused: false,
//         expectedTriggerLLM: false,
//       },
//     ])("$name", ({ event, botUserId, expectedTriggerLLM }) => {
//       const webhookEvent = {
//         type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
//         data: {
//           payload: { event },
//         },
//         createdAt: "2024-01-29T20:41:19.701Z",
//         eventIndex: 12,
//       };

//       const result = slackWebhookEventToPromptFragment({
//         reducedState: {
//           ...CORE_INITIAL_REDUCED_STATE,
//           slackChannelId: "C123CHANNEL",
//           slackThreadId: "T456THREAD",
//         },
//         webhookEvent: webhookEvent as any,
//         botUserId,
//       });

//       expect(result.shouldTriggerLLM).toBe(expectedTriggerLLM);
//       expect(result.role).toBe("developer");
//     });
//   });
// });

// describe("slackWebhookEventToIdempotencyKey", () => {
//   it.each([
//     {
//       name: "identical webhooks with different tokens should produce same key",
//       webhookA: {
//         token: "GjRW6leWJY8VuBmB1hdPAwqd",
//         team_id: "T0675PSN873",
//         event: {
//           type: "message",
//           user: "U08NQR1GCRE",
//           ts: "1753883152.514179",
//           bot_id: "B08NQR1GB08",
//           app_id: "A08NDMDC2JV",
//           text: "_handing off to the Linear assistant now_",
//           team: "T0675PSN873",
//           bot_profile: {
//             id: "B08NQR1GB08",
//             deleted: false,
//             name: "iterate",
//             updated: 1753781829,
//             app_id: "A08NDMDC2JV",
//             user_id: "U08NQR1GCRE",
//             icons: {
//               image_36:
//                 "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_36.png",
//               image_48:
//                 "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_48.png",
//               image_72:
//                 "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_72.png",
//             },
//             team_id: "T0675PSN873",
//           },
//           thread_ts: "1753883138.377819",
//           parent_user_id: "U08KULV8WKV",
//           blocks: [
//             {
//               type: "rich_text",
//               block_id: "ovh",
//               elements: [
//                 {
//                   type: "rich_text_section",
//                   elements: [
//                     {
//                       type: "text",
//                       text: "handing off to the Linear assistant now",
//                       style: {
//                         italic: true,
//                       },
//                     },
//                   ],
//                 },
//               ],
//             },
//           ],
//           channel: "C08R1SMTZGD",
//           event_ts: "1753883152.514179",
//           channel_type: "channel",
//         },
//       },
//       webhookB: {
//         token: "CFypUvcPzux6cucO8Y657NHW", // Different token
//         team_id: "T0675PSN873",
//         event: {
//           type: "message",
//           user: "U08NQR1GCRE",
//           ts: "1753883152.514179",
//           bot_id: "B08NQR1GB08",
//           app_id: "A08NDMDC2JV",
//           text: "_handing off to the Linear assistant now_",
//           team: "T0675PSN873",
//           bot_profile: {
//             id: "B08NQR1GB08",
//             deleted: false,
//             name: "iterate",
//             updated: 1753781829,
//             app_id: "A08NDMDC2JV",
//             user_id: "U08NQR1GCRE",
//             icons: {
//               image_36:
//                 "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_36.png",
//               image_48:
//                 "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_48.png",
//               image_72:
//                 "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_72.png",
//             },
//             team_id: "T0675PSN873",
//           },
//           thread_ts: "1753883138.377819",
//           parent_user_id: "U08KULV8WKV",
//           blocks: [
//             {
//               type: "rich_text",
//               block_id: "ovh",
//               elements: [
//                 {
//                   type: "rich_text_section",
//                   elements: [
//                     {
//                       type: "text",
//                       text: "handing off to the Linear assistant now",
//                       style: {
//                         italic: true,
//                       },
//                     },
//                   ],
//                 },
//               ],
//             },
//           ],
//           channel: "C08R1SMTZGD",
//           event_ts: "1753883152.514179",
//           channel_type: "channel",
//         },
//       },
//       expectation: "same" as const,
//     },
//     {
//       name: "different messages should produce different keys",
//       webhookA: {
//         token: "token1",
//         team_id: "T0675PSN873",
//         event: {
//           type: "message",
//           text: "Hello world",
//           channel: "C08R1SMTZGD",
//           ts: "1753883152.514179",
//         },
//       },
//       webhookB: {
//         token: "token1",
//         team_id: "T0675PSN873",
//         event: {
//           type: "message",
//           text: "Goodbye world", // Different text
//           channel: "C08R1SMTZGD",
//           ts: "1753883152.514179",
//         },
//       },
//       expectation: "different" as const,
//     },
//     {
//       name: "empty or undefined payloads should return empty string",
//       webhookA: undefined,
//       webhookB: { token: "token", team_id: "team" }, // No event property
//       expectation: "same" as const, // Both should return empty string
//     },
//   ])("$name", ({ webhookA, webhookB, expectation }) => {
//     const keyA = slackWebhookEventToIdempotencyKey(webhookA as SlackWebhookPayload);
//     const keyB = slackWebhookEventToIdempotencyKey(webhookB as SlackWebhookPayload);

//     if (expectation === "same") {
//       expect(keyA).toBe(keyB);
//     } else {
//       expect(keyA).not.toBe(keyB);
//     }
//   });
// });

describe.skip("slack-slice helper utilities", () => {});
