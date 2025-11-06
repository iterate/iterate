import { permalink as getPermalink } from "braintrust/browser";
import { z } from "zod";

import { and, eq, like } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { estateProtectedProcedure, protectedProcedure, router } from "../trpc/trpc.ts";
import { agentInstance } from "../db/schema.ts";
// import { env } from "../../env.ts";
import { normalizeNullableFields } from "../utils/type-helpers.ts";
import {
  AgentCoreEvent,
  FileSharedEvent,
  type AugmentedCoreReducedState,
} from "./agent-core-schemas.ts";
import { IterateAgent } from "./iterate-agent.ts";
import { MCPEvent } from "./mcp/mcp-slice.ts";
import { SlackSliceEvent } from "./slack-slice.ts";
import {
  AGENT_CLASS_NAMES,
  getAgentStubByName,
  getOrCreateAgentStubByRoute,
} from "./agents/stub-getters.ts";

export type AgentEvent = (AgentCoreEvent | SlackSliceEvent) & {
  eventIndex: number;
  createdAt: string;
};

/** operate on an existing agent - throws  */
const agentStubProcedure = estateProtectedProcedure
  .input(
    z.object({
      agentInstanceName: z.string().describe("The durable object name for the agent instance"),
      agentClassName: z
        .enum(AGENT_CLASS_NAMES)
        .default("IterateAgent")
        .describe("The class name of the agent"),
      reason: z.string().describe("The reason for creating/getting the agent stub").optional(),
    }),
  )
  .use(async ({ input, ctx, next }) => {
    const estateId = input.estateId;

    const agent = await getAgentStubByName(input.agentClassName, {
      db: ctx.db,
      agentInstanceName: input.agentInstanceName,
      estateId,
    }).catch((err) => {
      // todo: effect!
      if (String(err).includes("not found")) {
        throw new TRPCError({ code: "NOT_FOUND", message: String(err), cause: err });
      }
      throw err;
    });

    // agent.getEvents() is "never" at this point because of cloudflare's helpful type restrictions. we want it to be correctly inferred as "some subclass of IterateAgent"

    return next({
      ctx: {
        ...ctx,
        agent: agent as {} as Omit<typeof agent, "getEvents"> & {
          // todo: figure out why cloudflare doesn't like the return type of getEvents - it neverifies it becaue of something that can't cross the boundary?
          // although this is still useful anyway, to help remind us to always call `await` even though if calling getEvents in-process, it's synchronous
          getEvents: () => Promise<ReturnType<IterateAgent["getEvents"]>>;
        },
      },
    });
  });

export const AllAgentEventInputSchemas = z.union([
  AgentCoreEvent,
  FileSharedEvent,
  SlackSliceEvent as unknown as z.ZodNever, // too complex for typescirpt to handle
  MCPEvent,
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

  list: estateProtectedProcedure
    .input(
      z.object({
        agentNameLike: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions = [eq(agentInstance.estateId, input.estateId)];
      if (input.agentNameLike) {
        conditions.push(like(agentInstance.durableObjectName, input.agentNameLike));
      }
      return await ctx.db.query.agentInstance.findMany({
        where: and(...conditions),
      });
    }),

  getOrCreateAgent: estateProtectedProcedure
    .input(
      z.object({
        route: z.string(),
        agentClassName: z.enum(AGENT_CLASS_NAMES),
        reason: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { agentClassName, ...createParams } = input;
      const agentStub = await getOrCreateAgentStubByRoute(agentClassName, {
        db: ctx.db,
        ...createParams,
      });
      return { info: await agentStub.getHydrationInfo() };
    }),

  getState: agentStubProcedure
    .meta({ description: "Get the state of an agent instance" })
    // .output(
    //   z.object({
    //     events: z.array(AllAgentEventInputSchemas),
    //     databaseRecord: z.any(),
    //   }),
    // )
    .query(async ({ ctx }) => {
      const events = await ctx.agent.getEvents();
      return { events, databaseRecord: await ctx.agent.databaseRecord };
    }),

  getEvents: agentStubProcedure
    .meta({ description: "Get the events of an agent instance" })
    .query(async ({ ctx }) => {
      return (await ctx.agent.getEvents()) as AgentEvent[];
    }),

  getAgentDebugURL: agentStubProcedure.query(async ({ ctx }) => {
    return ctx.agent.getAgentDebugURL();
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

  exportTrace: agentStubProcedure
    .meta({ description: "Export agent trace to a downloadable archive" })
    .output(z.object({ downloadUrl: z.string() }))
    .mutation(async ({ ctx }) => {
      const downloadUrl = await ctx.agent.exportTrace({
        user: normalizeNullableFields(ctx.user),
      });
      return { downloadUrl };
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
      // cast to avoid "type instantiation is excessively deep and possibly infinite" error
      return (await (ctx.agent.getReducedStateAtEventIndex as Function)(
        input.eventIndex,
      )) as AugmentedCoreReducedState;
    }),

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
      }),
    )
    .mutation(async ({ input, ctx }) => {
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

      if (input.toolSpecs.length > 0) {
        events.push({
          type: "CORE:ADD_TOOL_SPECS",
          data: {
            specs: input.toolSpecs,
          },
        });
      }

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
});
