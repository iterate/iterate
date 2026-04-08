import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Procedure } from "@orpc/server";
import { call, os as orpcOs } from "@orpc/server";
import { z } from "zod";
import { eventsContract } from "../apps/events-contract/src/orpc-contract.ts";
import type { ProcessorLogger } from "../apps/events-contract/src/sdk.ts";

export {
  eventsContract,
  type EventsORPCClient,
  type ProcessorLogger,
  PullSubscriptionProcessorRuntime,
  PullSubscriptionPatternProcessorRuntime,
} from "../apps/events-contract/src/sdk.ts";
export { EventInput, GenericEventInput } from "../apps/events-contract/src/types.ts";
export type {
  Event,
  EventType,
  JSONObject,
  StreamPath,
} from "../apps/events-contract/src/types.ts";
export {
  defineProcessor,
  type Processor,
  type ProcessorAppendInput,
} from "../apps/events/src/durable-objects/define-processor.ts";
export * from "./test-helpers.ts";

const iterateProjectHeader = "x-iterate-project";
const defaultBaseUrl = "https://events.iterate.com";
const workshopLogLevels = ["debug", "info", "warn", "error"] as const;

export const WorkshopLogLevel = z.enum(workshopLogLevels);
export type WorkshopLogLevel = z.infer<typeof WorkshopLogLevel>;
export type WorkshopProcedureContext = {
  logger: ProcessorLogger;
};

export function createEventsClient({
  baseUrl = process.env.BASE_URL || defaultBaseUrl,
  projectSlug,
}: {
  baseUrl?: string;
  projectSlug?: string;
} = {}): ContractRouterClient<typeof eventsContract> {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
      ...(projectSlug != null && {
        fetch: (request: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
          headers.set("connection", "close");
          headers.set(iterateProjectHeader, projectSlug);
          return fetch(request, { ...init, headers });
        },
      }),
    }),
  ) as ContractRouterClient<typeof eventsContract>;
}

export function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}

export function getDefaultWorkshopPathPrefix() {
  return normalizePathPrefix(process.env.PATH_PREFIX || `/${execSync("id -un").toString().trim()}`);
}

export function getDefaultWorkshopLogLevel(): WorkshopLogLevel {
  const parsed = WorkshopLogLevel.safeParse(process.env.LOG_LEVEL);
  return parsed.success ? parsed.data : "info";
}

export function createWorkshopLogger({ level }: { level: WorkshopLogLevel }): ProcessorLogger {
  const thresholdByLevel: Record<WorkshopLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  const activeThreshold = thresholdByLevel[level];

  const shouldLog = (messageLevel: WorkshopLogLevel) =>
    thresholdByLevel[messageLevel] >= activeThreshold;

  return {
    debug: (...args: unknown[]) => {
      if (shouldLog("debug")) {
        console.debug(...args);
      }
    },
    info: (...args: unknown[]) => {
      if (shouldLog("info")) {
        console.info(...args);
      }
    },
    log: (...args: unknown[]) => {
      if (shouldLog("info")) {
        console.log(...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (shouldLog("warn")) {
        console.warn(...args);
      }
    },
    error: (...args: unknown[]) => {
      if (shouldLog("error")) {
        console.error(...args);
      }
    },
  };
}

export const WorkshopProcedureInput = z.object({
  logLevel: WorkshopLogLevel.default(getDefaultWorkshopLogLevel()).describe(
    `logger verbosity: ${workshopLogLevels.join(", ")}`,
  ),
  pathPrefix: z
    .string()
    .default(process.env.PATH_PREFIX || getDefaultWorkshopPathPrefix())
    .describe("stream path prefix, e.g. /jonas"),
});

const workshopBase = orpcOs;

export function withWorkshopInput<TShape extends z.ZodRawShape>(schema: z.ZodObject<TShape>) {
  const conflictingKeys = Object.keys(schema.shape).filter(
    (key) => key in WorkshopProcedureInput.shape,
  );

  if (conflictingKeys.length > 0) {
    throw new Error(
      `Custom workshop input cannot redefine reserved keys: ${conflictingKeys.join(", ")}`,
    );
  }

  return WorkshopProcedureInput.extend(schema.shape);
}

function createWorkshopProcedure<TShape extends z.ZodRawShape>(inputSchema: z.ZodObject<TShape>) {
  return workshopBase.input(inputSchema).use(async ({ next }, input) => {
    const parsedInput = WorkshopProcedureInput.parse(input);
    return next({
      context: {
        logger: createWorkshopLogger({ level: parsedInput.logLevel }),
      },
    });
  });
}

const baseWorkshopProcedure = createWorkshopProcedure(WorkshopProcedureInput);

export const os = Object.assign(baseWorkshopProcedure, {
  input<TShape extends z.ZodRawShape>(schema: z.ZodObject<TShape>) {
    return createWorkshopProcedure(withWorkshopInput(schema));
  },
});

export function runIfMain(
  importMetaUrl: string,
  procedure: Procedure<any, any, any, any, any, any>,
) {
  if (!process.argv[1] || importMetaUrl !== pathToFileURL(resolve(process.argv[1])).href) return;

  process.env.PATH_PREFIX ||= getDefaultWorkshopPathPrefix();
  const logLevel = getDefaultWorkshopLogLevel();
  process.env.LOG_LEVEL = logLevel;

  void call(procedure, {
    logLevel,
    pathPrefix: process.env.PATH_PREFIX,
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
