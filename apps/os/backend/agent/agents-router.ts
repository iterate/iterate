import { permalink as getPermalink } from "braintrust/browser";
import { z } from "zod/v4";

import { protectedProcedure, router } from "../trpc/trpc.ts";
import { AgentCoreEventInput, FileSharedEventInput } from "./agent-core-schemas.ts";
// import type { MergedEventForSlices } from "./agent-core.ts";
import { getAgentStub, listAgents } from "./agent-stub-utils.ts";
import { defaultContextRules } from "./default-context-rules.ts";
// import { MCPEventInput } from "./mcp-slice.ts";
// import type { SlackAgentSlices } from "./slack-agent.ts";
// import { SlackEventInput } from "./slack-slice.ts";
// import type { IterateAgentState } from "./iterate-agent.ts";

const agentStubProcedure = protectedProcedure
  .input(
    z.object({
      estateId: z.string().describe("The estate this agent belongs to"),
      agentInstanceName: z.string().describe("The durable object name for the agent instance"),
      agentClassName: z
        .enum(["IterateAgent", "SlackAgent"])
        .default("IterateAgent")
        .describe("The class name of the agent"),
      reason: z.string().describe("The reason for getting the agent stub").optional(),
      createIfNotExists: z.boolean().optional().default(true),
      routingKeys: z.array(z.string()).optional().default([]),
    }),
  )
  .use(async ({ input, ctx, next }) => {
    const estateId = input.estateId;
    const agent = await getAgentStub(ctx.db, {
      estateId,
      className: input.agentClassName,
      durableObjectName: input.agentInstanceName,
      createIfNotExists: input.createIfNotExists,
      routingKeys: input.routingKeys,
      reason: input.reason,
      metadata: input.reason ? { reason: input.reason } : undefined,
    });
    return next({ ctx: { ...ctx, agent } });
  });

// Define a schema for context rules
// TODO not sure why this is here and not in context.ts ...
const ContextRule = z.object({
  id: z.string(),
  description: z.string().optional(),
  prompt: z.any().optional(),
  tools: z.array(z.any()).optional().default([]),
  match: z.union([z.array(z.any()), z.any()]).optional(),
});

export const AllAgentEventInputSchemas = z.union([
  AgentCoreEventInput,
  FileSharedEventInput,
  // SlackEventInput,
  // MCPEventInput,
]);
export type AllAgentEventInputs = z.input<typeof AllAgentEventInputSchemas>;

