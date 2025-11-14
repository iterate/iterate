import { createHash } from "node:crypto";
import { Agent as CloudflareAgent } from "agents";
import pMemoize from "p-suite/p-memoize";
import { formatDistanceToNow } from "date-fns";
import { z } from "zod";
import dedent from "dedent";
import { typeid } from "typeid-js";
import * as fflate from "fflate/browser";
import { permalink as getPermalink } from "braintrust/browser";
import { and, eq } from "drizzle-orm";
import * as R from "remeda";
import Replicate from "replicate";
import { toFile, type Uploadable } from "openai";
import type { ToFileInput } from "openai/uploads";
import { match, P } from "ts-pattern";
import { logger } from "../tag-logger.ts";
import { env, waitUntil, type CloudflareEnv } from "../../env.ts";
import { getDb, schema, type DB } from "../db/client.ts";
import { PosthogCloudflare } from "../utils/posthog-cloudflare.ts";
import type { JSONSerializable, Result } from "../utils/type-helpers.ts";
import { agentInstance, files, UserRole } from "../db/schema.ts";
import type { IterateConfig } from "../../sdk/iterate-config.ts";
import { makeBraintrustSpan } from "../utils/braintrust-client.ts";
import { signUrl } from "../utils/url-signing.ts";
import { searchWeb, getURLContent } from "../default-tools.ts";
import {
  getFileContent,
  getFilePublicURL,
  uploadFile,
  uploadFileFromURL,
} from "../file-handlers.ts";
import { trackTokenUsageInStripe } from "../integrations/stripe/stripe.ts";
import { getGoogleAccessTokenForUser, getGoogleOAuthURL } from "../auth/token-utils.ts";
import { GOOGLE_INTEGRATION_SCOPES } from "../auth/integrations.ts";
import { getSecret } from "../utils/get-secret.ts";
import {
  getGithubInstallationForEstate,
  getOctokitForInstallation,
} from "../integrations/github/github-utils.ts";
import type { WithCallMethod } from "../stub-stub.ts";
import * as codemode from "./codemode.ts";
import type { AgentTraceExport, FileMetadata } from "./agent-export-types.ts";
import {
  betterWaitUntil,
  monkeyPatchAgentWithBetterWaitUntilSupport,
} from "./better-wait-until.ts";
import type { MCPParam } from "./tool-schemas.ts";
import {
  AgentCore,
  type AgentCoreDeps,
  type AgentCoreSlice,
  type MergedDepsForSlices,
  type MergedEventForSlices,
  type MergedStateForSlices,
} from "./agent-core.ts";
import { AgentCoreEvent, type AugmentedCoreReducedState } from "./agent-core-schemas.ts";
import type { DOToolDefinitions } from "./do-tools.ts";
import {
  runMCPEventHooks,
  getOrCreateMCPConnection,
  createMCPManagerCache,
  createMCPConnectionQueues,
  type MCPManagerCache,
  type MCPConnectionQueues,
} from "./mcp/mcp-event-hooks.ts";
import { mcpSlice, getConnectionKey } from "./mcp/mcp-slice.ts";
import { MCPConnectRequestEvent } from "./mcp/mcp-slice.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { openAIProvider } from "./openai-client.ts";
import { renderPromptFragment } from "./prompt-fragments.ts";
import type { ToolSpec } from "./tool-schemas.ts";
import { toolSpecsToImplementations } from "./tool-spec-to-runtime-tool.ts";
import { defaultContextRules } from "./default-context-rules.ts";
import { ContextRule } from "./context-schemas.ts";
import { processPosthogAgentCoreEvent } from "./posthog-event-processor.ts";
import type { MagicAgentInstructions } from "./magic.ts";
import { getAgentStubByName, toAgentClassName } from "./agents/stub-getters.ts";
import { toolNameToJsIdentifier } from "./codemode.ts";

