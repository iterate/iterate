import { Agent as CloudflareAgent } from "agents";
import { formatDistanceToNow } from "date-fns";
import { z } from "zod/v4";

// Parent directory imports
import { and, eq } from "drizzle-orm";
import * as R from "remeda";
import { env, type CloudflareEnv } from "../../env.ts";
import { getDb, schema, type DB } from "../db/client.ts";
import { PosthogCloudflare } from "../utils/posthog-cloudflare.ts";
import type { JSONSerializable } from "../utils/type-helpers.ts";

// Local imports
import { agentInstance, agentInstanceRoute } from "../db/schema.ts";
export type AgentInstanceDatabaseRecord = typeof agentInstance.$inferSelect & {
  contextRules: ContextRule[];
};
import {
  AgentCore,
  type AgentCoreDeps,
  type AgentCoreSlice,
  type MergedDepsForSlices,
  type MergedEventForSlices,
  type MergedEventInputForSlices,
  type MergedStateForSlices,
} from "./agent-core.ts";
import {
  AgentCoreEvent,
  type AddContextRulesEvent,
  type AugmentedCoreReducedState,
} from "./agent-core-schemas.ts";
import type { DOToolDefinitions } from "./do-tools.ts";
import {
  runMCPEventHooks,
  handleMCPConnectRequest,
  mcpManagerCache,
} from "./mcp/mcp-event-hooks.ts";
import { mcpSlice, getConnectionKey } from "./mcp/mcp-slice.ts";
import { MCPConnectRequestEventInput } from "./mcp/mcp-slice.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { openAIProvider } from "./openai-client.ts";
import { renderPromptFragment } from "./prompt-fragments.ts";
import type { ToolSpec } from "./tool-schemas.ts";
import { toolSpecsToImplementations } from "./tool-spec-to-runtime-tool.ts";
import { defaultContextRules } from "./default-context-rules.ts";
import type { ContextRule } from "./context-schemas.ts";
import type { MCPServer } from "./tool-schemas.ts";

// Commented imports (preserved for reference)
// import { getAgentDebugUri } from "./posthog-utils.ts";
// import { uploadFile } from "./files/hono-handlers.ts";
// import { processPosthogAgentCoreEvent } from "./posthog-event-processor.ts";
// import { PlatformPosthog } from "./posthog.ts";
// import { trpcCallableBuilder } from "../legacy-agent/trpc/callable-builders.ts";

// -----------------------------------------------------------------------------
// Core slice definition – *always* included for any IterateAgent variant.
// Additional agent-specific slices should extend this array via class inheritance.
// -----------------------------------------------------------------------------

export const CORE_AGENT_SLICES = [mcpSlice] as const;

/**
 * Helper type representing the core slices bundled with every IterateAgent.
 */
export type CoreAgentSlices = typeof CORE_AGENT_SLICES;

const EventRow = z.object({
  type: z.string(),
  data_json: z.string(),
  metadata_json: z.string(),
  trigger_llm_request: z.number(),
  created_at: z.string(),
  event_index: z.number(),
  idempotency_key: z.string().nullable(),
});

const EventRows = z.array(EventRow);

export type EventRow = z.infer<typeof EventRow>;

/**
 * Utility type for merging two readonly slice arrays while preserving the tuple
 * element types.
 */
export type MergeSlices<Base extends readonly unknown[], Extra extends readonly unknown[]> = [
  ...Base,
  ...Extra,
];

// -----------------------------------------------------------------------------
// Reminder metadata & persisted agent state ------------------------------------
// -----------------------------------------------------------------------------

const ReminderMetadata = z.object({
  // Our own generated ID that we control and use throughout the API
  iterateReminderId: z.string(),
  // The CloudflareAgent SDK's internal task ID - needed for cancellation but not exposed in API
  agentSDKScheduledTaskId: z
    .string()
    .describe("Internal CloudflareAgent scheduler task ID - required for cancelSchedule()"),
  message: z.string(),
  createdAt: z.string().datetime(),
  isRecurring: z.boolean(),
  scheduleDetail: z
    .string()
    .describe("Human-readable schedule info, e.g., cron string or one-time execution time."),
});

type ReminderMetadata = z.infer<typeof ReminderMetadata>;

export const IterateAgentState = z.object({
  reminders: z.record(z.string(), ReminderMetadata).default({}).optional(),
  braintrustParentSpanExportedId: z.string().optional(),
});

export type IterateAgentState = z.infer<typeof IterateAgentState>;

type ToolsInterface = typeof iterateAgentTools.$infer.interface;
type Inputs = typeof iterateAgentTools.$infer.inputTypes;

