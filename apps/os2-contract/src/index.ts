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

export const Project = z.object({
  id: z.string(),
  slug: z.string(),
  clerkOrgId: z.string(),
  createdByClerkUserId: z.string(),
  customHostname: z.string().nullable(),
  metadata: JSONObject,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.output<typeof Project>;

export const SeedMcpProjectResult = z.object({
  mcpUrl: z.string().url(),
  project: Project,
});
export type SeedMcpProjectResult = z.output<typeof SeedMcpProjectResult>;

export const ProjectPreset = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  events: z.array(EventInput),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectPreset = z.output<typeof ProjectPreset>;

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
 * `implement(osContract)` in `apps/os2/src/orpc/orpc.ts` binds the
 * server implementation to this contract, and `os.router({...})` in
 * `apps/os2/src/orpc/root.ts` provides the actual handlers.
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
  codemode: {
    createSession: oc
      .route({
        method: "POST",
        path: "/codemode/sessions",
        description:
          "Create or attach to a Codemode Session, append setup events, and optionally start a Script Execution",
        tags: ["/codemode"],
      })
      .input(
        z.object({
          code: z.string().trim().min(1).optional(),
          events: z.array(EventInput).default([]),
          projectId: z.string(),
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
        path: "/codemode/scripts",
        description:
          "Append a Script Execution request to a Codemode Session and return the committed event",
        tags: ["/codemode"],
      })
      .input(
        z.object({
          code: z.string().min(1),
          events: z.array(EventInput).default([]),
          projectId: z.string(),
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
        path: "/codemode/events/{+streamPath}",
        description: "Read events from a Codemode Session's Event Stream Path",
        tags: ["/codemode"],
      })
      .input(
        z.object({
          afterOffset: StreamCursor.optional(),
          beforeOffset: StreamCursor.optional(),
          streamPath: StreamPath,
        }),
      )
      .output(eventIterator(Event)),
    describe: oc
      .route({
        method: "POST",
        path: "/codemode/describe",
        description: "Render short instructions from tool provider registrations",
        tags: ["/codemode"],
      })
      .input(
        z.object({
          projectId: z.string(),
          providers: CodemodeProviderInput,
        }),
      )
      .output(z.object({ instructions: z.string() })),
  },
  streams: {
    append: oc
      .route({
        method: "POST",
        path: "/streams/{projectId}/{+streamPath}",
        description: "Append an event to an OS2 project stream",
        tags: ["/streams"],
      })
      .input(
        z.object({
          projectId: z.string(),
          streamPath: StreamPath,
          event: EventInput,
        }),
      )
      .output(z.object({ event: Event })),
    read: oc
      .route({
        method: "GET",
        path: "/streams/{projectId}/{+streamPath}",
        description: "Read committed events from an OS2 project stream",
        tags: ["/streams"],
      })
      .input(
        z.object({
          afterOffset: StreamCursor.optional(),
          beforeOffset: StreamCursor.optional(),
          projectId: z.string(),
          streamPath: StreamPath,
        }),
      )
      .output(z.object({ events: z.array(Event) })),
    getState: oc
      .route({
        method: "GET",
        path: "/streams/{projectId}/__state/{+streamPath}",
        description: "Read the reduced state for an OS2 project stream",
        tags: ["/streams"],
      })
      .input(z.object({ projectId: z.string(), streamPath: StreamPath }))
      .output(StreamState),
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
          slug: z
            .string()
            .trim()
            .min(1)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case"),
          metadata: JSONObject.default({}),
        }),
      )
      .output(Project),
    seedMcpProject: oc
      .route({
        method: "POST",
        path: "/projects/seed-mcp-project",
        description:
          "Admin-only preview/operator helper that creates a project and returns its project MCP URL.",
        tags: ["/projects", "/debug"],
      })
      .input(
        z.object({
          clerkOrgId: z.string().trim().min(1).default("org_preview_smoke"),
          metadata: JSONObject.default({}),
          projectId: z.string().trim().min(1).default("proj-preview-mcp-smoke"),
          slug: z
            .string()
            .trim()
            .min(1)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case")
            .default("preview-mcp-smoke"),
          userId: z.string().trim().min(1).default("user_preview_smoke"),
        }),
      )
      .output(SeedMcpProjectResult),
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
      .output(Project),
    findBySlug: oc
      .route({
        method: "GET",
        path: "/projects/by-slug/{slug}",
        description: "Get project by slug in the active organization",
        tags: ["/projects"],
      })
      .input(z.object({ slug: z.string() }))
      .output(Project),
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
          metadata: JSONObject.optional(),
        }),
      )
      .output(Project),
    remove: oc
      .route({
        method: "DELETE",
        path: "/projects/{id}",
        description: "Delete project",
        tags: ["/projects"],
      })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
    presets: {
      list: oc
        .route({
          method: "GET",
          path: "/projects/{projectId}/presets",
          description: "List project presets",
          tags: ["/projects"],
        })
        .input(z.object({ projectId: z.string() }))
        .output(z.object({ presets: z.array(ProjectPreset) })),
      create: oc
        .route({
          method: "POST",
          path: "/projects/{projectId}/presets",
          description: "Create a project preset",
          tags: ["/projects"],
        })
        .input(
          z.object({
            projectId: z.string(),
            name: z.string().trim().min(1),
            description: z.string().trim().nullable().optional(),
            events: z.array(EventInput),
          }),
        )
        .output(ProjectPreset),
      update: oc
        .route({
          method: "PATCH",
          path: "/projects/{projectId}/presets/{id}",
          description: "Update a project preset",
          tags: ["/projects"],
        })
        .input(
          z.object({
            id: z.string(),
            projectId: z.string(),
            name: z.string().trim().min(1),
            description: z.string().trim().nullable().optional(),
            events: z.array(EventInput),
          }),
        )
        .output(ProjectPreset),
      remove: oc
        .route({
          method: "DELETE",
          path: "/projects/{projectId}/presets/{id}",
          description: "Delete a project preset",
          tags: ["/projects"],
        })
        .input(z.object({ id: z.string(), projectId: z.string() }))
        .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
    },
    codemodeSessions: {
      list: oc
        .route({
          method: "GET",
          path: "/projects/{projectId}/codemode-sessions",
          description: "List Codemode Sessions for a project",
          tags: ["/projects"],
        })
        .input(z.object({ projectId: z.string() }))
        .output(z.object({ sessions: z.array(CodemodeSession) })),
      find: oc
        .route({
          method: "GET",
          path: "/projects/{projectId}/codemode-sessions/{name}",
          description: "Get a Codemode Session by catalog name",
          tags: ["/projects"],
        })
        .input(z.object({ name: z.string(), projectId: z.string() }))
        .output(CodemodeSession),
    },
    mcpSessions: {
      list: oc
        .route({
          method: "GET",
          path: "/projects/{projectId}/mcp-sessions",
          description: "List inbound MCP sessions for a project",
          tags: ["/projects"],
        })
        .input(z.object({ projectId: z.string() }))
        .output(z.object({ sessions: z.array(InboundMcpSession) })),
    },
  },
});