// These are mostly needed for trpc vitest e2e tests. The UI uses websockets
export const agentsRouter = router({
  health: protectedProcedure
    .meta({ description: "Health check for the agent service" })
    .query(() => ({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "agent",
    })),

  list: protectedProcedure
    .input(
      z.object({
        estateId: z.string(),
        agentClassName: z.enum(["IterateAgent", "SlackAgent"]).optional(),
        routingKey: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const agents = await listAgents(ctx.db, {
        estateId: input.estateId,
        className: input.agentClassName,
        routingKey: input.routingKey,
      });
      return agents;
    }),

  listContextRules: protectedProcedure
    .meta({ description: "List all context rules available in the estate" })
    .output(z.array(ContextRule))
    .query(async () => {
      // const dbRules = await db.query.contextRules.findMany();
      // const rulesFromDb = dbRules.map((r) => r.serializedRule);
      const rulesFromDb: z.infer<typeof ContextRule>[] = [];
      // Merge and dedupe rules by slug, preferring the first occurrence (defaultContextRules first)
      const allRules = [...(await defaultContextRules()), ...rulesFromDb];
      const seenSlugs = new Set<string>();
      const dedupedRules = allRules.filter((rule) => {
        if (typeof rule.id !== "string") {
          return false;
        }
        if (seenSlugs.has(rule.id)) {
          return false;
        }
        seenSlugs.add(rule.id);
        return true;
      });
      return dedupedRules;
    }),

  // replaceEstateSpecificContextRules: protectedProcedure
  //   .input(z.array(ContextRule))
  //   .mutation(async ({ input }) => {
  //     // Insert the new context rules
  //     const rulesToInsert = input.map((rule) => ({
  //       slug: rule.id,
  //       serializedRule: rule,
  //     })) satisfies (typeof contextRules.$inferInsert)[];
  //     await db.batch([
  //       db.delete(contextRules),
  //       ...(rulesToInsert.length > 0 ? [db.insert(contextRules).values(rulesToInsert)] : []),
  //     ]);
  //     console.log(`${rulesToInsert.length} rules replaced!`);

  //     return {
  //       success: true,
  //       rulesReplaced: rulesToInsert.length,
  //     };
  //   }),
  // getAgentById: protectedProcedure
  //   .meta({ description: "Get the name of an agent instance by its id" })
  //   .input(z.object({ id: z.string() }))
  //   .query(async ({ input, ctx }) => {
  //     const agentRecord = await getPersistedAgentById(input.id, {
  //       db: db,
  //       table: durableObjectInstances,
  //       reason: `${ctx.c.req.method} ${ctx.c.req.path}`,
  //     });
  //     if (!agentRecord) {
  //       throw new Error(`Agent with ID ${input.id} not found`);
  //     }
  //     return agentRecord;
  //   }),

  getState: agentStubProcedure
    .meta({ description: "Get the state of an agent instance" })
    .output(
      z.object({
        events: z.array(AllAgentEventInputSchemas),
        databaseRecord: z.any(),
      }),
    )
    .query(async ({ ctx }) => {
      const events = await ctx.agent.getEvents();
      return { events, databaseRecord: await ctx.agent.getDatabaseRecord() };
    }),

  setBraintrustParentSpanExportedId: agentStubProcedure
    .meta({ description: "Set the braintrust span exported id for an agent instance" })
    .input(
      z.object({
        braintrustParentSpanExportedId: z
          .string()
          .optional()
          .describe("The braintrust span exported id"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await ctx.agent.setBraintrustParentSpanExportedId(input.braintrustParentSpanExportedId);
    }),

  getBraintrustPermalink: agentStubProcedure
    .meta({ description: "Get the braintrust permalink for an agent instance" })
    .output(z.object({ permalink: z.string().optional() }))
    .query(async ({ ctx }) => {
      const braintrustParentSpanExportedId = await ctx.agent.getBraintrustParentSpanExportedId();
      if (!braintrustParentSpanExportedId) {
        return {};
      }
      const permalink = await getPermalink(braintrustParentSpanExportedId);
      return { permalink };
    }),

  addEvents: agentStubProcedure
    .meta({ description: "Add one or more events to an agent instance" })
    .input(
      z.object({
        events: z.array(AllAgentEventInputSchemas),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Some dangerous casting since the stub doesn't know about slice event types
      const events = await ctx.agent.addEvents(input.events as []);
      return events;
      // return events as {}[] as MergedEventForSlices<SlackAgentSlices>[];
    }),

  getReducedStateAtEventIndex: agentStubProcedure
    .meta({ description: "Get the reduced state of an agent at a specific update ID" })
    .input(
      z.object({
        eventIndex: z.number().describe("The event index to get the reduced state at"),
      }),
    )
    .query(async ({ ctx, input }) => {
      return await ctx.agent.getReducedStateAtEventIndex(input.eventIndex);
    }),

  // listAgentInstances: protectedProcedure
  //   .input(
  //     z.object({
  //       limit: z.number().optional().default(50),
  //       offset: z.number().optional().default(0),
  //     }),
  //   )
  //   .query(async ({ input }) => {
  //     const instances = await listPersistedAgents({
  //       db,
  //       table: durableObjectInstances,
  //       ...input,
  //     });

  //     return {
  //       instances,
  //       total: instances.length,
  //     };
  //   }),

  injectToolCall: agentStubProcedure
    .meta({
      description: "Inject a tool call directly into an agent instance",
    })
    .input(
      z.object({
        toolName: z.string().describe("The name of the tool to call"),
        args: z.any().describe("The arguments to pass to the tool"),
        triggerLLMRequest: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to trigger an LLM request after the tool call"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return await ctx.agent.injectToolCall({
        toolName: input.toolName,
        args: input.args,
        triggerLLMRequest: input.triggerLLMRequest,
      });
    }),

  setAgentConfiguration: agentStubProcedure
    .meta({
      description: "Set agent configuration (system prompt, model options, and tool specs)",
    })
    .input(
      z.object({
        systemPrompt: z.string().describe("System prompt for the agent"),
        model: z.string().describe("Model to use"),
        temperature: z.number().describe("Temperature for the model"),
        toolSpecs: z
          .array(z.any())
          .optional()
          .default([])
          .describe("Tool specifications for the agent"),
        mcpServers: z.array(z.any()).optional().default([]).describe("MCP servers for the agent"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Build the events array
      const events: any[] = [
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: {
            prompt: input.systemPrompt,
          },
        },
        {
          type: "CORE:SET_MODEL_OPTS",
          data: {
            model: input.model,
            temperature: input.temperature,
          },
        },
      ];

      // Add tool specs if provided
      if (input.toolSpecs.length > 0) {
        events.push({
          type: "CORE:ADD_TOOL_SPECS",
          data: {
            specs: input.toolSpecs,
          },
        });
      }

      if (input.mcpServers.length > 0) {
        events.push({
          type: "MCP:ADD_MCP_SERVERS",
          data: {
            servers: input.mcpServers,
          },
        });
      }

      // Send all events
      return await ctx.agent.addEvents(events);
    }),

  remindLater: agentStubProcedure
    .meta({
      description: "Set a reminder for the agent instance",
    })
    .input(
      z.object({
        message: z.string().describe("The content of the reminder"),
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
    )
    .mutation(async ({ input, ctx }) => {
      return await ctx.agent.remindMyselfLater(input);
    }),

  listMyReminders: agentStubProcedure
    .meta({
      description: "List all active reminders for the agent instance",
    })
    .query(async ({ ctx }) => {
      return await ctx.agent.listMyReminders({});
    }),

  cancelReminder: agentStubProcedure
    .meta({
      description: "Cancel a previously set reminder by its ID",
    })
    .input(
      z.object({
        reminderId: z.string().describe("The ID of the reminder to cancel"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return await ctx.agent.cancelReminder({ iterateReminderId: input.reminderId });
    }),

  cancelAllReminders: agentStubProcedure
    .meta({
      description: "Cancel all active reminders for an agent instance",
    })
    .mutation(async ({ ctx }) => {
      const { reminders } = await ctx.agent.listMyReminders({});

      // Cancel each one
      const results = await Promise.all(
        reminders.map((reminder: any) =>
          ctx.agent.cancelReminder({ iterateReminderId: reminder.iterateReminderId }),
        ),
      );

      return {
        cancelledCount: results.filter((r: any) => r.cancelled).length,
        totalCount: reminders.length,
        results,
      };
    }),

  // Check if an agent exists without creating it
  // checkAgentExists: protectedProcedure
  //   .input(
  //     z.object({
  //       agentInstanceName: z.string(),
  //       agentClassName: z.string(),
  //     }),
  //   )
  //   .query(async ({ input }) => {
  //     const { agentInstanceName, agentClassName } = input;

  //     const exists = await checkPersistedAgentWithNameExists(agentInstanceName, agentClassName, {
  //       db,
  //       table: durableObjectInstances,
  //     });

  //     return { exists };
  //   }),
});
