import { z } from "zod";
import { AgentProcessorContract } from "~/domains/agents/agent-processor-contract.ts";
import { CloudflareAiProcessorContract } from "~/domains/agents/cloudflare-ai-processor-contract.ts";
import { OpenAiWsProcessorContract } from "~/domains/agents/openai-ws-processor-contract.ts";
import { CapabilityHostProcessorContract } from "~/domains/capability-host/capability-host-processor-contract.ts";
import { SlackAgentProcessorContract } from "~/domains/integrations/slack-agent-processor-contract.ts";
import { SlackProcessorContract } from "~/domains/integrations/slack-processor-contract.ts";
import { ProjectProcessorContract } from "~/domains/projects/project-processor-contract.ts";
import { RepoProcessorContract } from "~/domains/repos/repo-processor-contract.ts";
import { SandboxProcessorContract } from "~/domains/sandboxes/sandbox-processor-contract.ts";
import { SecretProcessorContract } from "~/domains/secrets/secret-processor-contract.ts";
import { BrowserEventFeedContract } from "~/domains/streams/client-libraries/processors/browser-event-feed/contract.ts";
import { BrowserRawEventsContract } from "~/domains/streams/client-libraries/processors/browser-raw-events/contract.ts";
import { CoreProcessorContract } from "~/domains/streams/core-processor-contract.ts";

const EVENT_TYPE_PREFIX = "events.iterate.com/";
const EVENT_TYPE_URL_PREFIX = "https://events.iterate.com/";

type EventDefinitionForDocs = {
  description?: string;
  examples?: unknown;
  payloadSchema?: z.ZodType;
};

type ProcessorContractForDocs = {
  consumes: readonly string[];
  description?: string;
  emits?: readonly string[];
  events: Record<string, EventDefinitionForDocs>;
  processorDeps?: readonly unknown[];
  slug: string;
  version?: string;
};

const processorContracts = [
  CoreProcessorContract,
  ProjectProcessorContract,
  RepoProcessorContract,
  AgentProcessorContract,
  CloudflareAiProcessorContract,
  OpenAiWsProcessorContract,
  CapabilityHostProcessorContract,
  SecretProcessorContract,
  SandboxProcessorContract,
  SlackProcessorContract,
  SlackAgentProcessorContract,
  BrowserRawEventsContract,
  BrowserEventFeedContract,
] as const satisfies readonly ProcessorContractForDocs[];

export type EventDoc = {
  description?: string;
  eventPath: string;
  eventSlug: string;
  examples: EventExampleDoc[];
  href: string;
  payloadJsonSchema: unknown;
  processor: ProcessorDoc;
  type: string;
};

export type EventExampleDoc = {
  description: string;
  payload: unknown;
};

export type EventReferenceDoc = {
  description?: string;
  href?: string;
  type: string;
};

export type ProcessorDoc = {
  consumes: EventReferenceDoc[];
  contract: ProcessorContractForDocs;
  docsPath: string;
  events: EventDoc[];
  href: string;
  processorDeps: ProcessorDoc[];
  slug: string;
  unresolvedConsumes: string[];
  unresolvedEmits: string[];
};

export const processorDocs = buildProcessorDocs();
export const eventDocs = processorDocs.flatMap((processor) => processor.events);

const eventsByPath = new Map(eventDocs.map((event) => [event.eventPath, event]));
const eventsByType = new Map(eventDocs.map((event) => [event.type, event]));
const processorsByPath = new Map(processorDocs.map((processor) => [processor.docsPath, processor]));
const processorsBySlug = new Map(
  processorDocs.map((processor) => [processor.contract.slug, processor]),
);

const streamCreatedEvent = eventsByPath.get("stream/created");
if (streamCreatedEvent) eventsByPath.set("stream/create", streamCreatedEvent);

export function getProcessorDocByPath(path: string) {
  const cleanPath = cleanEventPath(path);
  return processorsByPath.get(cleanPath) ?? processorsBySlug.get(cleanPath);
}

export function getEventDocByPath(path: string) {
  return eventsByPath.get(cleanEventPath(path));
}

export function getEventDocByType(type: string) {
  return eventsByType.get(type);
}

