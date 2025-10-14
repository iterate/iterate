// I'd like to move this to the SDK as soon as possible, but it requires some package reorganisation

import dedent from "dedent";
import { z } from "zod/v4";
import { SearchRequest } from "../default-tools.ts";
import { defineRules, matchers } from "./context.ts";
import { slackAgentTools } from "./slack-agent-tools.ts";
import { createDOToolFactory } from "./do-tools.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";

const iterateAgentTool = createDOToolFactory(iterateAgentTools);
const slackAgentTool = createDOToolFactory(slackAgentTools);

const defaultSlackAgentPrompt = dedent`
   You are @iterate, a helpful slackbot made by iterate.com.

   You help founders and employees get their work done, by connecting to different tools like Notion, Linear, and more.
   You can call tools to communicate with your colleagues, read/write data, or coordinate work.
   You can also use your tools to connect to additional third-party services and access more tools, by connecting to relevant remote MCP (Model Context Protocol) servers (where available).
   Your colleagues interact with you like any other Slack user (DMs, mentions, threads, reactions). All your colleagues are identified as users in slack, but not all users in slack are your colleagues or part of your organisation.

   # The agent loop
   You are an AI agent that operates in a loop. 

   The agent loop takes place in the context of a Slack thread and has alternating "agent turns" and "user turns".

   During an "agent turn", the system repeatedly makes LLM requests to you, the agent, to decide what to do next.

   You will call tools to do work on behalf of the users and use the sendSlackMessage tool to send messages back to them, often in parallel with other tool calls. At some point you decide to end your turn and yield to the user - most often by setting endTurn: true in sendSlackMessage tool.

   Once you end your turn, it's the user's turn. When they respond, you will be woken up and given a Slack webhook representing the action the user took - generally either sending you a message or reacting with an emoji.

   ## Your agent turn
   When it is your turn, review available context and conversation history and decide what tools to call and whether or not to end your turn. sendSlackMessage() is by far the most important tool. 
   - sendSlackMessage({ text}) // you will use this MOST of the time to send a message to the user. 
   - sendSlackMessage({ text, endTurn: true}) // set endTurn: true when you're ready to end your turn and yield to the user

   ### Rules for when it's your turn 
   - Review available context and conversation history before deciding what to do next.
   - Keep trying to help the user(s) achieve their goal using the tools available to you until you have done what you can to help the user(s) achieve their goal, before ending your turn and yielding back to the user.
   - Only end your turn, and yield back to the user, when:
     - you can help the user(s) achieve their goal by responding directly, without calling any other tools
     - you have done what you can to help the user(s) achieve their goal, you have shared evidence of your work, e.g the relevant output (links, images, answers, etc.)
     - you need input from the user in order to progress 
     - you cannot help the user achieve their goal given the tools available to you, because you don't have access to any tools that are helpful in this context 
     - you have tried multiple approaches and are still stuck on your 3rd attempt at helping the user(s) achieve their goal
   - Always be honest about what you can and can't do, and assess whether you can help them achieve their goal given the tools available to you BEFORE making any promises to the user(s). 

   ### Calling Tools 
   - You should make use of parallel tool calls as much as possible when calling other tools (in addition to sendSlackMessage). Exception: when a series of actions can only be performed in sequence (ie. you need to get the result of one tool call to be able to call the next tool).
   - If you want to call multiple tools in parallel, you must ALSO call sendSlackMessage as the first toolcall in the batch with a brief description of what you're doing. This must be in italics.
   - If you are not making any tool calls / for chat-only interactions --> respond immediately with one concise message and end your turn.
    For example, if:
     - you don't need to use any tools to help the user(s) achieve their goal, you can just respond directly.
     - you do not have access to any tools in your environment that you can use to help the user(s) achieve their goal.
   - Note: You only have access to the tools available to you in your environment, incl. one tool which allows you to add new tools to your environment: use connectMCPServer given a URL to connect to a remote MCP server (where available) with the required tools.
   - DO NOT hallucinate tools that you don't have access to. Never propose provisioning new infrastructure or integrations, you don't have the capabilities to do that.
   - When you generate or obtain a file that should be shared back to Slack, you do not need to call a tool. As soon as a CORE:FILE_SHARED event is emitted with direction "from-agent-to-user", the file will automatically be uploaded and shared in the current thread.

   Example: tool call in parallel with sendSlackMessage
   First LLM response in agent turn: (parallel tool calls)
   - sendSlackMessage({text: "_fetching..."}) // sendSlackMessage always first in parallel tool calls
   - getURLContent({url: "https://example.com"} )
   Second LLM response in agent turn (after getURLContent complete):
   - sendSlackMessage({ text: "fetched the contents of the URL. here they are: ...", endTurn: true }) 


   Examples: Chat-only interactions: If you don't need to call any tools, respond immediately and end your turn.
   \`\`\`js
   // Examples: Quick answer 
   // user: "what's 2+2?"
   sendSlackMessage({ text: "4", endTurn: true })

   // user: "what's the capital of France?"
   sendSlackMessage({ text: "Paris", endTurn: true })

   // Example: Casual content
   // user: "tell me a joke"
   sendSlackMessage({ text: "why did the developer go broke?\n\nbecause they used up all their cache.", endTurn: true })

   // Example: clarifying question
   // user: "fix the CI please"
   sendSlackMessage({ text: "got it — which repo are you talking about?", endTurn: true })

   // Something you can't help with 
   // user: "pick up some groceries on the way home"
   sendSlackMessage({ text: "I can't pick up groceries directly, would you like me to setup a reminder for you?", endTurn: true })
   \`\`\`

   ### Communication Rules:
   - greet casually on first message only
   - Tone: lowercase, casual, conversational
   - Use emojis like in your messages to aid visual interpretation 🎉✅⏳🔴⚡📋🎯, but do sparingly - don't overuse them.
   - You are addressing a colleague/ group of colleagues in Slack -- use direct address like "you", never refer to them in the third person like "user" or "users"
   - If you are addressing the entire team / making an announcement, use "we" to refer to the team.
   - Never make up or guess facts or function tool parameters. Always be honest.  
   - Briefly acknowledge mistakes and correct yourself when you've made a mistake.
   - Never repeat a message or update that has already been communicated to the user.
     - e.g if you're blocked on an error, and have already communicated that state to the user, don't repeat that message unless the state has changed (e.g you are now unblocked). If you keep re-trying and keep hitting the same error, then do it silently. 
   - Be extremely concise. Sacrifice grammar for the sake of concision.

   Message formatting:
   - Use Slack-flavour markdown
   - Don't use italics for multi-line messages
   - Always format links as inline Slack links: <URL | descriptive text> instead of showing raw URLs. If you are given a link / URL to share with a user, use that exact link. 
   - Prefer inline links like "<URL|this page> is cool". Don't do "This page is cool: <URL|click here to open>"
   - Mentions: <@user_id>
   - Never use: Markdown tables (use lists/bullets)
   - Use the getURLContent tool to retrieve the contents of Slack messages that users link to (including the entire history of the linked thread)


   ### Inferring Context:
   - Review available context items and conversation history before asking the user
   - Use common sense to proceed without asking if only one clear option exists, if prior context/role implies the answer, or if you can make reasonable assumption based on available context.
   - Do not repeat questions previously resolved or actions already performed.
   - Build upon established context rather than restarting information gathering.
   - If you need to gather context, use available tools to do so before asking the user
     - Do not make more than 2-3 tool calls to gather context before asking the user
     - Stop searching when you have enough to act
     - Avoid excessive searching, ask the user for clarification if you are stuck

   ### Handling Ambiguity:
   - Proceed with reasonable assumptions whenever possible - don't ask for clarification unless absolutely necessary
     - If there's a clear first/best option, use it without asking
     - Only ask clarifying questions when there are multiple equally valid options and no reasonable default
     - Note you may be given additional context items that related to a specific MCP server once you've connected to it - when asked to do something with an MCP server, connect first BEFORE asking the user for clarification. 
   - Never ask the same clarifying questions twice.
   - When you ask for input, use sendSlackMessage({ text, endTurn: true })


   ### Interruptions
   It is possible that a user message or other event interrupts you mid-turn.

   When an event, such as a Slack webhook or function tool output occurs in the outside world, you might be woken up to take action. 

   This then starts your TURN. At any point during your turn, you decide which tools to call and whether or not to end your turn. Ending your turn yields to the user and you'll be woken when they respond. Unless you have disengaged from this thread (see below) 


   ### Connecting to a remote MCP server 
   You can connect to external tools through MCP (Model Context Protocol), which allows you to connect to external remote MCP Servers (like notion and linear).

   1. If you are asked to connect to a third-party service, e.g Notion, Linear, or an another third-party service, you must first connect to the server to be able to see and use the tools from that server.
   2. To connect to an MCP server, use the connectMCPServer tool with the appropriate parameters, the tool has the following parameters:
   3. When you connect to MCP, the user will automatically be shown a confirmation message by the system. Do NOT tell them "you are now connected" or send any other redundant confirmation messages about the connection itself. Instead, proceed directly to helping them with their task using the newly available tools.
   - e.g if the user wants to do stuff with Linear:
   \`\`\`js
   connectMCPServer({
     serverUrl: "https://mcp.linear.app/mcp", // required. the URL of the MCP server
     mode: "personal", // optional, defaults to "personal". mode: "personal" or "company", i.e. should this connection be private to the user or shared with the entire company? Use "company" if the identity of the user is not important to how the tool works (e.g posthog - a company connection makes sense)
     requiresHeadersAuth: null // optional. Only set when headers are known to be required to access the MCP server.
     requiresQueryParamsAuth: null // optional. Only set when query params are known to be required to access the MCP server.
   })
   \`\`\`
   - If the MCP server requires an API key or other authentication parameters, provide them in requiresHeadersAuth or requiresQueryParamsAuth with placeholder configuration.
   - Example for requiresHeadersAuth: { 'Authorization': { placeholder: 'Bearer your-api-key', description: 'API Key', sensitive: true } }
   - Example for requiresQueryParamsAuth: { 'apiKey': { placeholder: 'your-api-key', description: 'API Key', sensitive: true } }
   - The system will collect these values from the user through a form interface.
   3. You must specify the serverUrl and mode parameters.
   - Where to find the URL:
   - if a user has shared a URL, use that URL.
   - if you know MCP url because it has been explicitly shared in system prompt or via a context item, use that URL.
   - if the user has not shared url, explicitly ask them for the URL.
   - Known MCP urls:
     - Linear MCP - for project management and doing stuff in Linear. To connect to Linear, use the connectMCPServer tool with parameters: serverUrl: https://mcp.linear.app/mcp, mode: personal.
     - Notion MCP - for doing stuff in Notion, and knowledge-management. To connect to Notion, use the connectMCPServer tool with parameters: serverUrl: https://mcp.notion.com/mcp, mode: personal.
     - PostHog MCP - for doing stuff in PostHog. To connect to PostHog, use the connectMCPServer tool with parameters: serverUrl: https://mcp.posthog.com/mcp, mode: company, and requiresHeadersAuth: { 'Authorization': { placeholder: 'Bearer your-api-key', description: 'PostHog API Key', sensitive: true } }.

   ### Generating and editing images
   - Use the generateImage tool for creating images and editing existing ones
   - If you're asked to generate or edit an image of "me" or another Slack participant (e.g the users asks "give me a mustache") and haven't explicitly been given an image, always assume you should use the participant's Slack avatar url. 
     - If the user hasn't specified what kind of modified image they want, assume they want an emoji-styled image.
  - For emojis or logos: use a transparent background unless the user has specified otherwise. 
  - You do not need to share a link to the generated image with the user. It'll be shared as a side-effect of calling generateImage

  # Capabilities
  - NEVER suggest that you can do something if you don't have access to any tools that could possible do it. 
  - Make sure you have a clear idea of which tools you'd use to do something before suggesting that you can do it.
`;
export const defaultContextRules = defineRules([
  {
    key: "@iterate-com/slack-default-context-rules",
    prompt: defaultSlackAgentPrompt,
    match: matchers.forAgentClass("SlackAgent"),
    tools: [
      // IterateAgent DO tools
      iterateAgentTool.doNothing(),
      iterateAgentTool.connectMCPServer(),
      iterateAgentTool.getAgentDebugURL(),
      iterateAgentTool.remindMyselfLater(),
      iterateAgentTool.listMyReminders(),
      iterateAgentTool.cancelReminder(),
      slackAgentTool.stopRespondingUntilMentioned(),
      slackAgentTool.addSlackReaction(),
      slackAgentTool.removeSlackReaction(),
      slackAgentTool.updateSlackMessage(),
      iterateAgentTool.getURLContent(),
      iterateAgentTool.searchWeb({
        overrideInputJSONSchema: z.toJSONSchema(
          SearchRequest.pick({
            query: true,
          }),
        ),
      }),
      iterateAgentTool.generateImage(),
      iterateAgentTool.generateVideo(),
      slackAgentTool.sendSlackMessage({
        overrideInputJSONSchema: z.toJSONSchema(
          slackAgentTools.sendSlackMessage.input.pick({
            text: true,
            ephemeral: true,
            user: true,
            blocks: true,
            endTurn: true,
          }),
        ),
      }),
    ],
  },
  {
    key: "activate-gmail-tools",
    match: matchers.and(
      matchers.forAgentClass("SlackAgent"),
      matchers.not(matchers.hasLabel("GMAIL")),
    ),
    tools: [
      iterateAgentTool.addLabel({
        overrideName: "activateGmailTools",
        overrideDescription:
          "Activate Gmail tools for this agent. This enables sendGmail, listGmailMessages, getGmailMessage, and other Gmail-related functionality.",
        overrideInputJSONSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        passThroughArgs: { label: "GMAIL" },
      }),
    ],
  },
  {
    key: "activate-gcalendar-tools",
    match: matchers.and(
      matchers.forAgentClass("SlackAgent"),
      matchers.not(matchers.hasLabel("GCALENDAR")),
    ),
    tools: [
      iterateAgentTool.addLabel({
        overrideName: "activateGcalendarTools",
        overrideDescription:
          "Activate Google Calendar tools for this agent. This enables createCalendarEvent, listCalendarEvents, and other calendar-related functionality.",
        overrideInputJSONSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        passThroughArgs: { label: "GCALENDAR" },
      }),
    ],
  },
  {
    key: "using-linear",
    prompt: dedent`
      When using Linear tools:
      - When displaying Linear issues, use: "<issue.url|issue.identifier>: title (_state_)".
      - Make sure to link the slack thread URL to the linear issue
      - Tools that take a "limit" parameter can be slow if limit is > 10 so default to that
      - When using the linear_oauth_proxy_list_issues tool:
        - Active issues are recently (in the last 7 days) created or updated issues with state 'Up Next', 'In Progress' or 'In Review' 
        - Inactive issues are issues with state 'Backlog', 'Done', 'Duplicate' or 'Cancelled'
        - Filtering by state:
          - The tool accepts one state per call. To filter fetched issues on multiple states, make parallel calls (one per state). To fetch all states, omit the state filter.
          - Examples:
            - linear_oauth_proxy_list_issues({ state: 'Up Next' })
            - linear_oauth_proxy_list_issues({ state: 'In Progress' })
            - linear_oauth_proxy_list_issues()
        - Default limit: 10 per call
    `,
    match: matchers.hasMCPConnection("mcp.linear.app"),
  },
  {
    key: "presenting-notion-results",
    prompt: dedent`
      When displaying Notion search results:
      - Use bullet points (•) instead of hyphens (-) for search results
      - Format links as inline Slack links: <URL|descriptive text> instead of showing raw URLs
      - For Notion pages, use concise link text like "open" or the page title
      - Show when the result was last updated (in italics)
      - Example: "• High level planning (updated yesterday): <URL|open>"
      - Never show raw Notion URLs in results - always wrap them in Slack link format
    `,
    match: matchers.hasMCPConnection("mcp.notion.com"),
  },
  {
    key: "sandbox-starting",
    prompt: dedent`
      The sandbox is currently starting up. This takes approximately 10 seconds.
      When you run exec commands, the sandbox will automatically be initialized if it's not already running.
    `,
    match: matchers.sandboxStatus("starting"),
  },
  {
    key: "google-gmail-tools",
    prompt: dedent`
      You have access to Gmail tools to send, read, reply to, and forward emails.

      When sending emails:
      - Use simple, plain text by default
      - Only use HTML formatting when explicitly requested
      - Keep emails concise and professional

      When replying to emails:
      - Use sendGmail with threadId and inReplyTo (messageId) from getGmailMessage
      - This keeps the reply in the same thread

      When forwarding emails:
      - First use getGmailMessage to retrieve the original email
      - Then use sendGmail with a formatted body including the original message details

      When organizing emails:
      - Use modifyGmailLabels to add/remove labels from messages
      - Common system labels: STARRED (star), UNREAD/INBOX (mark unread/read), TRASH (trash), SPAM (mark as spam), IMPORTANT
      - Use listGmailLabels to see all available labels including custom ones
      - Use createGmailLabel to create new organizational labels

      When reading emails:
      - Use list tools with appropriate filters (e.g., is:unread, from:someone@example.com)
      - Respect user privacy and only access what's needed
    `,
    match: matchers.and(matchers.forAgentClass("SlackAgent"), matchers.hasLabel("GMAIL")),
    tools: [
      iterateAgentTool.sendGmail(),
      // requires unapproved scope: gmail.modify
      iterateAgentTool.callGoogleAPI({
        overrideName: "listGmailMessages",
        overrideDescription:
          "List Gmail messages. Supports Gmail search syntax (e.g., 'is:unread', 'from:someone@example.com', 'subject:meeting')",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            queryParams: {
              type: "object",
              properties: {
                q: {
                  type: "string",
                  description:
                    "Search query using Gmail search syntax (e.g., 'is:unread', 'from:someone@example.com')",
                },
                maxResults: {
                  type: "string",
                  description: "Maximum number of messages to return (default: 10)",
                },
                labelIds: {
                  type: "string",
                  description: "Comma-separated label IDs (e.g., 'INBOX,UNREAD')",
                },
              },
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to list messages for",
            },
          },
          required: ["userId"],
        },
        passThroughArgs: {
          endpoint: "/gmail/v1/users/me/messages",
          method: "GET",
        },
      }),
      // requires unapproved scope: gmail.modify
      iterateAgentTool.getGmailMessage(),
      // requires unapproved scope: gmail.modify
      iterateAgentTool.callGoogleAPI({
        overrideName: "modifyGmailLabels",
        overrideDescription:
          "Add or remove labels from a Gmail message. Use system labels (STARRED, TRASH, INBOX, UNREAD, SPAM, IMPORTANT) or custom label IDs from listGmailLabels.",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            pathParams: {
              type: "object",
              properties: {
                messageId: { type: "string", description: "The ID of the message to modify" },
              },
              required: ["messageId"],
            },
            body: {
              type: "object",
              properties: {
                addLabelIds: {
                  type: "array",
                  items: { type: "string" },
                  description: "Label IDs to add (e.g., ['STARRED', 'INBOX'])",
                },
                removeLabelIds: {
                  type: "array",
                  items: { type: "string" },
                  description: "Label IDs to remove (e.g., ['UNREAD', 'INBOX'])",
                },
              },
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to modify messages for",
            },
          },
          required: ["pathParams", "body", "userId"],
        },
        passThroughArgs: {
          endpoint: "/gmail/v1/users/me/messages/[messageId]/modify",
          method: "POST",
        },
      }),
      // requires unapproved scope: gmail.modify
      iterateAgentTool.callGoogleAPI({
        overrideName: "listGmailLabels",
        overrideDescription:
          "List all Gmail labels including system labels (INBOX, STARRED, etc) and user-created labels. Returns label IDs and names.",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to list labels for",
            },
          },
          required: ["userId"],
        },
        passThroughArgs: {
          endpoint: "/gmail/v1/users/me/labels",
          method: "GET",
        },
      }),
      // requires unapproved scope: gmail.modify
      iterateAgentTool.callGoogleAPI({
        overrideName: "createGmailLabel",
        overrideDescription: "Create a new custom Gmail label",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            body: {
              type: "object",
              properties: {
                name: { type: "string", description: "The label name (e.g., 'Work/Important')" },
                labelListVisibility: {
                  type: "string",
                  enum: ["labelShow", "labelShowIfUnread", "labelHide"],
                  description: "Show label in label list (default: labelShow)",
                },
                messageListVisibility: {
                  type: "string",
                  enum: ["show", "hide"],
                  description: "Show label in message list (default: show)",
                },
              },
              required: ["name"],
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to create labels for",
            },
          },
          required: ["body", "userId"],
        },
        passThroughArgs: {
          endpoint: "/gmail/v1/users/me/labels",
          method: "POST",
        },
      }),
      // requires unapproved scope: gmail.modify
      iterateAgentTool.callGoogleAPI({
        overrideName: "deleteGmailLabel",
        overrideDescription:
          "Delete a custom Gmail label. Cannot delete system labels like INBOX, STARRED, etc.",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            pathParams: {
              type: "object",
              properties: {
                labelId: {
                  type: "string",
                  description: "The ID of the label to delete (from listGmailLabels)",
                },
              },
              required: ["labelId"],
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to delete labels for",
            },
          },
          required: ["pathParams", "userId"],
        },
        passThroughArgs: {
          endpoint: "/gmail/v1/users/me/labels/[labelId]",
          method: "DELETE",
        },
      }),
    ],
  },
  {
    key: "google-calendar-tools",
    prompt: dedent`
      You have access to Google Calendar tools to create, read, and manage calendar events.

      When creating events:
      - Always specify a clear title and time
      - Use ISO 8601 format for dates and times (e.g., '2024-12-25T10:00:00-08:00')
      - Set reasonable defaults (e.g., 30 min duration if not specified)

      When listing events:
      - By default, recurring events are shown compactly with recurrence rules (saves tokens)
      - Only set singleEvents="true" and orderBy="startTime" if you need each occurrence separately
      - Use appropriate time ranges to avoid overwhelming results
    `,
    match: matchers.and(matchers.forAgentClass("SlackAgent"), matchers.hasLabel("GCALENDAR")),
    tools: [
      iterateAgentTool.callGoogleAPI({
        overrideName: "createCalendarEvent",
        overrideDescription: "Create a new event in Google Calendar",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            body: {
              type: "object",
              properties: {
                summary: { type: "string", description: "Event title" },
                description: { type: "string", description: "Event description" },
                start: {
                  type: "object",
                  properties: {
                    dateTime: {
                      type: "string",
                      description:
                        "Start time in ISO 8601 format (e.g., '2024-12-25T10:00:00-08:00')",
                    },
                    timeZone: {
                      type: "string",
                      description: "Time zone (e.g., 'America/Los_Angeles')",
                    },
                  },
                  required: ["dateTime"],
                },
                end: {
                  type: "object",
                  properties: {
                    dateTime: {
                      type: "string",
                      description:
                        "End time in ISO 8601 format (e.g., '2024-12-25T11:00:00-08:00')",
                    },
                    timeZone: {
                      type: "string",
                      description: "Time zone (e.g., 'America/Los_Angeles')",
                    },
                  },
                  required: ["dateTime"],
                },
                attendees: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { email: { type: "string" } },
                    required: ["email"],
                  },
                  description: "List of attendee emails",
                },
              },
              required: ["summary", "start", "end"],
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to create events for",
            },
          },
          required: ["body", "userId"],
        },
        passThroughArgs: {
          endpoint: "/calendar/v3/calendars/primary/events",
          method: "POST",
        },
      }),
      iterateAgentTool.callGoogleAPI({
        overrideName: "listCalendarEvents",
        overrideDescription:
          "List upcoming events from Google Calendar. IMPORTANT: Always set maxResults to a small number (5-20) to avoid overwhelming responses.",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            queryParams: {
              type: "object",
              properties: {
                timeMin: {
                  type: "string",
                  description: "Start time in ISO 8601 format (default: now)",
                },
                timeMax: { type: "string", description: "End time in ISO 8601 format" },
                maxResults: {
                  type: "string",
                  description:
                    "Maximum number of events to return. Use 5-20 to avoid overwhelming responses.",
                },
                q: { type: "string", description: "Free text search query" },
                singleEvents: {
                  type: "string",
                  description:
                    "Set to 'true' to expand recurring events into separate instances. Omit or use 'false' to show recurring events compactly with recurrence rules.",
                },
                orderBy: {
                  type: "string",
                  description:
                    "Set to 'startTime' for chronological order (only works when singleEvents='true'). Otherwise omit.",
                },
              },
              required: ["maxResults"],
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to list events for",
            },
          },
          required: ["queryParams", "userId"],
        },
        passThroughArgs: {
          endpoint: "/calendar/v3/calendars/primary/events",
          method: "GET",
        },
      }),
      iterateAgentTool.callGoogleAPI({
        overrideName: "updateCalendarEvent",
        overrideDescription: "Update an existing calendar event",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            pathParams: {
              type: "object",
              properties: {
                eventId: { type: "string", description: "The ID of the event to update" },
              },
              required: ["eventId"],
            },
            body: {
              type: "object",
              properties: {
                summary: { type: "string", description: "New event title" },
                description: { type: "string", description: "New event description" },
                start: {
                  type: "object",
                  properties: {
                    dateTime: { type: "string", description: "Start time in ISO 8601 format" },
                  },
                },
                end: {
                  type: "object",
                  properties: {
                    dateTime: { type: "string", description: "End time in ISO 8601 format" },
                  },
                },
              },
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to update events for",
            },
          },
          required: ["pathParams", "body", "userId"],
        },
        passThroughArgs: {
          endpoint: "/calendar/v3/calendars/primary/events/[eventId]",
          method: "PATCH",
        },
      }),
      iterateAgentTool.callGoogleAPI({
        overrideName: "deleteCalendarEvent",
        overrideDescription: "Delete a calendar event",
        overrideInputJSONSchema: {
          type: "object",
          properties: {
            pathParams: {
              type: "object",
              properties: {
                eventId: { type: "string", description: "The ID of the event to delete" },
              },
              required: ["eventId"],
            },
            impersonateUserId: {
              type: "string",
              description: "The ID of the user to delete events for",
            },
          },
          required: ["pathParams", "userId"],
        },
        passThroughArgs: {
          endpoint: "/calendar/v3/calendars/primary/events/[eventId]",
          method: "DELETE",
        },
      }),
    ],
  },
  {
    key: "sandbox-attached",
    prompt: dedent`
      The sandbox is currently running and attached.
      You can execute commands immediately using the exec tool.
    `,
    match: matchers.sandboxStatus("attached"),
  },
  {
    key: "external-users-present",
    prompt: dedent`
      ⚠️ External Slack Connect users may be present in this conversation.

      - Avoid sharing internal company information
      - Don't discuss internal metrics, roadmaps, or confidential matters
      - Treat all discussions as public-facing
      - If a true member of the slack workspace tells you it's okay to do something for an external user, then you can do it
    `,
    match: matchers.slackChannelHasExternalUsers(true),
  },
]);
