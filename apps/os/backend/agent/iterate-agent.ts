import pMemoize from "p-suite/p-memoize";
import { Agent as CloudflareAgent } from "agents";
import { formatDistanceToNow } from "date-fns";
import { z } from "zod/v4";

// Parent directory imports
import { and, eq } from "drizzle-orm";
import * as R from "remeda";
import { getSandbox } from "@cloudflare/sandbox";
import { waitUntil } from "cloudflare:workers";
import Replicate from "replicate";
import { logger as console } from "../tag-logger.ts";
import { env, type CloudflareEnv } from "../../env.ts";
import { getDb, schema, type DB } from "../db/client.ts";
import { PosthogCloudflare } from "../utils/posthog-cloudflare.ts";
import type { JSONSerializable } from "../utils/type-helpers.ts";

// Local imports
import { agentInstance, agentInstanceRoute, UserRole } from "../db/schema.ts";
import type { IterateConfig } from "../../sdk/iterate-config.ts";
export type AgentInstanceDatabaseRecord = typeof agentInstance.$inferSelect & {
  iterateConfig: IterateConfig;
};
import { makeBraintrustSpan } from "../utils/braintrust-client.ts";
import { searchWeb, getURLContent } from "../default-tools.ts";
import { getFilePublicURL, uploadFile, uploadFileFromURL } from "../file-handlers.ts";
import { tutorialRules } from "../../sdk/tutorial.ts";
import type { MCPParam } from "./tool-schemas.ts";
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
import { runMCPEventHooks, getOrCreateMCPConnection } from "./mcp/mcp-event-hooks.ts";
import { mcpSlice, getConnectionKey } from "./mcp/mcp-slice.ts";
import { MCPConnectRequestEventInput } from "./mcp/mcp-slice.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { openAIProvider } from "./openai-client.ts";
import { renderPromptFragment } from "./prompt-fragments.ts";
import type { ToolSpec } from "./tool-schemas.ts";
import { toolSpecsToImplementations } from "./tool-spec-to-runtime-tool.ts";
import { defaultContextRules } from "./default-context-rules.ts";
import { ContextRule } from "./context-schemas.ts";
import { processPosthogAgentCoreEvent } from "./posthog-event-processor.ts";

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
    const iterateConfig = await this.getIterateConfigFromDB(db, record.estateId);

    return this.getStubFromDatabaseRecord({ ...record, iterateConfig });
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
          iterateConfig: record.estate.iterateConfigs[0].config ?? {},
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
        eq(agentInstance.estateId, estateId),
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
    const iterateConfig = await this.getIterateConfigFromDB(db, estateId);

    return this.getStubFromDatabaseRecord({ ...record, iterateConfig });
  }

  // Get or create stub by route
  static async getOrCreateStubByRoute(params: {
    db: DB;
    estateId: string;
    route: string;
    reason?: string;
  }) {
    const { db, estateId, route, reason } = params;

    // First check if an agent already exists for this route
    const existingRoutes = await db.query.agentInstanceRoute.findMany({
      where: eq(agentInstanceRoute.routingKey, route),
      with: { agentInstance: true },
    });
    const iterateConfig = await this.getIterateConfigFromDB(db, estateId);

    const existingAgent = existingRoutes
      .map((r) => r.agentInstance)
      .find((r) => r.className === this.name && r.estateId === estateId);

    if (existingAgent) {
      return this.getStubFromDatabaseRecord({ ...existingAgent, iterateConfig });
    }

    // No existing agent for this route, create one with route
    const durableObjectName = `SlackAgent-${route}-${crypto.randomUUID()}`;
    const durableObjectId = this.getNamespace().idFromName(durableObjectName);
    const [record] = await db
      .insert(agentInstance)
      .values({
        estateId,
        className: this.name,
        durableObjectName: durableObjectName,
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
      iterateConfig,
    });
  }

  static async getIterateConfigFromDB(db: DB, estateId: string): Promise<IterateConfig> {
    const config = await db.query.iterateConfig.findFirst({
      where: eq(schema.iterateConfig.estateId, estateId),
    });
    return config?.config ?? {};
  }

  protected db: DB;
  // Runtime slice list – inferred from the generic parameter.
  agentCore!: AgentCore<Slices, CoreAgentSlices>;
  _databaseRecord?: AgentInstanceDatabaseRecord;

  // This gets run between the synchronous durable object constructor and the asynchronous onStart method of the agents SDK
  async initAfterConstructorBeforeOnStart(params: { record: AgentInstanceDatabaseRecord }) {
    const { record } = params;
    this._databaseRecord = record;
  }

  initialState = {
    reminders: {},
  };

  get databaseRecord() {
    if (!this._databaseRecord) {
      throw new Error("Database record not found");
    }
    return this._databaseRecord;
  }

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
    const getEstate = pMemoize(() => this.getEstate());
    const getBraintrustParentSpanExportedId = pMemoize(async () => {
      const estate = await getEstate();
      return await this.getOrCreateBraintrustParentSpanExportedId(estate.name);
    });
    const posthogClient = pMemoize(async () => {
      const estate = await getEstate();
      return new PosthogCloudflare(this.ctx, {
        estateName: estate.name,
        projectName: this.env.PROJECT_NAME,
      });
    });

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
        waitUntil(fn());
      },

      getOpenAIClient: async () => {
        const estate = await getEstate();
        return await openAIProvider({
          estateName: estate.name,
          posthog: {
            projectName: this.env.PROJECT_NAME,
            traceId: `${this.constructor.name}-${this.name}`,
          },
          env: {
            BRAINTRUST_API_KEY: this.env.BRAINTRUST_API_KEY,
            OPENAI_API_KEY: this.env.OPENAI_API_KEY,
            POSTHOG_PUBLIC_KEY: this.env.POSTHOG_PUBLIC_KEY,
          },
          braintrust: {
            getBraintrustParentSpanExportedId,
          },
        });
      },

      toolSpecsToImplementations: (specs: ToolSpec[]) => {
        return toolSpecsToImplementations({ toolSpecs: specs, theDO: this });
      },

      // @ts-expect-error
      uploadFile: async (data: {
        ctx: ExecutionContext;
        content: ReadableStream;
        filename: string;
        mimeType?: string;
        contentLength: number;
      }) => {
        // Cloudflare needs to know the content length in advance, so we need to create a fixed-length stream
        const fileRecord = await uploadFile({
          estateId: this.databaseRecord.estateId,
          db: this.db,
          stream: data.content,
          contentLength: data.contentLength,
          filename: data.filename,
          contentType: data.mimeType || "application/octet-stream",
        });
        return {
          fileId: fileRecord.id,
          openAIFileId: fileRecord.openAIFileId,
          originalFilename: fileRecord.filename,
          size: fileRecord.fileSize,
          mimeType: fileRecord.mimeType,
        };
      },

      turnFileIdIntoPublicURL: (fileId: string) => {
        return getFilePublicURL(fileId);
      },

      getFinalRedirectUrl: async (payload: { durableObjectInstanceName: string }) => {
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
          waitUntil(
            (async () => {
              if (reducedState.mcpConnections) {
                const eventsToAdd = await runMCPEventHooks({
                  event: mcpEvent,
                  reducedState,
                  agentDurableObject: this.hydrationInfo,
                  estateId: this.databaseRecord.estateId,
                  getFinalRedirectUrl: deps.getFinalRedirectUrl!,
                });

                for (const eventToAdd of eventsToAdd) {
                  this.agentCore.addEvent(eventToAdd);
                }
              }
            })(),
          );
        }

        if (event.type === "CORE:LLM_REQUEST_END") {
          // fairly arbitrarily, refresh context rules after each LLM request so the agent will have updated instructions by next time
          // but we shouldn't rely on this - we listen for relevant webhooks and refresh events when they actually change
          // https://docs.slack.dev/reference/events/user_typing/ might also be an interesting source of events to trigger this that doesn't require additional dependencies/webhooks/polling
          waitUntil(this.refreshContextRules());
        }

        this.ctx.waitUntil(
          (async () => {
            const posthog = await posthogClient();
            return await processPosthogAgentCoreEvent({
              posthog,
              data: {
                event,
                reducedState,
              },
            });
          })(),
        );
      },
      lazyConnectionDeps: {
        getDurableObjectInfo: () => this.hydrationInfo,
        getEstateId: () => this.databaseRecord.estateId,
        getReducedState: () => this.agentCore.state,
        getFinalRedirectUrl: async (payload: { durableObjectInstanceName: string }) => {
          return `${this.env.VITE_PUBLIC_URL}/agents/IterateAgent/${payload.durableObjectInstanceName}`;
        },
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

  get hydrationInfo() {
    return {
      durableObjectId: this.ctx.id.toString(),
      durableObjectName: this.databaseRecord.durableObjectName,
      className: this.constructor.name,
    };
  }

  async getAddContextRulesEvent(): Promise<AddContextRulesEvent> {
    const rules = ContextRule.array().parse(await this.getContextRules());
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
    // const { db, databaseRecord } = this;
    // sadly drizzle doesn't support abort signals yet https://github.com/drizzle-team/drizzle-orm/issues/1602
    // const rulesFromDb = await pTimeout(IterateAgent.getRulesFromDB(db, databaseRecord.estateId), {
    //   milliseconds: 250,
    //   fallback: () => console.warn("getRulesFromDB timeout - DO initialisation deadlock?"),
    // });
    const rules = [
      ...defaultContextRules,
      // If this.databaseRecord.iterateConfig.contextRules is not set, it means we're in a "repo-less estate"
      // That means we want to pull in the tutorial rules
      ...(this.databaseRecord.iterateConfig.contextRules || tutorialRules),
    ];
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

  /**
   * Check if a user is a guest in the organization that owns this estate.
   * Returns true if the user is a guest, false otherwise.
   */
  private async getUserRole(userId: string): Promise<UserRole | undefined> {
    const result = await this.db
      .select({
        role: schema.organizationUserMembership.role,
      })
      .from(schema.estate)
      .innerJoin(
        schema.organizationUserMembership,
        eq(schema.estate.organizationId, schema.organizationUserMembership.organizationId),
      )
      .where(
        and(
          eq(schema.estate.id, this.databaseRecord.estateId),
          eq(schema.organizationUserMembership.userId, userId),
        ),
      )
      .limit(1);

    return result[0]?.role;
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
    console.info(`Executing reminder: ${data.iterateReminderId}`);

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

  // get the braintrust parent span exported id from the state
  // if it's not set, create it and set it in the state
  async getOrCreateBraintrustParentSpanExportedId(estateName: string) {
    if (this.state.braintrustParentSpanExportedId) {
      return this.state.braintrustParentSpanExportedId;
    } else {
      const spanExportedId = await makeBraintrustSpan({
        braintrustKey: this.env.BRAINTRUST_API_KEY,
        projectName: this.env.PROJECT_NAME,
        spanName: `${this.constructor.name}-${this.name}`,
        estateName,
      });
      this.setState({
        ...this.state,
        braintrustParentSpanExportedId: spanExportedId,
      });
      return spanExportedId;
    }
  }

  ping() {
    return { message: "pong back at you!" };
  }
  async flexibleTestTool({ params: input }: Inputs["flexibleTestTool"]) {
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
  async getEstate() {
    const estate = await this.db.query.estate.findFirst({
      where: eq(schema.estate.id, this.databaseRecord.estateId),
      columns: {
        organizationId: true,
        id: true,
        name: true,
      },
    });
    if (!estate) {
      throw new Error("Estate not found");
    }
    return estate;
  }
  async getAgentDebugURL() {
    const estate = await this.getEstate();
    return {
      debugURL: `${this.env.VITE_PUBLIC_URL}/${estate.organizationId}/${estate.id}/agents/${this.constructor.name}/${encodeURIComponent(this.name)}`,
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
    const userRole = await this.getUserRole(input.onBehalfOfIterateUserId);
    if (!userRole || userRole === "guest") {
      return {
        success: false,
        error:
          "This user doesn't have permission to connect MCP servers because they are a guest in this Slack workspace. Tell the user that their request is not possible in one line. Do not suggest user to upgrade their access.",
      };
    }

    const formattedServerUrl = new URL(input.serverUrl);

    const requiresParams: MCPParam[] = [
      ...R.pipe(
        input.requiresHeadersAuth ?? {},
        R.entries(),
        R.map(
          ([key, config]): MCPParam => ({
            key,
            type: "header",
            placeholder: config.placeholder,
            description: config.description,
            sensitive: config.sensitive,
          }),
        ),
      ),
      ...R.pipe(
        input.requiresQueryParamsAuth ?? {},
        R.entries(),
        R.map(
          ([key, config]): MCPParam => ({
            key,
            type: "query_param",
            placeholder: config.placeholder,
            description: config.description,
            sensitive: config.sensitive,
          }),
        ),
      ),
    ];

    const mcpServer = {
      serverUrl: formattedServerUrl.toString(),
      mode: input.mode,
      requiresParams,
    };

    const connectionKey = getConnectionKey({
      serverUrl: formattedServerUrl.toString(),
      mode: input.mode,
      userId: input.onBehalfOfIterateUserId,
    });

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
    const result = await getOrCreateMCPConnection({
      connectionKey,
      connectionRequestEvent: {
        ...connectRequestEvent,
        eventIndex: 0,
        createdAt: new Date().toISOString(),
      },
      agentDurableObject: this.hydrationInfo,
      estateId: this.databaseRecord.estateId,
      reducedState: this.getReducedState(),
      getFinalRedirectUrl: this.agentCore.getFinalRedirectUrl.bind(this.agentCore),
    });

    if (result.success) {
      if (result.data.manager) {
        return {
          __addAgentCoreEvents: result.data.events,
          success: true,
          message: `Successfully added MCP server: ${input.serverUrl}. This means you don't need to ask the user for any extra inputs can start using the tools from this server.`,
        };
      }
      if (result.data.events) {
        const eventTypes = result.data.events.map((e) => e.type);
        if (eventTypes.includes("MCP:OAUTH_REQUIRED")) {
          return {
            __addAgentCoreEvents: result.data.events,
            success: true,
            message: `MCP server requires OAuth.`,
          };
        }
        if (eventTypes.includes("MCP:PARAMS_REQUIRED")) {
          return {
            __addAgentCoreEvents: result.data.events,
            success: true,
            message: `MCP server requires additional inputs from the user.`,
          };
        }
        if (eventTypes.includes("MCP:CONNECTION_ERROR")) {
          return {
            __addAgentCoreEvents: result.data.events,
            success: false,
            message: `Failed to add MCP server.`,
          };
        }
      }
    }

    if (!result.success && result.error) {
      return {
        success: false,
        message: `Failed to add MCP server: ${input.serverUrl}. ${result.error}`,
      };
    }

    return {
      success: false,
      message: `Something went wrong while adding MCP server - you should never see this message.`,
    };
  }

  async getURLContent(input: Inputs["getURLContent"]) {
    return await getURLContent({
      ...input,
      db: this.db,
      estateId: this.databaseRecord.estateId,
    });
  }

  async searchWeb(input: Inputs["searchWeb"]) {
    const { query, numResults = 10 } = input;
    const result = await searchWeb({
      query,
      numResults,
      type: "auto" as const,
    });
    return {
      query,
      results: result.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.text || "",
        publishedDate: r.publishedDate,
        author: r.author,
      })),
      totalResults: result.results.length,
    };
  }

  async generateImage(input: Inputs["generateImage"]) {
    const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN, useFileOutput: false });

    // Because we set useFileOutput to false above, this will return an array of URLs
    const replicateResponse = await replicate.run(input.model, {
      input: {
        prompt: input.prompt,
        quality: input.quality,
        background: input.background,
        output_format: "png",
        openai_api_key: env.OPENAI_API_KEY,
        input_images: input.inputImages,
        ...input.overrideReplicateParams,
      },
    });

    // I'm not 100% sure if other replicate models will have a different response format.
    // Just in case, I'm returning the replicate response verbatim to the agent in case it's not an array of URLs.
    if (
      !Array.isArray(replicateResponse) ||
      !replicateResponse.every((url) => typeof url === "string" && url.startsWith("https://"))
    ) {
      console.warn(
        "Replicate API returned non-array response or array contains non-string values",
        replicateResponse,
      );
      return replicateResponse;
    }

    // If replicate returns an array of URLs, upload them and return CORE:FILE_SHARED events
    // That way the multimodal LLM can "see" the images
    const now = Date.now();
    const fileSharedEvents = await Promise.all(
      replicateResponse.map(async (url: string, index: number) => {
        const fileRecord = await uploadFileFromURL({
          url,
          filename: `generated-image-${now}-${index}.png`,
          estateId: this.databaseRecord.estateId,
          db: this.db,
        });
        return {
          type: "CORE:FILE_SHARED",
          data: {
            direction: "from-agent-to-user",
            iterateFileId: fileRecord.id,
            openAIFileId: fileRecord.openAIFileId,
            mimeType: fileRecord.mimeType,
          },
          openAIFileId: fileRecord.openAIFileId,
          mimeType: fileRecord.mimeType,
        };
      }),
    );

    return {
      success: true,
      numberOfImagesGenerated: replicateResponse.length,
      __addAgentCoreEvents: fileSharedEvents,
    };
  }

  async exec(input: Inputs["exec"]) {
    // ------------------------------------------------------------------------
    // Get config
    // ------------------------------------------------------------------------

    const estateId = this.databaseRecord.estateId;

    // Get estate and repo information
    const estate = await this.db.query.estate.findFirst({
      where: eq(schema.estate.id, estateId),
    });

    if (!estate) {
      throw new Error(`Estate ${estateId} not found`);
    }

    if (!estate.connectedRepoId) {
      throw new Error("No repository connected to this estate");
    }

    // Get GitHub installation and token
    const githubInstallation = await this.db
      .select({
        accountId: schema.account.accountId,
        accessToken: schema.account.accessToken,
      })
      .from(schema.estateAccountsPermissions)
      .innerJoin(schema.account, eq(schema.estateAccountsPermissions.accountId, schema.account.id))
      .where(
        and(
          eq(schema.estateAccountsPermissions.estateId, estateId),
          eq(schema.account.providerId, "github-app"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!githubInstallation) {
      throw new Error("No GitHub installation found for this estate");
    }

    // Get installation token
    const { getGithubInstallationToken } = await import("../integrations/github/github-utils.ts");
    const githubToken = await getGithubInstallationToken(githubInstallation.accountId);

    // Fetch repository details from GitHub API
    const repoResponse = await fetch(
      `https://api.github.com/repositories/${estate.connectedRepoId}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          "User-Agent": "Iterate OS",
        },
      },
    );

    if (!repoResponse.ok) {
      throw new Error(`Failed to fetch repository details: ${repoResponse.statusText}`);
    }

    const repoData = (await repoResponse.json()) as { html_url: string };
    const githubRepoUrl = repoData.html_url;
    const branch = estate.connectedRepoRef || "main";
    const commitHash = undefined; // Use the latest commit on the branch

    // ------------------------------------------------------------------------
    // Init sandbox
    // ------------------------------------------------------------------------

    // Compute IDs
    const sandboxId = `agent-sandbox-${estateId}`;
    const sessionId = estateId;
    const sessionDir = `/tmp/session-${estateId}`;

    // Retrieve the sandbox
    const sandbox = getSandbox(env.SANDBOX, sandboxId);

    // Check current state
    // NOTE: according to the exposed API this should be the correct way to
    // check if the sandbox is running and start it up if it isnt'. But the logs
    // are confusing:
    // ... Sandbox successfully shut down
    // ... Error checking if container is ready: connect(): Connection refused: container port not found. Make sure you exposed the port in your container definition.
    // ... Error checking if container is ready: The operation was aborted
    // ... Port 3000 is ready
    if ((await sandbox.getState()).status !== "healthy") {
      await sandbox.startAndWaitForPorts(3000); // default sandbox port
    }

    // Ensure that the session directory exists
    await sandbox.mkdir(sessionDir, { recursive: true });

    // Create an isolated session
    const sandboxSession = await sandbox.createSession({
      id: sessionId,
      cwd: sessionDir,
      isolation: true,
    });

    // Determine the checkout target and whether it's a commit hash
    const checkoutTarget = commitHash || branch || "main";
    const isCommitHash = Boolean(commitHash);

    // Prepare arguments as a JSON object
    const initArgs = {
      sessionDir,
      githubRepoUrl,
      githubToken,
      checkoutTarget,
      isCommitHash,
    };
    // Escape the JSON string for shell
    const initJsonArgs = JSON.stringify(initArgs).replace(/'/g, "'\\''");
    // Init the sandbox (ignore any errors)
    const commandInit = `node /tmp/sandbox-entry.ts init '${initJsonArgs}'`;
    await sandboxSession.exec(commandInit, {
      timeout: 360 * 1000, // 360 seconds total timeout
    });

    // ------------------------------------------------------------------------
    // Run exec
    // ------------------------------------------------------------------------

    // Run the exec command
    const commandExec = input.command;
    const resultExec = await sandboxSession.exec(commandExec, {
      timeout: 360 * 1000, // 360 seconds total timeout
    });

    return {
      success: true,
      message: resultExec.stdout,
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
