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
  payloadSchema: z.ZodType;
};

type ProcessorContractForDocs = {
  consumes: readonly string[];
  description?: string;
  emits?: readonly string[];
  events: Record<string, EventDefinitionForDocs>;
  processorDeps?: readonly { slug: string }[];
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
  examples: EventExampleDoc[];
  href: string;
  payloadJsonSchema: unknown;
  processor: ProcessorReferenceDoc;
  routeParams: EventRouteParams;
  type: string;
};

export type EventExampleDoc = {
  description: string;
  payload: unknown;
};

export type EventReferenceDoc = {
  description?: string;
  href?: string;
  routeParams?: EventRouteParams;
  type: string;
};

export type EventRouteParams = {
  _splat: string;
  eventDocsProcessorSlug: string;
};

export type ProcessorDoc = ProcessorReferenceDoc & {
  consumes: EventReferenceDoc[];
  dependencies: ProcessorReferenceDoc[];
  events: EventDoc[];
  version?: string;
};

export type ProcessorReferenceDoc = {
  contractSlug: string;
  description?: string;
  docsPath: string;
  href: string;
  routeParams: { eventDocsProcessorSlug: string };
  slug: string;
};

export const processorDocs = buildProcessorDocs();
export const eventDocs = processorDocs.flatMap((processor) => processor.events);

const eventsByPath = new Map(eventDocs.map((event) => [event.eventPath, event]));
const eventsByType = new Map(eventDocs.map((event) => [event.type, event]));
const processorsByPath = new Map(processorDocs.map((processor) => [processor.docsPath, processor]));
const processorsByContractSlug = new Map(
  processorDocs.map((processor) => [processor.contractSlug, processor]),
);

const streamCreatedEvent = eventsByPath.get("stream/created");
if (streamCreatedEvent) eventsByPath.set("stream/create", streamCreatedEvent);

export function getProcessorDocByPath(path: string) {
  const cleanPath = cleanEventPath(path);
  return processorsByPath.get(cleanPath) ?? processorsByContractSlug.get(cleanPath);
}

export function getEventDocByPath(path: string) {
  return eventsByPath.get(cleanEventPath(path));
}

export function getEventDocByType(type: string) {
  return eventsByType.get(type);
}

function buildProcessorDocs(): ProcessorDoc[] {
  const references = processorContracts.map((contract) => processorReferenceDoc(contract));
  const referencesByContractSlug = new Map(
    references.map((processor) => [processor.contractSlug, processor]),
  );
  const eventReferencesByType = new Map<string, EventReferenceDoc>();

  const docs = processorContracts.map((contract, index) => {
    const processor = references[index];
    const events = Object.entries(contract.events)
      .map(([type, definition]) => buildEventDoc({ definition, processor, type }))
      .sort((a, b) => a.eventPath.localeCompare(b.eventPath));

    for (const event of events) {
      eventReferencesByType.set(event.type, eventReferenceDoc(event));
    }

    return {
      ...processor,
      ...(contract.version == null ? {} : { version: contract.version }),
      consumes: [],
      dependencies: [],
      events,
    } satisfies ProcessorDoc;
  });

  return docs.map((processor, index) => {
    const contract = processorContracts[index];
    return {
      ...processor,
      consumes: contract.consumes
        .filter((type) => type !== "*")
        .map((type) => eventReferencesByType.get(type))
        .filter((event): event is EventReferenceDoc => event != null),
      dependencies: (contract.processorDeps ?? [])
        .map((dep) => referencesByContractSlug.get(dep.slug))
        .filter((dep): dep is ProcessorReferenceDoc => dep != null),
    };
  });
}

function processorReferenceDoc(contract: ProcessorContractForDocs): ProcessorReferenceDoc {
  const docsPath = processorDocsPath(contract);
  return {
    ...(contract.description == null ? {} : { description: contract.description }),
    contractSlug: contract.slug,
    docsPath,
    href: publicDocsPath(docsPath),
    routeParams: { eventDocsProcessorSlug: docsPath },
    slug: docsPath,
  };
}

function buildEventDoc(args: {
  definition: EventDefinitionForDocs;
  processor: ProcessorReferenceDoc;
  type: string;
}): EventDoc {
  const eventPath = eventPathFromType(args.type);
  const examples = eventExamples(args.definition.examples);
  return {
    ...(args.definition.description == null ? {} : { description: args.definition.description }),
    eventPath,
    examples,
    href: publicDocsPath(eventPath),
    payloadJsonSchema: eventPayloadJsonSchema({
      examples,
      payloadSchema: args.definition.payloadSchema,
    }),
    processor: args.processor,
    routeParams: eventRouteParams(eventPath),
    type: args.type,
  };
}

function eventReferenceDoc(event: EventDoc): EventReferenceDoc {
  return {
    ...(event.description == null ? {} : { description: event.description }),
    href: event.href,
    routeParams: event.routeParams,
    type: event.type,
  };
}

function eventPayloadJsonSchema(args: {
  examples: readonly { payload: unknown }[];
  payloadSchema: z.ZodType;
}) {
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

function eventRouteParams(eventPath: string): EventRouteParams {
  const [eventDocsProcessorSlug = eventPath, ...splatParts] = eventPath.split("/");
  return { eventDocsProcessorSlug, _splat: splatParts.join("/") };
}

function cleanEventPath(path: string) {
  return path.replace(/^\/+|\/+$/g, "");
}

function publicDocsPath(path: string) {
  return `/${cleanEventPath(path)}`;
}
