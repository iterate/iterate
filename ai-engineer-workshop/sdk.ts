import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Procedure } from "@orpc/server";
import { call, os as orpcOs } from "@orpc/server";
import { z } from "zod";
import { eventsContract } from "../apps/events-contract/src/sdk.ts";
import type { EventsORPCClient, ProcessorLogger } from "../apps/events-contract/src/sdk.ts";
import { createWorkshopEventsClient } from "./events-client.ts";

export {
  eventsContract,
  getDiscoveredStreamPath,
  matchesStreamPattern,
  normalizeStreamPattern,
  type EventsORPCClient,
  type ProcessorLogger,
  PullProcessorRuntime,
  PushSubscriptionProcessorRuntime,
  defineBuiltinProcessor,
  defineProcessor,
  EventInput,
  GenericEventInput,
  type BuiltinProcessor,
  type Processor,
  type ProcessorAppendInput,
  type RelativeStreamPath,
} from "../apps/events-contract/src/sdk.ts";
export type { Event, EventType, JSONObject, StreamPath } from "../apps/events-contract/src/sdk.ts";
export * from "./test-helpers.ts";

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
} = {}): EventsORPCClient {
  return createWorkshopEventsClient({
    baseUrl,
    closeConnection: true,
    projectSlug,
  });
}

export function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}

/**
 * Path prefix for plain `tsx` workshop scripts (`workshop2/`).
 * Uses `process.env.PATH_PREFIX || "/"`; non-root values without a leading `/` are normalized.
 */
export function workshopPathPrefix(): string {
  const raw = process.env.PATH_PREFIX || "/";
  if (raw === "/") {
    return "/";
  }
  return normalizePathPrefix(raw);
}

/** Logger for processor runtimes when every level should go to `console.log`. */
export const workshopLogger: ProcessorLogger = {
  debug: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.log(...args),
  info: (...args: unknown[]) => console.log(...args),
  log: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.log(...args),
};

export function getDefaultWorkshopPathPrefix() {
  return normalizePathPrefix(process.env.PATH_PREFIX || `/${execSync("id -un").toString().trim()}`);
}

export function getDefaultWorkshopLogLevel(): WorkshopLogLevel {
  const parsed = WorkshopLogLevel.safeParse(process.env.LOG_LEVEL);
  return parsed.success ? parsed.data : "debug";
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

export function isMainModule(importMetaUrl: string) {
  if (!process.argv[1]) {
    return false;
  }

  return importMetaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

export function runWorkshopMain(
  importMetaUrl: string,
  run: (pathPrefix?: string) => Promise<void>,
) {
  if (!isMainModule(importMetaUrl)) {
    return;
  }

  process.env.PATH_PREFIX ||= getDefaultWorkshopPathPrefix();

  void run(process.env.PATH_PREFIX).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export function runIfMain(
  importMetaUrl: string,
  procedure: Procedure<any, any, any, any, any, any>,
) {
  if (!isMainModule(importMetaUrl)) {
    return;
  }

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
