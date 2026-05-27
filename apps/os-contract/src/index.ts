import { eventIterator, oc } from "@orpc/contract";
import {
  Event,
  EventInput,
  StreamCursor,
  StreamPath,
  StreamState,
} from "@iterate-com/shared/streams/types";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
import { z } from "zod";

const JSONObject = z.record(z.string(), z.unknown());
const CodemodeProviderInput = z.array(z.unknown());
const ProjectScopedInput = z.object({
  projectSlugOrId: z.string(),
});
const AgentLlmProvider = z.enum(["openai-ws", "cloudflare-ai"]);
const AgentPresetEvent = z.object({
  type: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export const Project = z.object({
  id: z.string(),
  slug: z.string(),
  customHostname: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.output<typeof Project>;

const CallerManagedProjectId = z.string().trim().min(1);

export const ProjectCustomHostnameValidationRecord = z.object({
  status: z.string().nullable(),
  txtName: z.string(),
  txtValue: z.string(),
});
export type ProjectCustomHostnameValidationRecord = z.output<
  typeof ProjectCustomHostnameValidationRecord
>;

export const ProjectCustomHostnameCloudflareRecord = z.object({
  hostname: z.string(),
  hostnameStatus: z.string().nullable(),
  id: z.string(),
  kind: z.enum(["exact"]),
  ownershipVerificationName: z.string().nullable(),
  ownershipVerificationValue: z.string().nullable(),
  sslStatus: z.string().nullable(),
  validationRecords: z.array(ProjectCustomHostnameValidationRecord),
  wildcard: z.boolean(),
});
export type ProjectCustomHostnameCloudflareRecord = z.output<
  typeof ProjectCustomHostnameCloudflareRecord
>;

export const ProjectCustomHostnameStatus = z.object({
  cloudflareConfigured: z.boolean(),
  customHostname: z.string().nullable(),
  hostnames: z.array(ProjectCustomHostnameCloudflareRecord),
  message: z.string().nullable(),
  target: z.string().nullable(),
});
export type ProjectCustomHostnameStatus = z.output<typeof ProjectCustomHostnameStatus>;

export const CodemodeSession = z.object({
  name: z.string(),
  projectId: z.string(),
  streamPath: StreamPath,
  createdAt: z.string(),
  lastWokenAt: z.string(),
});
export type CodemodeSession = z.output<typeof CodemodeSession>;

export const InboundMcpSession = z.object({
  name: z.string(),
  projectId: z.string(),
  projectSlug: z.string().nullable(),
  streamPath: StreamPath,
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  userId: z.string(),
  createdAt: z.string(),
  lastWokenAt: z.string(),
});
export type InboundMcpSession = z.output<typeof InboundMcpSession>;

export const StreamCatalogRecord = z.object({
  name: z.string(),
  namespace: z.string(),
  streamPath: StreamPath,
  createdAt: z.string(),
  lastWokenAt: z.string(),
});
export type StreamCatalogRecord = z.output<typeof StreamCatalogRecord>;

export const ProjectIntegrationConnection = z.object({
  connected: z.boolean(),
  externalId: z.string().nullable(),
  displayName: z.string().nullable(),
  metadata: JSONObject,
  scopes: z.string().nullable(),
  token: z
    .object({
      createdAt: z.string(),
      expiresAt: z.string().nullable(),
      hasMaterial: z.boolean(),
      refreshTokenStored: z.boolean(),
      updatedAt: z.string(),
    })
    .nullable(),
});
export type ProjectIntegrationConnection = z.output<typeof ProjectIntegrationConnection>;

export const ProjectSecretSummary = z.object({
  id: z.string(),
  key: z.string(),
  metadata: JSONObject,
  projectId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasMaterial: z.boolean(),
});
export type ProjectSecretSummary = z.output<typeof ProjectSecretSummary>;

export const AgentRecord = z.object({
  agentPath: StreamPath,
  name: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  lastWokenAt: z.string(),
});
export type AgentRecord = z.output<typeof AgentRecord>;

export const RepoRecord = z.object({
  createdAt: z.string(),
  lastWokenAt: z.string(),
  name: z.string(),
  projectId: z.string(),
  repoSlug: z.string(),
});
export type RepoRecord = z.output<typeof RepoRecord>;

export const RepoInfo = z.object({
  defaultBranch: z.string(),
  git: z.object({
    authorizationHeader: z.string(),
    cloneCommand: z.string(),
    commitExampleCommand: z.string(),
    pushCommand: z.string(),
    remote: z.string(),
  }),
  readmePath: z.string(),
  remote: z.string(),
  slug: z.string(),
  token: z.string(),
  tokenExpiresAt: z.string().nullable(),
});
export type RepoInfo = z.output<typeof RepoInfo>;

export const RandomLogStreamRequest = z
  .object({
    count: z
      .number()
      .int("Number of random numbers must be a whole number")
      .min(1, "Number of random numbers must be at least 1")
      .max(500, "Number of random numbers must be at most 500"),
    minDelayMs: z
      .number()
      .int("Minimum delay must be a whole number")
      .min(0, "Minimum delay must be at least 0")
      .max(10_000, "Minimum delay must be at most 10000"),
    maxDelayMs: z
      .number()
      .int("Maximum delay must be a whole number")
      .min(1, "Maximum delay must be at least 1")
      .max(10_000, "Maximum delay must be at most 10000"),
  })
  .superRefine((value, ctx) => {
    if (value.minDelayMs >= value.maxDelayMs) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDelayMs"],
        message: "Maximum delay must be greater than minimum delay",
      });
    }
  });

export const RandomLogStreamFormSchema = z
  .object({
    count: z
      .string()
      .trim()
      .min(1, "Number of random numbers is required")
      .refine((value) => !Number.isNaN(Number(value)), "Number of random numbers must be a number")
      .transform((value) => Number(value))
      .pipe(
        z
          .number()
          .int("Number of random numbers must be a whole number")
          .min(1, "Number of random numbers must be at least 1")
          .max(500, "Number of random numbers must be at most 500"),
      ),
    minDelayMs: z
      .string()
      .trim()
      .min(1, "Minimum delay is required")
      .refine((value) => !Number.isNaN(Number(value)), "Minimum delay must be a number")
      .transform((value) => Number(value))
      .pipe(
        z
          .number()
          .int("Minimum delay must be a whole number")
          .min(0, "Minimum delay must be at least 0")
          .max(10_000, "Minimum delay must be at most 10000"),
      ),
    maxDelayMs: z
      .string()
      .trim()
      .min(1, "Maximum delay is required")
      .refine((value) => !Number.isNaN(Number(value)), "Maximum delay must be a number")
      .transform((value) => Number(value))
      .pipe(
        z
          .number()
          .int("Maximum delay must be a whole number")
          .min(1, "Maximum delay must be at least 1")
          .max(10_000, "Maximum delay must be at most 10000"),
      ),
  })
  .pipe(RandomLogStreamRequest);

export type RandomLogStreamFormValues = z.input<typeof RandomLogStreamFormSchema>;
export type RandomLogStreamRequest = z.infer<typeof RandomLogStreamRequest>;

/**
 * Shared source of truth for the OS app's typed RPC surface.
 *
 * `implement(osContract)` in `apps/os/src/orpc/orpc.ts` binds the
 * server implementation to this contract, and `os.router({...})` in
 * `apps/os/src/orpc/root.ts` provides the actual handlers.
 *
 * The `__internal.*` subtree is the shared app-level operator/debug namespace that
 * all apps may expose under `/__internal/*`, while the rest of this file is the
 * OS app's own domain-specific surface.
 */
export const osContract = oc.router({
  __internal: internalContract,
  ping: oc
    .route({ method: "GET", path: "/ping", description: "Ping", tags: ["/debug"] })
    .input(z.object({}).optional().default({}))
    .output(z.object({ message: z.string(), serverTime: z.string() })),
  test: {
    logDemo: oc
      .route({
        method: "POST",
        path: "/test/log-demo",
        description: "Emit staggered info, warn, and error server logs with structured payloads",
        tags: ["/debug", "/test"],
      })
      .input(z.object({ label: z.string().trim().min(1).default("frontend-button") }))
      .output(
        z.object({
          ok: z.literal(true),
          label: z.string(),
          requestId: z.string(),
          steps: z.array(z.string()),
        }),
      ),
    serverThrow: oc
      .route({
        method: "POST",
        path: "/test/server-throw",
        description: "Throw a real server exception for stack trace testing",
        tags: ["/debug", "/test"],
      })
      .input(
        z.object({
          message: z.string().trim().min(1).default("OS server test exception"),
        }),
      )
      .output(z.never()),
    randomLogStream: oc
      .route({
        method: "POST",
        path: "/test/random-log-stream",
        description: "Stream random log lines with variable delays",
        tags: ["/debug", "/test"],
      })
      .input(RandomLogStreamRequest)
      // `eventIterator(...)` keeps the contract explicit on both server and
      // client for async-iterable responses.
      // https://orpc.dev/docs/event-iterator
      // https://orpc.dev/docs/client/event-iterator
      .output(eventIterator(z.string())),
  },
  projects: {
    create: oc
      .route({
        method: "POST",
        path: "/projects",
        description: "Create a project",
        tags: ["/projects"],
      })
      .input(
        z.object({
          id: CallerManagedProjectId.optional(),
          slug: z
            .string()
            .trim()
            .min(1)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case"),
        }),
      )
      .output(Project.extend({ ingressUrl: z.string().url() })),
    list: oc
      .route({
        method: "GET",
        path: "/projects",
        description: "List projects",
        tags: ["/projects"],
      })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      )
      .output(z.object({ projects: z.array(Project), total: z.number().int().nonnegative() })),
    find: oc
      .route({
        method: "GET",
        path: "/projects/{id}",
        description: "Get project by id",
        tags: ["/projects"],
      })
      .input(z.object({ id: z.string() }))
      .output(Project.extend({ ingressUrl: z.string().url() })),
    findBySlug: oc
      .route({
        method: "GET",
        path: "/projects/by-slug/{slug}",
        description: "Get project by slug in the active organization",
        tags: ["/projects"],
      })
      .input(z.object({ slug: z.string() }))
      .output(Project.extend({ ingressUrl: z.string().url() })),
    updateConfig: oc
      .route({
        method: "PATCH",
        path: "/projects/{id}/config",
        description: "Update project configuration",
        tags: ["/projects"],
      })
      .input(
        z.object({
          id: z.string(),
          customHostname: z.string().trim().nullable().optional(),
        }),
      )
      .output(Project.extend({ ingressUrl: z.string().url() })),
    customHostnameStatus: oc
      .route({
        method: "GET",
        path: "/projects/{id}/custom-hostname-status",
        description: "Read and ensure Cloudflare custom hostname status for a project",
        tags: ["/projects"],
      })
      .input(z.object({ id: z.string() }))
      .output(ProjectCustomHostnameStatus),
    ensureCustomHostname: oc
      .route({
        method: "POST",
        path: "/projects/{id}/custom-hostnames",
        description: "Create or read a concrete Cloudflare custom hostname for a project",
        tags: ["/projects"],
      })
      .input(z.object({ id: z.string(), hostname: z.string().trim().min(1) }))
      .output(ProjectCustomHostnameStatus),
    remove: oc
      .route({
        method: "DELETE",
        path: "/projects/{id}",
        description: "Delete project",
        tags: ["/projects"],
      })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },
  project: {
    get: oc
      .route({
        method: "GET",
        path: "/project/{projectSlugOrId}",
        description: "Get a project by globally unique slug or stable ID",
        tags: ["/project"],
      })
      .input(ProjectScopedInput)
      .output(Project.extend({ ingressUrl: z.string().url() })),
    lifecycleState: oc
      .route({
        method: "GET",
        path: "/projects/{projectSlugOrId}/lifecycle-state",
        description: "Read Project Durable Object lifecycle processor state",
        tags: ["/project"],
      })
      .input(ProjectScopedInput)
      .output(z.unknown()),
    codemode: {
      listSessions: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/codemode-sessions",
          description: "List Codemode Sessions for a project",
          tags: ["/project", "/codemode"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ sessions: z.array(CodemodeSession) })),
      findSession: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/codemode-sessions/{name}",
          description: "Get a Codemode Session by catalog name",
          tags: ["/project", "/codemode"],
        })
        .input(ProjectScopedInput.extend({ name: z.string() }))
        .output(CodemodeSession),
      createSession: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/codemode-sessions",
          description:
            "Create or attach to a Codemode Session, append setup events, and optionally start a Script Execution",
          tags: ["/project", "/codemode"],
        })
        .input(
          ProjectScopedInput.extend({
            code: z.string().trim().min(1).optional(),
            events: z.array(EventInput).default([]),
            providers: CodemodeProviderInput.default([]),
            streamPath: StreamPath.optional(),
          }),
        )
        .output(
          z.object({
            appendedEvents: z.array(Event),
            registeredProviderEvents: z.array(Event),
            scriptExecutionEvent: Event.nullable(),
            session: CodemodeSession,
          }),
        ),
      executeScript: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/codemode-scripts",
          description:
            "Append a Script Execution request to a Codemode Session and return the committed event",
          tags: ["/project", "/codemode"],
        })
        .input(
          ProjectScopedInput.extend({
            code: z.string().min(1),
            events: z.array(EventInput).default([]),
            providers: CodemodeProviderInput.default([]),
            streamPath: StreamPath.optional(),
          }),
        )
        .output(
          z.object({
            event: Event,
            streamPath: StreamPath,
          }),
        ),
      streamEvents: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/codemode-events/{+streamPath}",
          description: "Read events from a Codemode Session's Event Stream Path",
          tags: ["/project", "/codemode"],
        })
        .input(
          ProjectScopedInput.extend({
            afterOffset: StreamCursor.optional(),
            beforeOffset: StreamCursor.optional(),
            streamPath: StreamPath,
          }),
        )
        .output(eventIterator(Event)),
      describe: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/codemode-description",
          description: "Render short instructions from tool provider registrations",
          tags: ["/project", "/codemode"],
        })
        .input(
          ProjectScopedInput.extend({
            providers: CodemodeProviderInput,
          }),
        )
        .output(z.object({ instructions: z.string() })),
    },
    agents: {
      list: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/agents",
          description: "List agents for a project",
          tags: ["/project", "/agents"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ agents: z.array(AgentRecord) })),
      listPresets: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/agents/presets",
          description: "List path-prefix presets for project agents",
          tags: ["/project", "/agents"],
        })
        .input(ProjectScopedInput)
        .output(
          z.object({
            presets: z.array(
              z.object({
                basePath: StreamPath,
                events: z.array(AgentPresetEvent),
              }),
            ),
          }),
        ),
      configurePreset: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/agents/presets",
          description: "Configure a path-prefix preset for project agents",
          tags: ["/project", "/agents"],
        })
        .input(
          ProjectScopedInput.extend({
            basePath: StreamPath,
            events: z.array(AgentPresetEvent).default([]),
            model: z.string().trim().min(1),
            provider: AgentLlmProvider,
            runOpts: z.record(z.string(), z.unknown()).default({}),
            systemPrompt: z.string().trim().min(1),
          }),
        )
        .output(
          z.object({
            basePath: StreamPath,
            eventCount: z.number().int().nonnegative(),
          }),
        ),
      sendMessage: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/agents/messages/{+agentPath}",
          description: "Append a chat message to an agent stream",
          tags: ["/project", "/agents"],
        })
        .input(
          ProjectScopedInput.extend({
            agentPath: StreamPath,
            channel: z.string().trim().min(1).optional(),
            message: z.string().trim().min(1),
          }),
        )
        .output(z.object({ event: Event })),
      runtimeState: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/agents/runtime-state/{+agentPath}",
          description: "Read Agent Durable Object stream processor runtime state",
          tags: ["/project", "/agents"],
        })
        .input(ProjectScopedInput.extend({ agentPath: StreamPath }))
        .output(z.unknown()),
    },
    repos: {
      list: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/repos",
          description: "List Repos for a project",
          tags: ["/project", "/repos"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ repos: z.array(RepoRecord) })),
      create: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/repos",
          description: "Create a Repo for a project",
          tags: ["/project", "/repos"],
        })
        .input(
          ProjectScopedInput.extend({
            slug: z
              .string()
              .trim()
              .min(1, "Repo slug is required")
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Repo slug must be lowercase kebab-case"),
          }),
        )
        .output(RepoInfo),
      get: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/repos/{repoSlug}",
          description: "Get Repo Git access details",
          tags: ["/project", "/repos"],
        })
        .input(
          ProjectScopedInput.extend({
            repoSlug: z
              .string()
              .trim()
              .min(1, "Repo slug is required")
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Repo slug must be lowercase kebab-case"),
          }),
        )
        .output(RepoInfo),
    },
    inboundMcpServer: {
      listSessions: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/mcp-sessions",
          description: "List inbound MCP sessions for a project",
          tags: ["/project", "/mcp"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ sessions: z.array(InboundMcpSession) })),
    },
    integrations: {
      getSlackConnection: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/integrations/slack",
          description: "Get the Slack connection for a project",
          tags: ["/project", "/integrations"],
        })
        .input(ProjectScopedInput)
        .output(ProjectIntegrationConnection),
      startSlackOAuthFlow: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/integrations/slack/oauth",
          description: "Start the Slack OAuth flow for a project",
          tags: ["/project", "/integrations"],
        })
        .input(ProjectScopedInput.extend({ callbackUrl: z.string().optional() }))
        .output(z.object({ authorizationUrl: z.string() })),
      disconnectSlack: oc
        .route({
          method: "DELETE",
          path: "/projects/{projectSlugOrId}/integrations/slack",
          description: "Disconnect Slack from a project",
          tags: ["/project", "/integrations"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ success: z.boolean() })),
      getGoogleConnection: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/integrations/google",
          description: "Get the Google connection for a project",
          tags: ["/project", "/integrations"],
        })
        .input(ProjectScopedInput)
        .output(ProjectIntegrationConnection),
      startGoogleOAuthFlow: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/integrations/google/oauth",
          description: "Start the Google OAuth flow for a project",
          tags: ["/project", "/integrations"],
        })
        .input(ProjectScopedInput.extend({ callbackUrl: z.string().optional() }))
        .output(z.object({ authorizationUrl: z.string() })),
      disconnectGoogle: oc
        .route({
          method: "DELETE",
          path: "/projects/{projectSlugOrId}/integrations/google",
          description: "Disconnect Google from a project",
          tags: ["/project", "/integrations"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ success: z.boolean() })),
    },
    secrets: {
      list: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/secrets",
          description: "List redacted Secrets for a project",
          tags: ["/project", "/secrets"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ secrets: z.array(ProjectSecretSummary) })),
      get: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/secrets/{id}",
          description: "Get a redacted Secret by ID",
          tags: ["/project", "/secrets"],
        })
        .input(ProjectScopedInput.extend({ id: z.string().trim().min(1) }))
        .output(ProjectSecretSummary),
      upsert: oc
        .route({
          method: "PUT",
          path: "/projects/{projectSlugOrId}/secrets",
          description: "Create or update a project Secret by key",
          tags: ["/project", "/secrets"],
        })
        .input(
          ProjectScopedInput.extend({
            key: z.string().trim().min(1),
            material: z.string().min(1),
            metadata: JSONObject.default({}),
          }),
        )
        .output(ProjectSecretSummary),
      remove: oc
        .route({
          method: "DELETE",
          path: "/projects/{projectSlugOrId}/secrets/{id}",
          description: "Delete a project Secret by ID",
          tags: ["/project", "/secrets"],
        })
        .input(ProjectScopedInput.extend({ id: z.string().trim().min(1) }))
        .output(z.object({ deleted: z.boolean() })),
    },
    streams: {
      list: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/streams",
          description: "List initialized streams for a project",
          tags: ["/project", "/streams"],
        })
        .input(ProjectScopedInput)
        .output(z.object({ streams: z.array(StreamCatalogRecord) })),
      create: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/streams",
          description: "Initialize a project stream",
          tags: ["/project", "/streams"],
        })
        .input(ProjectScopedInput.extend({ streamPath: StreamPath }))
        .output(StreamState),
      append: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/streams/events/{+streamPath}",
          description: "Append an event to a project stream",
          tags: ["/project", "/streams"],
        })
        .input(
          ProjectScopedInput.extend({
            streamPath: StreamPath,
            event: EventInput,
          }),
        )
        .output(z.object({ event: Event })),
      appendBatch: oc
        .route({
          method: "POST",
          path: "/projects/{projectSlugOrId}/streams/event-batches/{+streamPath}",
          description: "Append multiple events to a project stream in order",
          tags: ["/project", "/streams"],
        })
        .input(
          ProjectScopedInput.extend({
            streamPath: StreamPath,
            events: z.array(EventInput),
          }),
        )
        .output(z.object({ events: z.array(Event) })),
      read: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/streams/events/{+streamPath}",
          description: "Read committed events from a project stream",
          tags: ["/project", "/streams"],
        })
        .input(
          ProjectScopedInput.extend({
            afterOffset: StreamCursor.optional(),
            beforeOffset: StreamCursor.optional(),
            streamPath: StreamPath,
          }),
        )
        .output(z.object({ events: z.array(Event) })),
      streamEvents: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/streams/event-stream/{+streamPath}",
          description: "Stream committed and live events from a project stream",
          tags: ["/project", "/streams"],
        })
        .input(
          ProjectScopedInput.extend({
            afterOffset: StreamCursor.optional(),
            beforeOffset: StreamCursor.optional(),
            streamPath: StreamPath,
          }),
        )
        .output(eventIterator(Event)),
      getState: oc
        .route({
          method: "GET",
          path: "/projects/{projectSlugOrId}/streams/__state/{+streamPath}",
          description: "Read the reduced state for a project stream",
          tags: ["/project", "/streams"],
        })
        .input(ProjectScopedInput.extend({ streamPath: StreamPath }))
        .output(StreamState),
    },
  },
});