function buildProcessorDocs(): ProcessorDoc[] {
  const baseDocs = processorContracts.map((contract) => buildBaseProcessorDoc(contract));
  const docsBySlug = new Map(baseDocs.map((processor) => [processor.contract.slug, processor]));
  const eventReferencesByType = new Map(
    baseDocs.flatMap((processor) =>
      processor.events.map((event) => [
        event.type,
        {
          type: event.type,
          href: event.href,
          description: event.description,
        } satisfies EventReferenceDoc,
      ]),
    ),
  );

  return baseDocs.map((processor) => ({
    ...processor,
    consumes: resolveEventReferences({
      eventReferencesByType,
      types: processor.contract.consumes.filter((type) => type !== "*"),
    }),
    processorDeps: (processor.contract.processorDeps ?? [])
      .map((dep) => (hasProcessorSlug(dep) ? docsBySlug.get(dep.slug) : undefined))
      .filter((dep): dep is ProcessorDoc => dep != null),
    unresolvedConsumes: processor.contract.consumes.filter(
      (type) => type !== "*" && !eventReferencesByType.has(type),
    ),
    unresolvedEmits: (processor.contract.emits ?? []).filter(
      (type) => !eventReferencesByType.has(type),
    ),
  }));
}

function buildBaseProcessorDoc(contract: ProcessorContractForDocs): ProcessorDoc {
  const docsPath = processorDocsPath(contract);
  const processor: ProcessorDoc = {
    contract,
    docsPath,
    href: publicDocsPath(docsPath),
    slug: docsPath,
    events: [],
    consumes: [],
    processorDeps: [],
    unresolvedConsumes: [],
    unresolvedEmits: [],
  };

  processor.events = Object.entries(contract.events)
    .map(([type, definition]) => buildEventDoc({ definition, processor, type }))
    .sort((a, b) => a.eventPath.localeCompare(b.eventPath));

  return processor;
}

function buildEventDoc(args: {
  definition: EventDefinitionForDocs;
  processor: ProcessorDoc;
  type: string;
}): EventDoc {
  const eventPath = eventPathFromType(args.type);
  const examples = eventExamples(args.definition.examples);
  const [, ...eventSlugParts] = eventPath.split("/");
  return {
    ...(args.definition.description == null ? {} : { description: args.definition.description }),
    eventPath,
    eventSlug: eventSlugParts.join("/"),
    examples,
    href: publicDocsPath(eventPath),
    payloadJsonSchema: eventPayloadJsonSchema({
      examples,
      payloadSchema: args.definition.payloadSchema,
    }),
    processor: args.processor,
    type: args.type,
  };
}

function resolveEventReferences(args: {
  eventReferencesByType: ReadonlyMap<string, EventReferenceDoc>;
  types: readonly string[];
}) {
  return args.types
    .map((type) => args.eventReferencesByType.get(type))
    .filter((event): event is EventReferenceDoc => event != null);
}

function eventPayloadJsonSchema(args: {
  examples: readonly { payload: unknown }[];
  payloadSchema: z.ZodType | undefined;
}) {
  if (!args.payloadSchema) return { description: "No payload schema defined." };

  const jsonSchema = z.toJSONSchema(args.payloadSchema, {
    io: "input",
    unrepresentable: "any",
  });

  if (args.examples.length === 0) return jsonSchema;
  if (typeof jsonSchema !== "object" || jsonSchema === null || Array.isArray(jsonSchema)) {
    return jsonSchema;
  }

  return {
    ...jsonSchema,
    examples: args.examples.map((example) => example.payload),
  };
}

function eventExamples(examples: unknown): EventExampleDoc[] {
  if (!Array.isArray(examples)) return [];

  return examples
    .map((example) => {
      if (
        typeof example === "object" &&
        example !== null &&
        "description" in example &&
        "payload" in example &&
        typeof example.description === "string"
      ) {
        return {
          description: example.description,
          payload: example.payload,
        };
      }

      return null;
    })
    .filter((example): example is EventExampleDoc => example != null);
}

function processorDocsPath(contract: ProcessorContractForDocs) {
  const firstEventType = Object.keys(contract.events)[0];
  if (!firstEventType) return contract.slug;
  return eventPathFromType(firstEventType).split("/")[0] ?? contract.slug;
}

function eventPathFromType(type: string) {
  if (type.startsWith(EVENT_TYPE_PREFIX)) {
    return cleanEventPath(type.slice(EVENT_TYPE_PREFIX.length));
  }
  if (type.startsWith(EVENT_TYPE_URL_PREFIX)) {
    return cleanEventPath(type.slice(EVENT_TYPE_URL_PREFIX.length));
  }
  return cleanEventPath(type);
}

function cleanEventPath(path: string) {
  return path.replace(/^\/+|\/+$/g, "");
}

function publicDocsPath(path: string) {
  return `/${cleanEventPath(path)}`;
}

function hasProcessorSlug(value: unknown): value is { slug: string } {
  return (
    typeof value === "object" && value !== null && "slug" in value && typeof value.slug === "string"
  );
}