// -----------------------------------------------------------------------------
// Generic IterateAgentBase -----------------------------------------------------
// -----------------------------------------------------------------------------

/**
 * Generic base class for Iterate Agents.
 *
 * The second generic parameter `Slices` allows subclasses to extend the built-in
 * core slices with their own domain-specific slices while guaranteeing that the
 * core ones are always present.
 */
export class IterateAgent<Slices extends readonly AgentCoreSlice[] = CoreAgentSlices>
  extends CloudflareAgent<CloudflareEnv, IterateAgentState>
  implements ToolsInterface
{
  override observability = undefined;

  // Resolve the DO namespace for the concrete subclass at runtime
  static getNamespace() {
    return env.ITERATE_AGENT;
  }

  // Internal helper to get stub from existing database record
  static async getStubFromDatabaseRecord(
    record: AgentInstanceDatabaseRecord,
    options?: {
      jurisdiction?: DurableObjectJurisdiction;
      locationHint?: DurableObjectLocationHint;
      props?: Record<string, unknown>;
    },
  ) {
    // Stolen from agents SDK
    let namespace = this.getNamespace();
    if (options?.jurisdiction) {
      namespace = namespace.jurisdiction(options.jurisdiction);
    }
    const stub = namespace.getByName(record.durableObjectName, options);

    // right after the constructor runs we get in there and initialise all our stuff
    // (e.g. obtaining a slack access token in the case of a slack agent)
    await stub.initAfterConstructorBeforeOnStart({ record });

    // only now do we do the agents sdk cruft where we hit fetch to initialise party server
    // with a server name
    const req = new Request("http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/");
    req.headers.set("x-partykit-room", record.durableObjectName);
    if (options?.props) {
      req.headers.set("x-partykit-props", JSON.stringify(options?.props));
    }
    await stub
      .fetch(req)
      .then((res) => res.text())
      .catch((e) => {
        console.error("Could not set server name:", e);
      });

    return stub;
  }

  // Get stub for existing agent by name (does not create)
  static async getStubByName(params: { db: DB; agentInstanceName: string }) {
    const { db, agentInstanceName } = params;
    const className = this.name;

    const record = await db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.durableObjectName, agentInstanceName),
        eq(agentInstance.className, className),
      ),
    });
    if (!record) {
      throw new Error(`Agent instance ${agentInstanceName} not found`);
    }
    const contextRules = await this.getRulesFromDB(db, record.estateId);

    return this.getStubFromDatabaseRecord({ ...record, contextRules });
  }

  // Get stubs for agents by routing key (does not create)
  static async getStubsByRoute(params: { db: DB; routingKey: string; estateId?: string }) {
    const { db, routingKey, estateId } = params;
    const className = this.name;

    const routes = await db.query.agentInstanceRoute.findMany({
      where: eq(agentInstanceRoute.routingKey, routingKey),
      with: { agentInstance: { with: { estate: { with: { iterateConfigs: true } } } } },
    });

    const matchingAgents = routes
      .map((r) => r.agentInstance)
      .filter((r) => r.className === className && (!estateId || r.estateId === estateId));

    if (matchingAgents.length > 1) {
      throw new Error(`Multiple agents found for routing key ${routingKey}`);
    }

    const stubs = await Promise.all(
      matchingAgents.map((record) =>
        this.getStubFromDatabaseRecord({
          ...record,
          contextRules: record.estate.iterateConfigs[0].config.contextRules ?? [],
        }),
      ),
    );

    return stubs as unknown[] as DurableObjectStub<IterateAgent>[];
  }

  // Get or create stub by name
  static async getOrCreateStubByName(params: {
    db: DB;
    estateId: string;
    agentInstanceName: string;
    reason?: string;
  }) {
    const { db, estateId, agentInstanceName, reason } = params;
    const className = this.name;

    let record = await db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.durableObjectName, agentInstanceName),
        eq(agentInstance.className, className),
      ),
    });

    if (!record) {
      const durableObjectId = this.getNamespace().idFromName(agentInstanceName);
      const [inserted] = await db
        .insert(agentInstance)
        .values({
          estateId,
          className,
          durableObjectName: agentInstanceName,
          durableObjectId: durableObjectId.toString(),
          metadata: { reason },
        })
        .onConflictDoUpdate({
          target: agentInstance.durableObjectId,
          set: {
            metadata: { reason },
          },
        })
        .returning();
      record = inserted;
    } else {
      if (record.estateId !== estateId) {
        throw new Error(`Agent instance ${agentInstanceName} already exists in a different estate`);
      }
    }
    const contextRules = await this.getRulesFromDB(db, estateId);

    return this.getStubFromDatabaseRecord({ ...record, contextRules });
  }

  // Get or create stub by route
  static async getOrCreateStubByRoute(params: {
    db: DB;
    estateId: string;
    agentInstanceName: string;
    route: string;
    reason?: string;
  }) {
    const { db, estateId, agentInstanceName, route, reason } = params;

    // First check if an agent already exists for this route
    const existingRoutes = await db.query.agentInstanceRoute.findMany({
      where: eq(agentInstanceRoute.routingKey, route),
      with: { agentInstance: true },
    });
    const contextRules = await this.getRulesFromDB(db, estateId);

    const existingAgent = existingRoutes
      .map((r) => r.agentInstance)
      .find((r) => r.className === this.name && r.estateId === estateId);

    if (existingAgent) {
      return this.getStubFromDatabaseRecord({ ...existingAgent, contextRules });
    }

    // No existing agent for this route, create one with route
    const durableObjectId = this.getNamespace().idFromName(agentInstanceName);
    const [record] = await db
      .insert(agentInstance)
      .values({
        estateId,
        className: this.name,
        durableObjectName: agentInstanceName,
        durableObjectId: durableObjectId.toString(),
        metadata: { reason },
      })
      .onConflictDoUpdate({
        target: agentInstance.durableObjectId,
        set: {
          metadata: { reason },
        },
      })
      .returning();

    // Create the route association
    await db
      .insert(agentInstanceRoute)
      .values({ agentInstanceId: record.id, routingKey: route })
      .onConflictDoNothing();

    return this.getStubFromDatabaseRecord({
      ...record,
      contextRules,
    });
  }

  static async getRulesFromDB(db: DB, estateId: string): Promise<ContextRule[]> {
    const config = await db.query.iterateConfig.findFirst({
      where: eq(schema.iterateConfig.estateId, estateId),
    });
    return config?.config?.contextRules ?? [];
  }

  protected db: DB;
  // Runtime slice list – inferred from the generic parameter.
  agentCore!: AgentCore<Slices, CoreAgentSlices>;
  databaseRecord!: AgentInstanceDatabaseRecord;

  // This gets run between the synchronous durable object constructor and the asynchronous onStart method of the agents SDK
  async initAfterConstructorBeforeOnStart(params: { record: AgentInstanceDatabaseRecord }) {
    const { record } = params;
    this.databaseRecord = record;
  }

  initialState = {
    reminders: {},
  };

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.db = getDb();
    // DO NOT CHANGE THE SCHEMA WITHOUT UPDATING THE MIGRATION LOGIC
    // If you need to change the schema, you can add more columns with separate statements
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_events (
        event_index INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        trigger_llm_request INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT,
        data_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      )
    `;

    this.sql`CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_agent_events_created_at ON agent_events(created_at)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_agent_events_idempotency ON agent_events(idempotency_key) WHERE idempotency_key IS NOT NULL`;

    this.agentCore = this.initAgentCore();
    this.sql`create table if not exists swr_cache (key text primary key, json text)`;
  }

  private posthog: PosthogCloudflare | undefined = undefined;
  private getPosthogClient() {
    if (!this.posthog) {
      this.posthog = new PosthogCloudflare(this.ctx, { estate: "some estate", environment: "dev" });
    }
    return this.posthog;
  }

  /**
   * Get all slices for this agent. This method must be overridden by subclasses
   * to return the correct statically-typed slice array.
   */
  protected getSlices(): Slices {
    // Default implementation returns just the core slices.
    // Subclasses MUST override this to return their full slice array.
    return CORE_AGENT_SLICES as unknown as Slices;
  }

  toolDefinitions(): DOToolDefinitions<{}> {
    return iterateAgentTools;
  }

  /**
   * Initialize the AgentCore with dependencies. This method can be overridden
   * by subclasses to provide additional dependencies.
   */
  protected initAgentCore(): AgentCore<Slices, CoreAgentSlices> {
    const slices = this.getSlices();
    const _posthogClient = this.getPosthogClient();

    const baseDeps: AgentCoreDeps = {
      getRuleMatchData: (state) => ({
        agentCoreState: state,
        durableObjectClassName: this.constructor.name,
      }),
      storeEvents: (events: ReadonlyArray<AgentCoreEvent>) => {
        // Insert SQL is sync so fine to just iterate
        for (const event of events) {
          this.sql`
            INSERT OR REPLACE INTO agent_events (
              event_index, event_type, created_at, 
              trigger_llm_request, idempotency_key, data_json, metadata_json
            ) VALUES (
              ${event.eventIndex},
              ${event.type},
              ${event.createdAt},
              ${typeof event.triggerLLMRequest === "boolean" ? Number(event.triggerLLMRequest) : 0},
              ${event.idempotencyKey || null},
              ${JSON.stringify(event.data)},
              ${JSON.stringify(event.metadata || {})}
            )
          `;
        }

        // Update state to trigger broadcast to connected clients
        this.setState({
          reminders: this.state.reminders ?? {},
          braintrustParentSpanExportedId: this.state.braintrustParentSpanExportedId,
        });

        // Broadcast the new events to all connected clients
        try {
          this.broadcast(
            JSON.stringify({
              type: "events_added",
              events: events,
              timestamp: Date.now(),
            }),
          );
        } catch (error) {
          console.warn("Failed to broadcast events:", error);
        }
      },

      background: (fn: () => Promise<void>) => {
        this.ctx.waitUntil(fn());
      },

      getOpenAIClient: async () => {
        return await openAIProvider({
          posthog: {
            traceId: this.name,
          },
          env: {
            BRAINTRUST_API_KEY: this.env.BRAINTRUST_API_KEY,
            OPENAI_API_KEY: this.env.OPENAI_API_KEY,
            POSTHOG_PUBLIC_KEY: this.env.POSTHOG_PUBLIC_KEY,
          },
          projectName: `iterate-platform`,
          braintrustParentSpanExportedId: this.state.braintrustParentSpanExportedId,
        });
      },

      toolSpecsToImplementations: (specs: ToolSpec[]) => {
        return toolSpecsToImplementations({ toolSpecs: specs, theDO: this });
      },
      // TODO: somebody who understands this more than me needs to fix this type
      // @ts-expect-error
      uploadFile: async (_data: {
        ctx: ExecutionContext;
        content: ReadableStream;
        filename: string;
        mimeType?: string;
        contentLength: number;
      }) => {
        throw new Error(
          "uploadFile is not implemented yet - it's only relevant for openai native image generation anyway",
        );
        // // Cloudflare needs to know the content length in advance, so we need to create a fixed-length stream
        // const fileRecord = await uploadFile({
        //   stream: data.content,
        //   contentLength: data.contentLength,
        //   filename: data.filename,
        //   contentType: data.mimeType || "application/octet-stream",
        // });
        // return {
        //   fileId: fileRecord.iterateId,
        //   openAIFileId: fileRecord.openAIFileId,
        //   originalFilename: fileRecord.filename,
        //   size: fileRecord.fileSize,
        //   mimeType: fileRecord.mimeType,
        // };
      },

      turnFileIdIntoPublicURL: (fileId: string) => {
        return `${this.env.VITE_PUBLIC_URL}/api/uploads/${fileId}`;
      },

      getFinalRedirectUrl: async <S>(payload: {
        durableObjectInstanceName: string;
        reducedState: S;
      }) => {
        return `${this.env.VITE_PUBLIC_URL}/agents/IterateAgent/${payload.durableObjectInstanceName}`;
      },

      // Wrap the default console so every call is also sent to connected websocket clients
      console: (() => {
        // we're going to jettison this soon
        return console;
      })(),

      onEventAdded: ({ event: _event, reducedState: _reducedState }) => {
        const event = _event as MergedEventForSlices<Slices>;
        const reducedState = _reducedState as MergedStateForSlices<CoreAgentSlices>;
        // Handle MCP side effects for relevant events
        const mcpRelevantEvents = ["MCP:CONNECT_REQUEST", "MCP:DISCONNECT_REQUEST"] as const;
        type MCPRelevantEvent = (typeof mcpRelevantEvents)[number];

        if (mcpRelevantEvents.includes(event.type as string as MCPRelevantEvent)) {
          const mcpEvent = event as Extract<typeof event, { type: MCPRelevantEvent }>; // ideally typescript would narrow this for us but `.includes(...)` is annoying/badly implemented. ts-reset might help
          this.ctx.waitUntil(
            (async () => {
              if (reducedState.mcpConnections) {
                const eventsToAdd = await runMCPEventHooks({
                  event: mcpEvent,
                  reducedState,
                  agentDurableObjectId: this.ctx.id.toString(),
                  agentDurableObjectName: this.name,
                  getFinalRedirectUrl: deps.getFinalRedirectUrl!,
                });

                for (const eventToAdd of eventsToAdd) {
                  await this.agentCore.addEvent(eventToAdd);
                }
              }
            })(),
          );
        }

        if (event.type === "CORE:LLM_REQUEST_END") {
          // fairly arbitrarily, refresh context rules after each LLM request so the agent will have updated instructions by next time
          // but we shouldn't rely on this - we listen for relevant webhooks and refresh events when they actually change
          // https://docs.slack.dev/reference/events/user_typing/ might also be an interesting source of events to trigger this that doesn't require additional dependencies/webhooks/polling
          this.ctx.waitUntil(this.refreshContextRules());
        }

        //   // this.ctx.waitUntil(
        //     /**
        //      * Initially we wanted to publish this payload onto the event bus and then consume it in worker.ts with processPosthogEvent
        //      *
        //      * Unfortunately we hit an issue with the CloudFlare workerd process behaving in an unexpected manner, where fetch() calls would never resolve
        //      * and so both posthog and braintrust calls would break.
        //      *
        //      * We suspect this is related to the way that durable objects handle their own liveliness when handing off to a worker via RPC or Event Queues,
        //      * causing async work like promises and timers to never process.
        //      *
        //      * For more details read this thread:
        //      * https://iterate-com.slack.com/archives/C06LU7PGK0S/p1754985703369859
        //      */
        //     // processPosthogAgentCoreEvent(posthogClient, {
        //     //   event: `AGENT_CORE_EVENT_ADDED`,
        //     //   data: {
        //     //     event,
        //     //     reducedState,
        //     //     className: this.constructor.name,
        //     //     // TODO we don't have the agent instance name here - in the future we will.
        //     //     // But for now I'm just using the ID to identify the agent instance.
        //     //     // I think Rahul has some witchcraft in the works to get us the name
        //     //     agentInstanceName: this.name,
        //     //     agentDebugURL: getAgentDebugUri({
        //     //       durableObjectName: this.name,
        //     //       agentClassName: this.constructor.name,
        //     //     }),
        //     //   },
        //     //   source: {
        //     //     service: "platform",
        //     //   },
        //     // }),
        //   // );
      },
    };

    const extraDeps = this.getExtraDependencies(baseDeps);
    const deps = { ...baseDeps, ...extraDeps } as MergedDepsForSlices<Slices>;

    return new AgentCore({
      deps: deps,
      slices: slices,
    });
  }

  /**
   * Override this method in subclasses to provide additional dependencies
   * for the AgentCore.
   *
   * We pass in the original deps, so that we can hook into existing dependencies
   * and add additional functionality but maintain the old logic.
   */
  protected getExtraDependencies(_deps: AgentCoreDeps): Partial<MergedDepsForSlices<Slices>> {
    return {};
  }

  async getAddContextRulesEvent(): Promise<AddContextRulesEvent> {
    const rules = await this.getContextRules();
    return {
      type: "CORE:ADD_CONTEXT_RULES",
      data: { rules },
      metadata: {},
      triggerLLMRequest: false,
      createdAt: new Date().toISOString(),
      eventIndex: this.getEvents().length,
    } satisfies AgentCoreEvent;
  }

  async refreshContextRules() {
    const event = await this.getAddContextRulesEvent();
    const existingRules = this.agentCore.state.contextRules;
    const upToDate = event.data.rules.every((r) => R.isDeepEqual(r, existingRules[r.key]));
    if (!upToDate) {
      this.addEvent(event); // only worth adding if it's going to have an effect
    }
  }

  /**
   * Called after an agent object in constructed and the state has been loaded from the DO store.
   */
  async onStart(): Promise<void> {
    // Call parent onStart to ensure persistence completes
    await super.onStart();
    const event = this.getEvents();
    if (event.length === 0) {
      // new agent, fetch initial context rules, along with tool schemas etc.
      event.push(await this.getAddContextRulesEvent());
    }
    await this.agentCore.initializeWithEvents(event);

    this.setState({
      ...this.state,
      reminders: this.state.reminders ?? {},
    });
  }

  getEvents(): MergedEventForSlices<Slices>[] {
    const rawEvents = this.sql`
      SELECT 
        event_type as type,
        data_json,
        metadata_json,
        trigger_llm_request,
        created_at,
        event_index,
        idempotency_key
      FROM agent_events 
      ORDER BY event_index ASC
    `;
    return parseEventRows(rawEvents) as MergedEventForSlices<Slices>[];
  }

  /**
   * Get events filtered by type with proper type casting.
   * This is more efficient than fetching all events and filtering in memory.
   *
   * @param eventType The event type to filter by
   * @returns Array of events of the specified type
   *
   * @example
   * // Get all Slack webhook events with proper typing
   * const slackEvents = agent.getEventsByType("SLACK:WEBHOOK_EVENT_RECEIVED");
   * // slackEvents is properly typed as events with that specific type
   */
  getEventsByType<T extends MergedEventForSlices<Slices>["type"]>(
    eventType: T,
  ): Extract<MergedEventForSlices<Slices>, { type: T }>[] {
    const rawEvents = this.sql`
      SELECT 
        event_type as type,
        data_json,
        metadata_json,
        trigger_llm_request,
        created_at,
        event_index,
        idempotency_key
      FROM agent_events 
      WHERE event_type = ${eventType}
      ORDER BY event_index ASC
    `;
    return parseEventRows(rawEvents) as Extract<MergedEventForSlices<Slices>, { type: T }>[];
  }

  /**
   * Get default context rules that are always available to this agent.
   * Can be overridden by subclasses to provide agent-specific rules.
   * For example, the SlackAgent can override this to add the get-agent-debug-url rule.
   */
  protected async getContextRules(): Promise<ContextRule[]> {
    const defaultRules = await defaultContextRules();
    // sadly drizzle doesn't support abort signals yet https://github.com/drizzle-team/drizzle-orm/issues/1602
    const maybeRules = await Promise.race([
      IterateAgent.getRulesFromDB(this.db, this.databaseRecord.estateId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    if (!maybeRules) {
      console.warn(
        "Timeout querying context rules from db - this might be a deadlock. Using rules loaded from database record at DO initialisation.",
      );
    }
    const rules = [...defaultRules, ...(maybeRules || this.databaseRecord.contextRules)];
    const seenIds = new Set<string>();
    const dedupedRules = rules.filter((rule: ContextRule) => {
      if (seenIds.has(rule.key)) {
        return false;
      }
      seenIds.add(rule.key);
      return true;
    });
    return dedupedRules;
  }

  async addEvent(event: MergedEventInputForSlices<Slices>): Promise<{ eventIndex: number }[]> {
    return this.agentCore.addEvent(event);
  }

  async addEvents(events: MergedEventInputForSlices<Slices>[]): Promise<{ eventIndex: number }[]> {
    return this.agentCore.addEvents(events);
  }

  getReducedState(): Readonly<
    MergedStateForSlices<Slices> & MergedStateForSlices<CoreAgentSlices>
  > {
    return this.agentCore.state;
  }

  /*
   * Get the reduced state at a specific event index
   */
  async getReducedStateAtEventIndex(eventIndex: number): Promise<AugmentedCoreReducedState> {
    return this.agentCore.getReducedStateAtEventIndex(eventIndex);
  }

  async getState() {
    return { ...this.state, reducedState: this.agentCore.state };
  }

  // Injects a function tool call from the outside into the agent
  async injectToolCall({
    toolName,
    args,
    triggerLLMRequest = true,
  }: {
    toolName: string;
    args: JSONSerializable;
    triggerLLMRequest?: boolean;
  }) {
    // Create a mock function call object that matches OpenAI's format
    const functionCall = {
      type: "function_call" as const,
      call_id: `injected-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: toolName,
      arguments: JSON.stringify(args),
      status: "completed" as const,
    };

    // Use the agentCore's existing tryInvokeLocalFunctionTool method
    const result = await this.agentCore.tryInvokeLocalFunctionTool(functionCall);

    return this.addEvent({
      type: "CORE:LOCAL_FUNCTION_TOOL_CALL",
      data: { call: functionCall, result: result },
      triggerLLMRequest,
    });
  }
  /**
   * Generic handler for scheduled reminders. This method will be called by the scheduler.
   */
  async handleReminder(data: { iterateReminderId: string }) {
    console.log(`Executing reminder: ${data.iterateReminderId}`);

    const reminder = this.state.reminders?.[data.iterateReminderId];
    if (!reminder) {
      console.error(`Reminder with ID ${data.iterateReminderId} not found in state.`);
      return;
    }

    const timeAgo = formatDistanceToNow(new Date(reminder.createdAt), { addSuffix: true });

    const message = renderPromptFragment([
      reminder.message,
      {
        tag: "context",
        content: [
          `This is a ${reminder.isRecurring ? "recurring " : ""}reminder you set for yourself ${timeAgo}.`,
          reminder.isRecurring
            ? `This is a recurring reminder. You can cancel it using the cancelReminder tool with id "${data.iterateReminderId}".`
            : null,
        ],
      },
    ]);

    const events: MergedEventInputForSlices<Slices>[] = [];

    // Check if the agent is paused and resume it if needed
    // This ensures reminders can trigger LLM responses even if the agent was previously paused
    if (this.agentCore.state.paused) {
      events.push({
        type: "CORE:RESUME_LLM_REQUESTS",
        triggerLLMRequest: false,
      });
    }

    // Add an event to record the scheduled task execution and trigger LLM response
    events.push({
      type: "CORE:LLM_INPUT_ITEM",
      data: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: message }],
      },
      triggerLLMRequest: true,
    });
    await this.addEvents(events);

    if (!reminder.isRecurring) {
      // One-time reminder, remove it from state after execution
      const newReminders = { ...this.state.reminders };
      delete newReminders[data.iterateReminderId];
      this.setState({
        ...this.state,
        reminders: newReminders,
      });
    }

    return {
      success: true,
      reminderId: data.iterateReminderId,
      executedAt: new Date().toISOString(),
    };
  }

  // set the braintrust parent span exported id into the state
  async setBraintrustParentSpanExportedId(braintrustParentSpanExportedId: string | undefined) {
    this.setState({
      ...this.state,
      braintrustParentSpanExportedId,
    });
  }

  // get the braintrust parent span exported id from the state
  async getBraintrustParentSpanExportedId() {
    return this.state.braintrustParentSpanExportedId;
  }

  ping() {
    return { message: "pong back at you!" };
  }
  async flexibleTestTool(input: Inputs["flexibleTestTool"]) {
    switch (input.behaviour) {
      case "slow-tool": {
        const start = input.recordStartTime ? new Date().toISOString() : undefined;
        await new Promise((resolve) => setTimeout(resolve, input.delay));
        return { start, message: input.response, delayed: true, delayMs: input.delay };
      }
      case "raise-error":
        throw new Error(input.error);
      case "return-secret":
        return { secret: input.secret, behaviour: "return-secret" };
      default:
        throw new Error("Unknown behaviour");
    }
  }

  reverse(input: Inputs["reverse"]) {
    return { reversed: input.message.split("").reverse().join("") };
  }
  doNothing() {
    return {};
  }
  async getAgentDebugURL() {
    const estate = await this.db.query.estate.findFirst({
      where: eq(schema.estate.id, this.databaseRecord.estateId),
      columns: {
        organizationId: true,
        id: true,
      },
    });
    if (!estate) {
      throw new Error("Estate not found");
    }
    return {
      debugURL: `${this.env.VITE_PUBLIC_URL}/${estate.organizationId}/${estate.id}/agents/${this.constructor.name}/${this.name}`,
    };
  }
  async remindMyselfLater(input: Inputs["remindMyselfLater"]) {
    const { message, type, when } = input;

    let scheduleTime: number | Date | string;
    let scheduleDetail: string;
    let isRecurring: boolean;

    switch (type) {
      case "numberOfSecondsFromNow": {
        const seconds = Number(when);
        if (!Number.isInteger(seconds) || seconds <= 0) {
          throw new Error(
            "For 'numberOfSecondsFromNow' type, 'when' must be a positive integer number of seconds",
          );
        }
        scheduleTime = seconds;
        scheduleDetail = `in ${seconds} seconds`;
        isRecurring = false;
        break;
      }
      case "atSpecificDateAndTime": {
        try {
          scheduleTime = new Date(when);
          if (Number.isNaN(scheduleTime.getTime())) {
            throw new Error("Invalid date");
          }
        } catch (_error) {
          throw new Error(
            "For 'atSpecificDateAndTime' type, 'when' must be a valid ISO 8601 date-time string",
          );
        }
        scheduleDetail = `at ${when}`;
        isRecurring = false;
        break;
      }
      case "recurringCron": {
        scheduleTime = when;
        scheduleDetail = `with cron: ${when}`;
        isRecurring = true;
        break;
      }
      default:
        throw new Error(`Invalid reminder type: ${type}`);
    }

    // Why we need two IDs:
    // 1. iterateReminderId: We generate this ID to pass to the handler so it knows which reminder is executing
    // 2. agentSDKScheduledTaskId: The CloudflareAgent generates this after scheduling - we need it for cancelSchedule()
    // This dual-ID approach is necessary because the CloudflareAgent scheduler API doesn't let us:
    //   - Provide our own task ID when scheduling
    //   - Access the task data/metadata from within the handler
    //   - Know which task is executing without passing data to the handler

    // Generate our own reminder ID that we control
    const iterateReminderId = `reminder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Schedule the task, passing our ID so the handler knows which reminder to execute
    const task = await this.schedule(scheduleTime, "handleReminder", {
      iterateReminderId,
    });

    const reminder: ReminderMetadata = {
      iterateReminderId,
      agentSDKScheduledTaskId: task.id,
      message,
      createdAt: new Date().toISOString(),
      isRecurring,
      scheduleDetail,
    };

    // Store the reminder indexed by our reminder ID
    this.setState({
      ...this.state,
      reminders: {
        ...this.state.reminders,
        [iterateReminderId]: reminder,
      },
    });

    // Return the reminder without exposing the internal agentSDKScheduledTaskId
    const { agentSDKScheduledTaskId: _, ...publicReminder } = reminder;
    return publicReminder;
  }

  listMyReminders(_params: Inputs["listMyReminders"]) {
    const scheduledTasks = this.getSchedules();
    const scheduledTaskIds = new Set(scheduledTasks.map((t) => t.id));

    const allReminders = Object.values(this.state.reminders ?? {});
    const activeReminders = allReminders.filter((r) =>
      scheduledTaskIds.has(r.agentSDKScheduledTaskId),
    );

    // Prune reminders from state that are no longer scheduled
    const newRemindersState = Object.fromEntries(
      activeReminders.map((r) => [r.iterateReminderId, r]),
    );
    this.setState({
      ...this.state,
      reminders: newRemindersState,
    });

    // Return reminders without exposing the internal agentSDKScheduledTaskId
    const publicReminders = activeReminders.map(
      ({ agentSDKScheduledTaskId, ...reminder }) => reminder,
    );
    return { reminders: publicReminders, count: publicReminders.length };
  }

  async cancelReminder(input: { iterateReminderId: string }) {
    const { iterateReminderId } = input;
    const reminder = this.state.reminders?.[iterateReminderId];
    if (!reminder) {
      return {
        iterateReminderId,
        cancelled: false,
        message: "Reminder not found.",
      };
    }

    const cancelled = await this.cancelSchedule(reminder.agentSDKScheduledTaskId);

    if (this.state.reminders?.[iterateReminderId]) {
      const newReminders = { ...this.state.reminders };
      delete newReminders[iterateReminderId];
      this.setState({
        ...this.state,
        reminders: newReminders,
      });
    }

    return {
      iterateReminderId,
      cancelled,
      message: cancelled
        ? "Reminder successfully cancelled."
        : "Reminder not found or already executed/cancelled.",
    };
  }

  async connectMCPServer(input: Inputs["connectMCPServer"]) {
    const formattedServerUrl = new URL(input.serverUrl);
    if (input.requiresQueryParamsAuth) {
      const searchParams = new URLSearchParams(input.requiresQueryParamsAuth);
      formattedServerUrl.search = searchParams.toString();
    }
    const mcpServer: MCPServer = {
      serverUrl: formattedServerUrl.toString(),
      mode: input.mode,
      requiresAuth: input.requiresOAuth || false,
      headers: input.requiresHeadersAuth || undefined,
    };
    // Check if already connected
    const connectionKey = getConnectionKey({
      serverUrl: formattedServerUrl.toString(),
      mode: input.mode,
      userId: input.onBehalfOfIterateUserId,
    });

    const existingManager = mcpManagerCache.managers.get(connectionKey);
    if (existingManager) {
      // Already connected, just add the server to the state
      return {
        success: true,
        message: `Already connected to MCP server: ${input.serverUrl}. The tools from this server are available.`,
        addedMcpServer: mcpServer,
      };
    }

    // Not connected yet, proceed with connection
    const connectRequestEvent: MCPConnectRequestEventInput = {
      type: "MCP:CONNECT_REQUEST",
      data: {
        ...mcpServer,
        triggerLLMRequestOnEstablishedConnection: false,
        userId: input.onBehalfOfIterateUserId,
      },
      metadata: {},
      triggerLLMRequest: false,
    };

    const events = await handleMCPConnectRequest({
      event: {
        ...connectRequestEvent,
        eventIndex: 0,
        createdAt: new Date().toISOString(),
      },
      agentDurableObjectId: this.ctx.id.toString(),
      agentDurableObjectName: this.name,
      reducedState: this.getReducedState(),
    });

    if (events.at(-1)?.type !== "MCP:CONNECTION_ESTABLISHED") {
      return {
        __addAgentCoreEvents: events,
        success: false,
        message: `Failed to add MCP server: ${input.serverUrl} (Got ${events.length} events: ${events.map((e) => e.type).join(", ")})`,
        addedMcpServer: mcpServer,
      };
    }

    return {
      __addAgentCoreEvents: events,
      success: true,
      message: `Successfully added MCP server: ${input.serverUrl}. This means you don't need to ask the user for any extra inputs can start using the tools from this server.`,
      addedMcpServer: mcpServer,
    };
  }
}

// -----------------------------------------------------------------------------
// Utility functions ----------------------------------------------------------
// -----------------------------------------------------------------------------

/**
 * Helper function to parse event rows from raw SQL results.
 * Accepts raw SQL results and returns parsed event rows.
 */
function parseEventRows(rawSqlResults: unknown[]) {
  // Use zod to parse rows to flag schema migrations with an explicit error
  const events = EventRows.parse(rawSqlResults);

  const parsedEvents = events.map((event) => ({
    type: event.type,
    data: JSON.parse(event.data_json),
    metadata: JSON.parse(event.metadata_json),
    triggerLLMRequest: event.trigger_llm_request === 1,
    createdAt: event.created_at,
    eventIndex: event.event_index,
    idempotencyKey: event.idempotency_key || undefined,
  }));

  return parsedEvents;
}