export type AgentInstanceDatabaseRecord = typeof agentInstance.$inferSelect;
export type AgentInitParams = {
  record: AgentInstanceDatabaseRecord;
  estate: typeof schema.estate.$inferSelect;
  organization: typeof schema.organization.$inferSelect;
  iterateConfig: IterateConfig;
  // Optional props forwarded to PartyKit when setting the room name
  // Used to pass initial metadata for the room/server initialisation
  props?: Record<string, unknown>;
  // Optional tracing information for logger context
  tracing?: {
    userId?: string;
    parentSpan?: string;
    traceId?: string;
  };
};

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
export class IterateAgent<
    Slices extends readonly AgentCoreSlice[] = CoreAgentSlices,
    State extends IterateAgentState = IterateAgentState,
  >
  extends CloudflareAgent<{}, State>
  implements ToolsInterface, WithCallMethod
{
  declare env: CloudflareEnv;
  override observability = undefined;

  protected db: DB;
  // Runtime slice list – inferred from the generic parameter.
  agentCore!: AgentCore<Slices, CoreAgentSlices>;
  _databaseRecord?: AgentInstanceDatabaseRecord;
  _estate?: typeof schema.estate.$inferSelect;
  _organization?: typeof schema.organization.$inferSelect;
  _iterateConfig?: IterateConfig;
  // Instance-level MCP manager cache and connection queues to avoid sharing across DOs
  protected mcpManagerCache: MCPManagerCache;
  protected mcpConnectionQueues: MCPConnectionQueues;
  _isInitialized = false;

  // This runs between the synchronous durable object constructor and the asynchronous onStart of the agents SDK
  // It also performs the PartyKit set-name fetch internally to trigger onStart.
  async initIterateAgent(params: AgentInitParams) {
    if (this._isInitialized) return; // no-op if already initialised in this DO lifecycle

    await this.persistInitParams(params);

    // We pass all control-plane DB records from the caller to avoid extra DB roundtrips.
    // These records (estate, organization, iterateConfig) change infrequently and callers
    // typically already fetched them. This also helps when the DO is not colocated with
    // the worker that created the stub; passing the data avoids a potentially slow cross-region read.

    // Perform the PartyKit set-name fetch internally so it triggers onStart inside this DO
    const req = new Request("http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/");
    req.headers.set("x-partykit-room", params.record.durableObjectName);
    if (params.props) {
      req.headers.set("x-partykit-props", JSON.stringify(params.props));
    }
    const res = await this.fetch(req);
    await res.text();

    this._isInitialized = true;
  }

  /**
   * Persist agent init params to both in-memory fields and DO storage.
   * Can be reused after DB updates that return the updated agent instance record.
   */
  private async persistInitParams(params: AgentInitParams) {
    this._databaseRecord = params.record;
    this._estate = params.estate;
    this._organization = params.organization;
    this._iterateConfig = params.iterateConfig;

    // Store init params so onAlarm re-hydration can re-initialise without DB calls
    this.ctx.storage.kv.put("agent-init-params", params);
  }

  override async onAlarm() {
    logger.info("onAlarm - pulling init params from storage");
    const params = this.ctx.storage.kv.get<AgentInitParams>("agent-init-params");
    if (!params) {
      logger.info("IterateAgent durable object constructed for the first time");
      return;
    }
    await this.initIterateAgent(params);
    super.onAlarm();
  }

  initialState: State = {
    reminders: {},
  } as State;

  get databaseRecord() {
    if (!this._databaseRecord) {
      throw new Error("this._databaseRecord not set in IterateAgent - this should never happen");
    }
    return this._databaseRecord;
  }

  get estate() {
    if (!this._estate)
      throw new Error("this._estate not set in IterateAgent - this should never happen");
    return this._estate;
  }

  get organization() {
    if (!this._organization)
      throw new Error("this._organization not set in IterateAgent - this should never happen");
    return this._organization;
  }

  get iterateConfig() {
    return this._iterateConfig;
  }

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    monkeyPatchAgentWithBetterWaitUntilSupport(this);

    this.db = getDb();
    // Initialize instance-level MCP manager cache and connection queues
    this.mcpManagerCache = createMCPManagerCache();
    this.mcpConnectionQueues = createMCPConnectionQueues();
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
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS bg_logs (process_id TEXT, seq INTEGER, ts INTEGER, stream TEXT, message TEXT, event TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_bg_logs_proc_seq ON bg_logs (process_id, seq)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_bg_logs_proc_ts ON bg_logs (process_id, ts)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS bg_processes (process_id TEXT PRIMARY KEY, formatter TEXT, last_heartbeat INTEGER, status TEXT NOT NULL DEFAULT 'in_progress')",
    );
  }

  callMethod(...[methodName, args, context]: Parameters<WithCallMethod["callMethod"]>) {
    return logger.run(context, async () => {
      // @ts-expect-error trust me bro
      return this[methodName](...args);
    });
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
      setupCodemode: (functions) => {
        const codemodeCallerId = this.createCodemodeCaller(functions);
        return {
          eval: async (functionCode) => {
            const toolCallFunctions = Object.keys(functions)
              .map((name) => {
                return `const ${toolNameToJsIdentifier(name)} = input => callCodemodeCallbackOnDO(${JSON.stringify(name)}, input);`;
              })
              .join("\n");
            const dynamicWorkerCode = dedent`
              export default {
                async fetch(request, env, ctx) {
                  const callMethodOnDO = (methodName, args) => {
                    return env.AGENT_CALLER.callMyAgent({
                      bindingName: env.AGENT_BINDING_NAME,
                      durableObjectName: env.AGENT_NAME,
                      methodName,
                      args,
                    })
                  }

                  const callCodemodeCallbackOnDO = (functionName, input) => {
                    return callMethodOnDO("callCodemodeCallback", [env.CODEMODE_CALLER_ID, functionName, input]);
                  }

                  __tool_call_functions__

                  __function_code__

                  const result = await codemode()

                  return new Response(JSON.stringify(result));
                }
              }
            `
              .replace("__tool_call_functions__", toolCallFunctions.replaceAll("\n", "\n    "))
              .replace("__function_code__", functionCode.replaceAll("\n", "\n    "));

            const hash = createHash("md5").update(dynamicWorkerCode).digest("hex");
            const dynamicWorker = this.env.WORKER_LOADER.get(
              `codemode-${codemodeCallerId}-${hash}`,
              async () => {
                return {
                  compatibilityDate: "2025-06-01",
                  mainModule: "index.js",
                  modules: {
                    "index.js": dynamicWorkerCode,
                  },
                  env: {
                    AGENT_CALLER: this.ctx.exports.default({ props: {} }),
                    // there's gotta be a better way to do this
                    AGENT_BINDING_NAME: R.toSnakeCase(this.databaseRecord.className).toUpperCase(),
                    AGENT_NAME: this.databaseRecord.durableObjectName,
                    CODEMODE_CALLER_ID: codemodeCallerId,
                  },
                };
              },
            );

            const entrypoint = dynamicWorker.getEntrypoint();

            const res = await entrypoint.fetch("http://iterate-dynamic-worker");

            const result = await res.json<unknown>();
            return { result, dynamicWorkerCode };
          },
          [Symbol.dispose]: async () => {
            // for some reason `using cm = ...` was disposing too early, so dispose after plenty of time has passed
            waitUntil(
              new Promise((r) => setTimeout(r, 5 * 60_000)).then(() =>
                this.deleteCodemodeCaller(codemodeCallerId),
              ),
            );
          },
        };
      },
      getRuleMatchData: (state) => ({
        agentCoreState: state,
        durableObjectClassName: this.constructor.name,
      }),
      storeEvents: (
        events: ReadonlyArray<AgentCoreEvent & { eventIndex: number; createdAt: string }>,
      ) => {
        // Insert SQL is sync so fine to just iterate
        for (const event of events) {
          if (!event.data) {
            logger.warn("Event has no data:", event);
          }
          this.sql`
            INSERT OR REPLACE INTO agent_events (
              event_index,
              event_type,
              created_at, 
              trigger_llm_request,
              idempotency_key,
              data_json,
              metadata_json
            ) VALUES (
              ${event.eventIndex},
              ${event.type},
              ${event.createdAt},
              ${typeof event.triggerLLMRequest === "boolean" ? Number(event.triggerLLMRequest) : 0},
              ${event.idempotencyKey || null},
              ${JSON.stringify(event.data || {})},
              ${JSON.stringify(event.metadata || {})}
            )
          `;
        }

        // Update state to trigger broadcast to connected clients
        this.setState({
          ...this.state,
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
          logger.warn("Failed to broadcast events:", error);
        }

        // Update the agent_instance row in the background after events are added
        // and refresh the DO-stored init params with the returned record
        void this.updateAgentInstanceAfterEvents(events);
      },

      background: (fn: () => Promise<void>) => {
        betterWaitUntil(this, fn(), {
          logErrorAfter: new Date(Date.now() + 1000 * 60 * 60 * 2), // 2 hours
          logWarningAfter: new Date(Date.now() + 1000 * 60 * 30), // 30 minutes
          timeout: new Date(Date.now() + 1000 * 60 * 60 * 6), // 6 hours
        });
      },

      getOpenAIClient: async () => {
        const estate = await getEstate();
        return await openAIProvider({
          estateName: estate.name,
          posthog: {
            projectName: this.env.PROJECT_NAME,
            traceId: this.posthogTraceId,
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

      onLLMStreamResponseStreamingChunk: (chunk) => {
        if (chunk.type === "response.completed") {
          const { input_tokens, output_tokens } = chunk.response.usage ?? {};

          if (input_tokens && output_tokens) {
            const stripeCustomerId = this.organization.stripeCustomerId;
            const model = this.agentCore.state.modelOpts.model;

            if (stripeCustomerId === "TEST_CUSTOMER_ID") return;

            if (stripeCustomerId) {
              void trackTokenUsageInStripe({
                stripeCustomerId,
                model,
                inputTokens: input_tokens,
                outputTokens: output_tokens,
              });
            } else {
              logger.warn("No Stripe customer ID found for organization", {
                organizationId: this.organization.id,
              });
            }
          }
        }
      },

      onEventAdded: ({ event: _event, reducedState: _reducedState }) => {
        const event = _event as MergedEventForSlices<Slices>;
        if (event.type === "CORE:INTERNAL_ERROR") {
          const reconstructed = new Error(event.data.error);
          if (event.data.stack) reconstructed.stack = event.data.stack;
          logger.error(
            new Error(`Internal error in agent: ${event.data.error}`, { cause: reconstructed }),
          );
        }
        const reducedState = _reducedState as MergedStateForSlices<CoreAgentSlices>;
        // Handle MCP side effects for relevant events
        const mcpRelevantEvents = ["MCP:CONNECT_REQUEST", "MCP:DISCONNECT_REQUEST"] as const;
        type MCPRelevantEvent = (typeof mcpRelevantEvents)[number];

        if (mcpRelevantEvents.includes(event.type as string as MCPRelevantEvent)) {
          const mcpEvent = event as Extract<typeof event, { type: MCPRelevantEvent }>; // ideally typescript would narrow this for us but `.includes(...)` is annoying/badly implemented. ts-reset might help
          if (reducedState.mcpConnections) {
            void runMCPEventHooks({
              event: mcpEvent,
              reducedState,
              agentDurableObject: this.hydrationInfo,
              estateId: this.databaseRecord.estateId,
              mcpConnectionCache: this.mcpManagerCache,
              mcpConnectionQueues: this.mcpConnectionQueues,
              getFinalRedirectUrl: deps.getFinalRedirectUrl!,
            }).then((eventsToAdd) => {
              for (const eventToAdd of eventsToAdd) {
                this.agentCore.addEvent(eventToAdd);
              }
            });
          }
        }

        if (event.type === "CORE:LLM_REQUEST_END") {
          // fairly arbitrarily, refresh context rules after each LLM request so the agent will have updated instructions by next time
          // but we shouldn't rely on this - we listen for relevant webhooks and refresh events when they actually change
          // https://docs.slack.dev/reference/events/user_typing/ might also be an interesting source of events to trigger this that doesn't require additional dependencies/webhooks/polling
          void this.refreshContextRules();
        }

        if (event.type === "CORE:TOOL_CALL_APPROVED") {
          void Promise.resolve().then(async () => {
            const { data } = event;
            const state = this.agentCore.state.toolCallApprovals[data.approvalKey];
            if (!state) {
              logger.error(`Tool call approval not found for key: ${data.approvalKey}`);
              return;
            }
            const userMatches = match(state.args)
              .with({ impersonateUserId: data.approvedBy.userId }, () => true)
              .with({ impersonateUserId: P.string }, () => false) // any other user id is not allowed to approve
              .otherwise(
                () =>
                  data.approvedBy.orgRole === "admin" ||
                  data.approvedBy.orgRole === "owner" ||
                  data.approvedBy.orgRole === "member",
              ); // no impersonateUserId, allow any member to approve???

            if (!userMatches) {
              this.addEvent({
                type: "CORE:LLM_INPUT_ITEM",
                data: {
                  type: "message",
                  role: "developer",
                  content: [
                    {
                      type: "input_text",
                      text: dedent`
                        User ${data.approvedBy.userId} is not allowed to approve tool call for ${state.toolName}.
                      `,
                    },
                  ],
                },
                triggerLLMRequest: true,
              });
              return;
            }

            await this.agentCore.deps.onToolCallApproved?.({
              data,
              state,
              replayToolCall: async () => {
                await this.injectToolCall({
                  args: state.args as {},
                  toolName: state.toolName,
                });
              },
            });
          });
        }

        void posthogClient().then((posthog) =>
          processPosthogAgentCoreEvent({
            posthog,
            data: {
              event,
              reducedState: reducedState as {},
            },
          }),
        );
      },
      lazyConnectionDeps: {
        getDurableObjectInfo: () => this.hydrationInfo,
        getEstateId: () => this.databaseRecord.estateId,
        getReducedState: () => this.agentCore.state,
        mcpConnectionCache: this.mcpManagerCache,
        mcpConnectionQueues: this.mcpConnectionQueues,
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

  private _codemodeCallers: Record<`codemode_caller_${string}`, Record<string, Function>> = {};
  private createCodemodeCaller(functions: Record<string, Function>) {
    const id = typeid("codemode_caller").toString();
    this._codemodeCallers[id] = functions;
    return id;
  }
  private deleteCodemodeCaller(id: `codemode_caller_${string}`) {
    delete this._codemodeCallers[id];
  }
  callCodemodeCallback(id: `codemode_caller_${string}`, functionName: string, input: unknown) {
    const codemodeCaller = this._codemodeCallers[id];
    if (!codemodeCaller) {
      throw new Error(`codemode_caller ${id} not found`);
    }
    return codemodeCaller[functionName](input);
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

  async getHydrationInfo() {
    return this.hydrationInfo; // callable via stub
  }

  /**
   * Update the agent_instance row with latest event metadata and refresh DO-stored init params
   * Uses a background voided promise from storeEvents.
   */
  private async updateAgentInstanceAfterEvents(events: ReadonlyArray<AgentCoreEvent>) {
    try {
      if (!events.length) return;
      const last = events[events.length - 1];
      const newMetadata: Record<string, unknown> = {
        ...(this.databaseRecord.metadata ?? {}),
        lastEventAt: last.createdAt ?? new Date().toISOString(),
        lastEventType: last.type,
        lastEventIndex: last.eventIndex,
      };

      const [updated] = await this.db
        .update(agentInstance)
        .set({ metadata: newMetadata })
        .where(eq(agentInstance.id, this.databaseRecord.id))
        .returning();

      if (updated) {
        await this.persistInitParams({
          record: updated,
          estate: this.estate,
          organization: this.organization,
          iterateConfig: this.iterateConfig || {},
        });
      }
    } catch (error) {
      logger.warn("Failed to update agent_instance after events:", error);
    }
  }

  async getAddContextRulesEvent() {
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

  getEvents(): (MergedEventForSlices<Slices> & { eventIndex: number; createdAt: string })[] {
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
    return parseEventRows(rawEvents) as (MergedEventForSlices<Slices> & {
      eventIndex: number;
      createdAt: string;
    })[];
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
    //   fallback: () => logger.warn("getRulesFromDB timeout - DO initialisation deadlock?"),
    // });
    const rules = [
      ...defaultContextRules,
      // If this.iterateConfig.contextRules is not set, it means we're in a "repo-less estate"
      // That means we want to pull in the tutorial rules
      ...(this.iterateConfig?.contextRules || []),
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

  addEvent(event: MergedEventForSlices<Slices>): { eventIndex: number }[] {
    return this.agentCore.addEvent(event);
  }

  addEvents(events: MergedEventForSlices<Slices>[]): { eventIndex: number }[] {
    return this.agentCore.addEvents(events);
  }

  async messageAgent(params: { agentName: string; message: string; triggerLLMRequest?: boolean }) {
    const { agentName, message, triggerLLMRequest } = params;

    const targetRecord = await this.db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.estateId, this.databaseRecord.estateId),
        // agent names are prefixed by estate id
        eq(agentInstance.durableObjectName, `${this.databaseRecord.estateId}-${agentName}`),
      ),
    });

    if (!targetRecord) {
      throw new Error(`Agent instance ${name} not found in estate ${this.databaseRecord.estateId}`);
    }

    const stub = await getAgentStubByName(toAgentClassName(targetRecord.className), {
      db: this.db,
      agentInstanceName: targetRecord.durableObjectName,
    });

    await stub.addEvent({
      type: "CORE:MESSAGE_FROM_AGENT",
      data: {
        fromAgentName: this.databaseRecord.durableObjectName,
        message,
      },
      triggerLLMRequest: triggerLLMRequest === true,
    });
  }

  getReducedState(): Readonly<
    MergedStateForSlices<Slices> & MergedStateForSlices<CoreAgentSlices>
  > {
    return this.agentCore.state;
  }

  /*
   * Get the reduced state at a specific event index
   */
  getReducedStateAtEventIndex(eventIndex: number): AugmentedCoreReducedState {
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
    let functionCall = {
      type: "function_call" as const,
      call_id: `injected-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: toolName,
      arguments: JSON.stringify(args),
      status: "completed" as const,
    };

    const isCodemodeEnabled = this.agentCore.state.codemodeEnabledTools.includes(toolName);
    if (isCodemodeEnabled) {
      functionCall = {
        type: "function_call",
        call_id: `injected-codemode-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: "codemode",
        arguments: JSON.stringify({
          functionCode: [
            "async function codemode() {",
            `  return await ${codemode.toolNameToJsIdentifier(toolName)}(${JSON.stringify(args, null, 2).replaceAll("\n", "\n  ")});`,
            "}",
          ].join("\n"),
          statusIndicatorText: `running ${toolName}`,
        }),
        status: "completed",
      };
    }

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
    logger.info(`Executing reminder: ${data.iterateReminderId}`);

    const reminder = this.state.reminders?.[data.iterateReminderId];
    if (!reminder) {
      logger.error(`Reminder with ID ${data.iterateReminderId} not found in state.`);
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

    const events: MergedEventForSlices<Slices>[] = [];

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

  get posthogTraceId() {
    return `${this.constructor.name}-${this.name}`;
  }

  async exportTrace(opts?: { user?: typeof schema.user.$inferSelect }): Promise<string> {
    const exportId = typeid("export").toString();
    const events = this.getEvents();

    const fullEstate = await this.db.query.estate.findFirst({
      where: eq(schema.estate.id, this.databaseRecord.estateId),
    });
    if (!fullEstate) {
      throw new Error("Estate not found");
    }

    const organizationRecord = await this.db.query.organization.findFirst({
      where: eq(schema.organization.id, fullEstate.organizationId),
    });
    if (!organizationRecord) {
      throw new Error("Organization not found");
    }

    const iterateConfigRecord = await this.db.query.iterateConfig.findFirst({
      where: eq(schema.iterateConfig.estateId, this.databaseRecord.estateId),
    });

    const fileIds = new Set<string>();
    for (const event of events) {
      if (event.type === "CORE:FILE_SHARED" && event.data?.iterateFileId) {
        fileIds.add(event.data.iterateFileId);
      }
    }

    const fileMetadataMap: Record<string, FileMetadata> = {};

    for (const fileId of fileIds) {
      const [fileRecord] = await this.db.select().from(files).where(eq(files.id, fileId)).limit(1);

      if (!fileRecord) {
        throw new Error(`File record not found for export: ${fileId}`);
      }

      if (fileRecord.status !== "completed") {
        throw new Error(`File record not completed for export: ${fileId}`);
      }

      fileMetadataMap[fileId] = fileRecord;
    }

    const braintrustPermalink = this.state.braintrustParentSpanExportedId
      ? await getPermalink(this.state.braintrustParentSpanExportedId)
      : undefined;

    const debugUrl = `${this.env.VITE_PUBLIC_URL}/${this.databaseRecord.estateId}/agents/${this.databaseRecord.className}/${this.databaseRecord.durableObjectName}`;

    const reducedStateSnapshots: Record<number, any> = {};
    for (let i = 0; i < events.length; i++) {
      reducedStateSnapshots[i] = await this.getReducedStateAtEventIndex(i);
    }
    const exportData: AgentTraceExport = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      metadata: {
        agentTraceExportId: exportId,
        braintrustPermalink,
        posthogTraceId: this.posthogTraceId,
        debugUrl,
        user: opts?.user ?? null,
        estate: fullEstate,
        organization: organizationRecord,
        agentInstance: this.databaseRecord,
        iterateConfig: iterateConfigRecord ?? null,
      },
      events,
      fileMetadata: fileMetadataMap,
      reducedStateSnapshots,
    };

    const r2Key = `exports/${exportId}.zip`;
    const multipartUpload = await this.env.ITERATE_FILES.createMultipartUpload(r2Key, {
      httpMetadata: {
        contentType: "application/zip",
      },
      customMetadata: {
        exportId,
        estateId: this.databaseRecord.estateId,
        exportedAt: new Date().toISOString(),
      },
    });

    const PART_SIZE = 5 * 1024 * 1024;
    const uploadedParts: R2UploadedPart[] = [];
    let partNumber = 1;
    let buffer = new Uint8Array(PART_SIZE);
    let bufferOffset = 0;
    let zipError: Error | null = null;
    let zipFinished = false;
    let zipResolve: (() => void) | null = null;

    const uploadPart = async (data: Uint8Array) => {
      const uploadedPart = await multipartUpload.uploadPart(partNumber, data);
      uploadedParts.push(uploadedPart);
      partNumber++;
    };

    const zipPromise = new Promise<void>((resolve) => (zipResolve = resolve));
    const zip = new fflate.Zip(async (err, chunk, final) => {
      if (err) {
        zipError = err;
        zipResolve?.();
        return;
      }

      try {
        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          const remainingInBuffer = PART_SIZE - bufferOffset;
          const remainingInChunk = chunk.length - chunkOffset;
          const bytesToCopy = Math.min(remainingInBuffer, remainingInChunk);

          buffer.set(chunk.subarray(chunkOffset, chunkOffset + bytesToCopy), bufferOffset);
          bufferOffset += bytesToCopy;
          chunkOffset += bytesToCopy;

          if (bufferOffset === PART_SIZE) {
            await uploadPart(buffer);
            buffer = new Uint8Array(PART_SIZE);
            bufferOffset = 0;
          }
        }

        if (final && bufferOffset > 0) {
          await uploadPart(buffer.subarray(0, bufferOffset));
          zipFinished = true;
        } else if (final) {
          zipFinished = true;
        }
      } catch (uploadErr) {
        zipError = uploadErr as Error;
      } finally {
        if (final) {
          zipResolve?.();
        }
      }
    });

    const exportJsonFile = new fflate.ZipPassThrough("export.json");
    zip.add(exportJsonFile);
    exportJsonFile.push(fflate.strToU8(JSON.stringify(exportData, null, 2)), true);

    for (const fileId of fileIds) {
      const r2Key = `files/${fileId}`;
      const object = await this.env.ITERATE_FILES.get(r2Key);

      if (!object) {
        throw new Error(`File not found in storage: ${fileId}`);
      }

      const fileStream = new fflate.ZipPassThrough(`files/${fileId}`);
      zip.add(fileStream);

      const reader = object.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            fileStream.push(new Uint8Array(0), true);
            break;
          }
          fileStream.push(value, false);
        }
      } finally {
        reader.releaseLock();
      }
    }

    zip.end();

    await zipPromise;

    if (zipError) {
      await multipartUpload.abort();
      throw zipError;
    }

    if (!zipFinished) {
      await multipartUpload.abort();
      throw new Error("ZIP archive did not finish properly");
    }

    await multipartUpload.complete(uploadedParts);

    const downloadUrl = `/api/estate/${this.databaseRecord.estateId}/exports/${exportId}`;
    return downloadUrl;
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
    return { __triggerLLMRequest: false } satisfies MagicAgentInstructions;
  }
  async getEstate() {
    return {
      organizationId: this.organization.id,
      id: this.estate.id,
      name: this.estate.name,
    };
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
    if (!userRole || userRole === "guest" || userRole === "external") {
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

    const connectRequestEvent: MCPConnectRequestEvent = {
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
      mcpConnectionCache: this.mcpManagerCache,
      mcpConnectionQueues: this.mcpConnectionQueues,
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
      logger.warn(
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

  async generateVideo(input: Inputs["generateVideo"]) {
    const openai = await openAIProvider({
      env,
      estateName: this.estate.name,
    });

    let inputReference: Uploadable | undefined;
    if (input.inputReferenceFileId) {
      const { content, fileRecord } = await getFileContent({
        iterateFileId: input.inputReferenceFileId,
        db: this.db,
        estateId: this.databaseRecord.estateId,
      });
      inputReference = await toFile(
        content as unknown as ToFileInput,
        fileRecord.filename ?? undefined,
        { type: fileRecord.mimeType ?? undefined },
      );
    }

    const video = await openai.videos.create({
      prompt: input.prompt,
      model: input.model,
      seconds: input.seconds,
      size: input.size,
      input_reference: inputReference,
    });

    logger.info("scheduling OpenAI video poll:", { videoId: video.id });
    await this.schedule(10, "pollForVideoGeneration", {
      videoId: video.id,
      pollUntil: Date.now() + 10 * 60 * 1000, // Poll for at most 10 minutes
    });

    return {
      status: video.status,
      message:
        "The video generation has been queued. I will poll the API every 10 seconds and share the video as soon as it's ready.",
      apiResponse: {
        id: video.id,
        status: video.status,
        progress: video.progress,
      },
    };
  }

  async pollForVideoGeneration(data: { videoId: string; pollUntil: number }) {
    // Helper function to add developer messages
    const addDeveloperMessage = ({
      text,
      triggerLLMRequest,
    }: {
      text: string;
      triggerLLMRequest: boolean;
    }) => {
      this.agentCore.addEvent({
        type: "CORE:LLM_INPUT_ITEM",
        data: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text,
            },
          ],
        },
        triggerLLMRequest,
      });
    };

    // Check if we've exceeded the polling time limit
    if (Date.now() > data.pollUntil) {
      logger.info("video polling timeout reached:", { videoId: data.videoId });
      addDeveloperMessage({
        text: `Video generation polling timeout reached for video ${data.videoId}. The video generation is taking longer than expected (>10 minutes).`,
        triggerLLMRequest: true,
      });
      return;
    }

    const openai = await openAIProvider({
      env,
      estateName: this.estate.name,
    });

    try {
      const video = await openai.videos.retrieve(data.videoId);
      logger.info("video status:", {
        id: video.id,
        status: video.status,
        progress: video.progress,
      });

      // Add developer message about video progress
      addDeveloperMessage({
        text: `Video ${data.videoId} has status ${video.status} and is ${video.progress}% complete`,
        triggerLLMRequest: false,
      });

      if (video.status === "failed") {
        const errorMessage = video.error
          ? `${video.error.code}: ${video.error.message}`
          : "Unknown error";
        addDeveloperMessage({
          text: `Video generation failed for video ${data.videoId}: ${errorMessage}`,
          triggerLLMRequest: true,
        });
        return;
      }

      if (video.status === "completed") {
        const contentRes = await openai.videos.downloadContent(data.videoId);
        if (contentRes.ok && contentRes.body) {
          const contentType = contentRes.headers.get("content-type") ?? "video/mp4";
          const contentLengthHeader = contentRes.headers.get("content-length");
          const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
          logger.info("uploading video to r2", { contentLength, contentType });
          const fileRecord = await uploadFile({
            stream: contentRes.body,
            contentLength,
            filename: `generated-video-${Date.now()}.mp4`,
            contentType,
            estateId: this.databaseRecord.estateId,
            db: this.db,
          });
          logger.info("video uploaded:", {
            fileId: fileRecord.id,
            publicURL: getFilePublicURL(fileRecord.id),
          });

          this.agentCore.addEvent({
            type: "CORE:FILE_SHARED",
            data: {
              direction: "from-agent-to-user",
              iterateFileId: fileRecord.id,
              openAIFileId: fileRecord.openAIFileId ?? undefined,
              mimeType: fileRecord.mimeType ?? undefined,
            },
            metadata: {
              openaiSoraVideoId: data.videoId,
            },
            triggerLLMRequest: true,
          });
        } else {
          throw new Error(`Video content download failed: ${contentRes.status}`);
        }
        return;
      }

      // For in_progress and queued statuses, continue polling
    } catch (err) {
      logger.error("video polling error:", err);
      addDeveloperMessage({
        text: `Video generation polling error for video ${data.videoId}: ${err}`,
        triggerLLMRequest: true,
      });
      return;
    }

    // Schedule next poll
    await this.schedule(10, "pollForVideoGeneration", {
      videoId: data.videoId,
      pollUntil: data.pollUntil,
    });
  }

  async execCodex(input: Inputs["execCodex"]) {
    const instructions: string = input.command;
    const instructionsFilePath = `/tmp/instructions-${Math.floor(Math.random() * 1e6)}.txt`;
    const execInput: Inputs["exec"] = {
      command: `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check 'Perform the task described in ${instructionsFilePath}'`,
      files: [{ path: instructionsFilePath, content: instructions }],
      env: { CODEX_API_KEY: await getSecret(this.env, "OPENAI_API_KEY") },
    };
    return await this.runExecWithOptions(execInput, {
      formatOutput: (stdout) => formatCodexOutput(stdout),
      formatterKey: "codex",
    });
  }

  private async runExecWithOptions(
    input: Inputs["exec"],
    opts?: { formatOutput?: (stdout: string) => string | null; formatterKey?: string },
  ) {
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

    const installation = await getGithubInstallationForEstate(this.db, estateId);
    const octokit = await getOctokitForInstallation(
      installation?.accountId ?? env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
    );

    const { data: repoData } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: estate.connectedRepoId,
    });
    const githubRepoUrl = repoData.html_url;
    const branch = estate.connectedRepoRef || repoData.default_branch || "main";
    const commitHash = undefined; // Use the latest commit on the branch

    const scopedToken = await octokit.rest.apps
      .createInstallationAccessToken({
        installation_id: parseInt(
          installation?.accountId ?? env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
        ),
        repository_ids: [estate.connectedRepoId],
      })
      .catch(() => null);

    if (!scopedToken || scopedToken.status !== 201) {
      throw new Error("Failed to create scoped token");
    }

    // ------------------------------------------------------------------------
    // Init sandbox
    // ------------------------------------------------------------------------

    // Retrieve the sandbox
    const { getSandbox } = await import("@cloudflare/sandbox");

    // TODO: instead of a sandbox per agent instance use a single sandbox with git worktrees and isolated worktree folders
    const sandboxId = `agent-sandbox-${estateId}-${this.constructor.name}`;
    const sandbox = getSandbox(env.SANDBOX, sandboxId);

    const execInSandbox = async () => {
      const sessionId = `${this.ctx.id.toString()}`.toLowerCase();
      logger.info(`Executing in sandbox ${sandboxId} with session ${sessionId}`);
      // Ensure that the session directory exists
      // Hash the session ID to 8 base32 characters for file-system safe usage - using the full session id makes for really long paths that consume a lot of AI tokens
      // Use a unique working directory per exec to avoid contention
      const sessionDir = `/tmp/session-${hashSessionId(sessionId)}-${R.randomInteger(0, 99999)}`;
      const nodePath = "/opt/node24/bin/node";

      try {
        await sandbox.mkdir(sessionDir, { recursive: true });
      } catch (err) {
        logger.error("Error creating session directory", err);
        const { success, exitCode } = await sandbox.listFiles(sessionDir);
        logger.info("List files in session directory:", { success, exitCode });

        if (success && exitCode === 0) {
          // continue with the session
        } else {
          throw new Error("Error creating session directory", { cause: err });
        }
      }

      let sandboxSession: ReturnType<typeof sandbox.createSession>;
      try {
        // Create an isolated session
        sandboxSession = await sandbox.createSession({
          id: sessionId,
          cwd: sessionDir,
          isolation: true,
          env: {
            ...input.env,
            // use the node24 binaries by preference
            PATH: "/opt/node24/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          },
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes("already exists")) {
          logger.info("Session already exists, getting existing session");
          sandboxSession = await sandbox.getSession(sessionId);
        } else {
          logger.error("Error creating session", err);
          throw new Error("Error creating session");
        }
      }
      try {
        // Start background exec runner; it will perform repo setup (auth/clone/install)
        const processId = typeid("exec").toString();
        let baseUrl = this.env.VITE_PUBLIC_URL.replace("iterate.com", "iterateproxy.com");
        if (baseUrl.includes("localhost")) {
          baseUrl = `https://${this.env.ITERATE_USER}.dev.iterate.com`;
        }
        const unsignedIngest = `${baseUrl}/api/agent-logs/${estateId}/${this.databaseRecord.className}/${this.databaseRecord.durableObjectName}/ingest`;
        const ingestUrl = await signUrl(
          unsignedIngest,
          this.env.EXPIRING_URLS_SIGNING_KEY,
          60 * 60,
        );
        const startArgs = {
          sessionDir,
          githubRepoUrl,
          githubToken: scopedToken.data.token,
          checkoutTarget: commitHash || branch || "main",
          isCommitHash: Boolean(commitHash),
          connectedRepoPath: estate.connectedRepoPath,
          ingestUrl,
          estateId,
          processId,
          command: input.command,
          env: input.env,
          files: input.files,
        };
        const startJsonArgs = JSON.stringify(startArgs).replace(/'/g, "'\\''");
        const commandStart = `${nodePath} /tmp/sandbox-exec-runner.js start '${startJsonArgs}'`;
        const res = await sandboxSession.startProcess(commandStart);
        if (res.status !== "running") {
          logger.error("Failed to start exec process:", res);
          return {
            success: false,
            error: "Failed to start background exec process",
          };
        }
        // Ensure a metadata row exists for monitoring (formatter may be null)
        try {
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO bg_processes (process_id, formatter, last_heartbeat, status) VALUES (?, ?, ?, ?)",
            processId,
            opts?.formatterKey ?? null,
            Date.now(),
            "in_progress",
          );
        } catch {}
        // Schedule monitor for timeouts
        await this.schedule(120, "monitorBackgroundProcess", { processId });
        return {
          success: true,
          output: {
            message: `Started background exec task with process id ${processId}. You will get an event when it completes, you do not need to monitor it yourself.`,
            processId,
          },
          __addAgentCoreEvents: [
            { type: "CORE:SET_METADATA", data: { sandboxStatus: "attached" } },
          ],
        };
      } finally {
        // TODO: uncomment when cloudflare sandbox is fixed
        // await sandbox.deleteSession(sessionId);
        logger.info(`TODO: delete session ${sessionId}`);
      }
    };

    // If sandbox is not ready, start it, and schedule exec after it boots up.
    // NOTE: according to the exposed API this should be the correct way to
    //       check if the sandbox is running and start it up if it isnt'. But
    //       the logs are confusing:
    // ... Sandbox successfully shut down
    // ... Error checking if container is ready: connect(): Connection refused: container port not found. Make sure you exposed the port in your container definition.
    // ... Error checking if container is ready: The operation was aborted
    // ... Port 3000 is ready
    const sandboxState = await sandbox.getState();
    const runningStatuses = ["healthy", "running"];
    if (!runningStatuses.includes(sandboxState.status)) {
      await sandbox.startAndWaitForPorts(3000); // default sandbox port
    }
    logger.info("Sandbox state:", sandboxState);

    // If sandbox is already running, just run the command
    const resultExec = await execInSandbox();

    if (!resultExec.success) {
      logger.error("Exec failed to start", resultExec);
      return {
        success: false,
        error: resultExec.error || "Failed to start background exec process",
        __addAgentCoreEvents: [{ type: "CORE:SET_METADATA", data: { sandboxStatus: "attached" } }],
      };
    }

    logger.info("Exec background task started");
    return resultExec;
  }

  async exec(input: Inputs["exec"]) {
    return await this.runExecWithOptions(input);
  }

  async callGoogleAPI(input: Inputs["callGoogleAPI"]): Promise<Result<unknown>> {
    const { endpoint, method, body, queryParams, pathParams, impersonateUserId } = input;

    if (!impersonateUserId.startsWith("usr_")) {
      return {
        success: false,
        error: dedent`
          The user ID ${impersonateUserId} is not a valid user ID.
          It should start with "usr_".
        `,
      };
    }

    const userRole = await this.getUserRole(impersonateUserId);
    if (!userRole || userRole === "guest" || userRole === "external") {
      return {
        success: false,
        error:
          "This user doesn't have permission to call Google API because they are a guest in this Slack workspace. Tell the user that their request is not possible in one line. Do not suggest user to upgrade their access.",
      };
    }

    let accessToken: string;
    try {
      const accessTokenResult = await getGoogleAccessTokenForUser(this.db, impersonateUserId);
      accessToken = accessTokenResult.token;
      const scopes = accessTokenResult.scope?.split(" ") || [];
      const requiredScopes = GOOGLE_INTEGRATION_SCOPES;
      const missingScope = requiredScopes.find((scope) => !scopes.includes(scope));
      if (missingScope) {
        throw new Error(`User is missing scope: ${missingScope}. They need to re-authorize.`);
      }
    } catch (error) {
      const callbackUrl = await this.agentCore.getFinalRedirectUrl?.({
        durableObjectInstanceName: this.databaseRecord.durableObjectName,
      });
      const url = await getGoogleOAuthURL({
        db: this.db,
        estateId: this.databaseRecord.estateId,
        userId: impersonateUserId,
        agentDurableObject: this.databaseRecord,
        callbackUrl,
      });
      return {
        success: false,
        error: dedent`
          Failed to get Google access token: ${error instanceof Error ? error.message : String(error)}. 
          If the user is missing an auth token, you should provided them with the URL: ${url} to complete authorization. 
          Remember to follow your instructions on formatting when providing the URL.
          You will be automatically notified when the user has completed authorization.
          You should not ask the user to notify you when they are done; instead, you notify them with confirmation, and continue.
        `,
      };
    }

    let finalEndpoint = endpoint;
    if (pathParams) {
      Object.entries(pathParams).forEach(([key, value]) => {
        finalEndpoint = finalEndpoint.replace(`[${key}]`, value);
      });
    }

    const url = new URL(`https://www.googleapis.com${finalEndpoint}`);
    if (queryParams) {
      Object.entries(queryParams).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Google API request failed: ${response.status} ${response.statusText}. ${errorText}`,
      };
    }

    const responseData = (await response.json()) as unknown;
    return { success: true, data: responseData };
  }

  async sendGmail(input: Inputs["sendGmail"]): Promise<Result<unknown>> {
    const { to, subject, body, cc, bcc, threadId, inReplyTo, impersonateUserId } = input;

    let emailContent = `To: ${to}\r\n`;
    if (cc) emailContent += `Cc: ${cc}\r\n`;
    if (bcc) emailContent += `Bcc: ${bcc}\r\n`;
    emailContent += `Subject: ${subject}\r\n`;
    if (inReplyTo) {
      emailContent += `In-Reply-To: ${inReplyTo}\r\n`;
      emailContent += `References: ${inReplyTo}\r\n`;
    }
    emailContent += `\r\n${body}`;

    const encodedMessage = Buffer.from(emailContent)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const requestBody: { raw: string; threadId?: string } = { raw: encodedMessage };
    if (threadId) {
      requestBody.threadId = threadId;
    }

    return this.callGoogleAPI({
      endpoint: "/gmail/v1/users/me/messages/send",
      method: "POST",
      impersonateUserId,
      body: requestBody,
    });
  }

  async getGmailMessage(input: Inputs["getGmailMessage"]): Promise<Result<unknown>> {
    const { messageId, impersonateUserId } = input;

    const result = await this.callGoogleAPI({
      endpoint: `/gmail/v1/users/me/messages/${messageId}`,
      method: "GET",
      impersonateUserId,
      queryParams: { format: "full" },
    });

    if (!result.success) {
      return result;
    }

    const message = result.data as {
      id: string;
      threadId: string;
      snippet: string;
      payload?: {
        headers?: Array<{ name: string; value: string }>;
        body?: { data?: string };
        parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown }>;
      };
    };

    const headers: Record<string, string> = {};
    if (message.payload?.headers) {
      for (const header of message.payload.headers) {
        const name = header.name.toLowerCase();
        if (
          name === "from" ||
          name === "to" ||
          name === "subject" ||
          name === "date" ||
          name === "message-id"
        ) {
          headers[name] = header.value;
        }
      }
    }

    let textBody = "";

    const decodeBase64 = (data: string) => {
      return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    };

    if (message.payload?.body?.data) {
      textBody = decodeBase64(message.payload.body.data);
    } else if (message.payload?.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          textBody = decodeBase64(part.body.data);
          break;
        }
      }
      if (!textBody) {
        for (const part of message.payload.parts) {
          if (part.mimeType === "text/html" && part.body?.data) {
            textBody = decodeBase64(part.body.data);
            break;
          }
        }
      }
    }

    return {
      success: true,
      data: {
        id: message.id,
        threadId: message.threadId,
        snippet: message.snippet,
        from: headers.from,
        to: headers.to,
        subject: headers.subject,
        date: headers.date,
        messageId: headers["message-id"],
        body: textBody,
      },
    };
  }

  async addLabel(input: Inputs["addLabel"]): Promise<Result<unknown>> {
    const { label } = input;
    this.addEvent({ type: "CORE:ADD_LABEL", data: { label } });
    return {
      success: true,
      data: { message: `Label "${label}" added successfully` },
    };
  }

  /**
   * Ingest background task logs (from sandbox runners) into DO storage and emit progress events.
   * Stores logs idempotently in an internal SQL table keyed by process_id and seq.
   */
  async ingestBackgroundLogs(input: {
    processId: string;
    logs: Array<{
      seq: number;
      ts: number;
      stream: "stdout" | "stderr";
      message: string;
      event?: string;
    }>;
  }): Promise<{ lastSeq: number }> {
    const { processId, logs } = input;

    // Record heartbeat for this process
    try {
      this.ctx.storage.sql.exec(
        "UPDATE bg_processes SET last_heartbeat = ? WHERE process_id = ?",
        Date.now(),
        processId,
      );
    } catch {}

    // Get current max seq
    let lastSeq = 0;
    try {
      const rowsCursor = this.ctx.storage.sql.exec<{ max_seq: number | null }>(
        "SELECT MAX(seq) AS max_seq FROM bg_logs WHERE process_id = ?",
        processId,
      );
      const rows = Array.from(rowsCursor, (r) => ({ max_seq: r.max_seq }));
      const maxSeqVal = rows.length > 0 ? rows[0].max_seq : null;
      lastSeq = maxSeqVal !== null && maxSeqVal !== undefined ? Number(maxSeqVal) || 0 : 0;
    } catch {
      lastSeq = 0;
    }

    // Insert new logs idempotently
    const sorted = logs
      .filter((l) => typeof l.seq === "number" && l.seq > lastSeq)
      .sort((a, b) => a.seq - b.seq);
    for (const entry of sorted) {
      try {
        this.ctx.storage.sql.exec(
          "INSERT INTO bg_logs (process_id, seq, ts, stream, message, event) VALUES (?, ?, ?, ?, ?, ?)",
          processId,
          entry.seq,
          Number(entry.ts) || Date.now(),
          entry.stream === "stderr" ? "stderr" : "stdout",
          String(entry.message ?? ""),
          entry.event ?? null,
        );
        lastSeq = entry.seq;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") || msg.includes("constraint")) {
          continue; // duplicate, ignore
        }
        throw err;
      }
    }

    // Aggregate complete logs for this process
    const rowsCursor = this.ctx.storage.sql.exec<{
      seq: number;
      stream: string;
      message: string;
      event: string | null;
    }>(
      "SELECT seq, stream, message, event FROM bg_logs WHERE process_id = ? ORDER BY seq ASC",
      processId,
    );
    const rows = Array.from(rowsCursor, (r) => ({
      seq: Number(r.seq),
      stream: String(r.stream),
      message: String(r.message ?? ""),
      event: r.event ?? undefined,
    }));
    let stdout = "";
    let stderr = "";
    let fullOutput = "";
    let complete = false;
    let failed = false;
    for (const r of rows) {
      fullOutput += String(r.message ?? "");
      if ((r.stream as string) === "stderr") stderr += String(r.message ?? "");
      else stdout += String(r.message ?? "");
      if (r.event && (r.event.includes("SUCCEEDED") || r.event.includes("FAILED"))) {
        complete = true;
        if (r.event.includes("FAILED")) failed = true;
      }
    }

    // Emit progress event
    this.addEvent({
      type: "CORE:BACKGROUND_TASK_PROGRESS",
      data: { processId, stdout, stderr, lastSeq, complete },
    });

    // If complete, add developer message and trigger the model
    if (complete) {
      try {
        this.ctx.storage.sql.exec(
          "UPDATE bg_processes SET status = ? WHERE process_id = ?",
          failed ? "failed" : "succeeded",
          processId,
        );
      } catch {}
      // Optionally format output based on per-process formatter selection (from SQL)
      let formatterFn: ((stdout: string) => string | null) | null = null;
      try {
        const cur = this.ctx.storage.sql.exec<{ formatter: string | null }>(
          "SELECT formatter FROM bg_processes WHERE process_id = ?",
          processId,
        );
        const arr = Array.from(cur, (r) => ({ formatter: r.formatter }));
        const key = arr.length > 0 ? arr[0].formatter : null;
        if (key === "codex") {
          formatterFn = (s: string) => formatCodexOutput(s);
        }
      } catch {}
      const stream = failed ? fullOutput : stdout;
      const formatted = formatterFn ? formatterFn(stream) : truncateLongString(stream, 5_000);
      try {
        this.ctx.storage.sql.exec("DELETE FROM bg_processes WHERE process_id = ?", processId);
      } catch {}
      this.addEvent({
        type: "CORE:LLM_INPUT_ITEM",
        data: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `Background task ${processId} has completed.${
                formatted ? `\n\nOutput:\n${formatted}` : ""
              }`,
            },
          ],
        },
        triggerLLMRequest: true,
      });
    }
    return { lastSeq };
  }

  /**
   * Monitor a background process for heartbeats; if stale > 2 minutes and not complete/failed,
   * post a developer message about timeout.
   */
  async monitorBackgroundProcess(data: { processId: string }) {
    const { processId } = data;
    // Read process metadata from SQL (status + last_heartbeat)
    let status: string | null = null;
    let last = 0;
    try {
      const cur = this.ctx.storage.sql.exec<{
        status: string | null;
        last_heartbeat: number | null;
      }>("SELECT status, last_heartbeat FROM bg_processes WHERE process_id = ?", processId);
      const arr = Array.from(cur, (r) => ({
        status: r.status ?? null,
        last_heartbeat: r.last_heartbeat ?? 0,
      }));
      if (arr.length === 0) {
        // No row means process metadata was cleaned up (completed) or never existed
        return;
      }
      status = arr[0].status ?? "in_progress";
      last = Number(arr[0].last_heartbeat) || 0;
    } catch {
      // If SQL read fails, bail out silently
      return;
    }
    if (status === "succeeded" || status === "failed" || status === "timed_out") {
      return;
    }
    const now = Date.now();
    if (now - last > 120_000) {
      try {
        this.ctx.storage.sql.exec(
          "UPDATE bg_processes SET status = ? WHERE process_id = ?",
          "timed_out",
          processId,
        );
      } catch {}
      this.addEvent({
        type: "CORE:LLM_INPUT_ITEM",
        data: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `Background task ${processId} timed out (no heartbeat for over 2 minutes).`,
            },
          ],
        },
        triggerLLMRequest: true,
      });
      return;
    }
    // Still alive – reschedule another monitor
    await this.schedule(120, "monitorBackgroundProcess", { processId });
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

function hashSessionId(sessionId: string): string {
  // Use sha256 for good entropy, then take first 5 bytes (40 bits = 8 base32 chars)
  const hash = createHash("sha256").update(sessionId).digest();
  const hashSlice = hash.subarray(0, 5); // first 5 bytes
  // Use base32 for file path safe encoding
  const base32 = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let bits = 0,
    value = 0,
    i = 0;
  while (i < hashSlice.length || bits > 0) {
    if (bits < 5) {
      if (i < hashSlice.length) {
        value = (value << 8) | hashSlice[i++];
        bits += 8;
      } else {
        // Padding zero bits if done with all bytes
        value <<= 5 - bits;
        bits = 5;
      }
    }
    out += base32[(value >>> (bits - 5)) & 31];
    bits -= 5;
    if (out.length === 8) break; // Only 8 characters
  }
  return out;
}

/**
 * Truncates a long string to show first N and last N characters with a truncation marker in between.
 * @param str The string to truncate
 * @param maxLength The maximum length before truncation (default: 100)
 * @param showChars The number of characters to show from start and end (default: 50)
 * @returns The original string if short enough, or truncated version with "...[truncated]..." in the middle
 */
function truncateLongString(str: string, maxLength = 100): string {
  const showChars = Math.floor(maxLength / 2);

  if (typeof str !== "string") {
    str = JSON.stringify(str);
  }
  return str.length > maxLength
    ? str.slice(0, showChars) + "...[truncated]..." + str.slice(-showChars)
    : str;
}

/**
 * Best-effort formatter for codex JSONL output streams.
 * Returns a compact human-readable summary or null if the output doesn't look like codex JSONL.
 */
function formatCodexOutput(stdout: string): string {
  if (!stdout) return "";
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  let sawCodexType = false;
  const out: string[] = [];

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // not JSON – keep plain line only if we have no JSON at all
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.type) continue;
    sawCodexType = true;

    switch (parsed.type) {
      case "thread.started":
      case "turn.started":
      case "turn.completed":
        // ignore admin/meta events
        break;
      case "turn.failed":
        out.push("Turn failed");
        break;
      case "item.updated":
        out.push(`item.updated: ${truncateLongString(JSON.stringify(parsed), 250)}`);
        break;
      case "item.completed": {
        const item = parsed.item;
        if (!item || typeof item !== "object") break;
        switch (item.type) {
          case "file_change": {
            if (item.status === "completed") {
              if (item.changes) {
                out.push(`<files changed>\n${JSON.stringify(item.changes)}\n</files changed>`);
              } else {
                out.push(String(item.text ?? "[file_change]"));
              }
            } else {
              out.push(`file_change: ${String(item.status)}`);
            }
            break;
          }
          case "agent_message":
            out.push(String(item.text ?? "[agent_message]"));
            break;
          case "reasoning":
            out.push(
              `<reasoning>\n${truncateLongString(String(item.text ?? "[reasoning]"), 250)}\n</reasoning>`,
            );
            break;
          case "command_execution": {
            if (item.status === "completed") {
              if (item.command) {
                const shortCommand = truncateLongString(String(item.command));
                const shortOutput = truncateLongString(String(item.aggregated_output ?? ""), 500);
                const exitCode = String(item.exit_code ?? "0");
                out.push(
                  `<command executed>\n<command>${shortCommand}</command>\n<aggregated_output>${shortOutput}</aggregated_output>\n<exit_code>${exitCode}</exit_code>\n</command executed>`,
                );
              } else {
                out.push(String(item.text ?? "[command_execution]"));
              }
            } else {
              out.push(`command_execution: ${String(item.status)}`);
            }
            break;
          }
          case "web_search":
            out.push(
              `<web search>\n${truncateLongString(JSON.stringify(item), 250)}\n</web search>`,
            );
            break;
          case "todo_list":
            out.push(`<todo list>\n${String(item)}\n</todo list>`);
            break;
          case "mcp_tool_call":
            out.push(
              `<mcp tool call>\n${truncateLongString(JSON.stringify(item), 250)}\n</mcp tool call>`,
            );
            break;
          default:
            out.push(truncateLongString(JSON.stringify(item), 250));
            break;
        }
        break;
      }
      case "error":
        out.push(truncateLongString(JSON.stringify(parsed)));
        break;
      default:
        // Unknown codex event type -> keep compact JSON
        out.push(truncateLongString(JSON.stringify(parsed)));
        break;
    }
  }

  if (!sawCodexType) {
    // Not codex JSONL – return truncated raw stdout directly
    return truncateLongString(stdout);
  }
  return out.filter(Boolean).join("\n");
}
