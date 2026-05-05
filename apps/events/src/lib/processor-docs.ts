import { z } from "zod";
import { AgentProcessorContract } from "@iterate-com/shared/stream-processors/agent/contract";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/codemode/contract";
import { DynamicWorkerProcessorContract } from "@iterate-com/shared/stream-processors/dynamic-worker/contract";
import { JsonataTransformerProcessorContract } from "@iterate-com/shared/stream-processors/jsonata-transformer/contract";
import { SchedulingProcessorContract } from "@iterate-com/shared/stream-processors/scheduling/contract";
import { SlackThreadProcessorContract } from "@iterate-com/shared/stream-processors/slack-thread/contract";
import { SlackProcessorContract } from "@iterate-com/shared/stream-processors/slack/contract";
import { WebchatProcessorContract } from "@iterate-com/shared/stream-processors/webchat/contract";
import { CoreStreamProcessorContract } from "~/stream-processors/core/contract.ts";

const processorContracts = [
  CoreStreamProcessorContract,
  AgentProcessorContract,
  WebchatProcessorContract,
  SlackProcessorContract,
  SlackThreadProcessorContract,
  CodemodeProcessorContract,
  SchedulingProcessorContract,
  JsonataTransformerProcessorContract,
  DynamicWorkerProcessorContract,
] as const;

type ProcessorContractForDocs = (typeof processorContracts)[number];

export type ProcessorEventDoc = {
  processor: ProcessorContractForDocs;
  type: string;
  eventSlug: string;
  description?: string;
  payloadJsonSchema: unknown;
  href: string;
};

export type ProcessorDoc = {
  contract: ProcessorContractForDocs;
  href: string;
  events: ProcessorEventDoc[];
  consumes: ProcessorEventDoc[];
  emits: ProcessorEventDoc[];
  processorDeps: ProcessorDoc[];
};

/**
 * Processor contract docs generated from the contract objects we ship in the
 * Events app.
 *
 * This deliberately replaces the old hand-written event page catalog. A page
 * exists only if a processor contract owns the event schema.
 */
export const processorDocs = buildProcessorDocs();

export const eventInputTemplates = processorDocs.flatMap((processor) =>
  processor.events.map((event) => ({
    id: `${processor.contract.slug}:${event.eventSlug}`,
    label: `${processor.contract.slug}/${event.eventSlug}`,
    event: {
      type: event.type,
      payload: {},
    },
  })),
);

export function getProcessorDocBySlug(slug: string) {
  return processorDocs.find((processor) => processor.contract.slug === slug);
}

export function getProcessorEventDoc(args: { processorSlug: string; eventSlug: string }) {
  return getProcessorDocBySlug(args.processorSlug)?.events.find(
    (event) => event.eventSlug === args.eventSlug,
  );
}

export function getProcessorEventDocByType(type: string) {
  for (const processor of processorDocs) {
    const event = processor.events.find((candidate) => candidate.type === type);
    if (event != null) return event;
  }

  return null;
}

export function getEventInputTemplateById(id: string) {
  return eventInputTemplates.find((template) => template.id === id);
}

function buildProcessorDocs(): ProcessorDoc[] {
  const baseDocs = processorContracts.map((contract) => buildBaseProcessorDoc(contract));
  const docsBySlug = new Map(baseDocs.map((processor) => [processor.contract.slug, processor]));
  const eventsByType = buildEventsByType(baseDocs);

  return baseDocs.map((processor) => ({
    ...processor,
    consumes: resolveEventDocs({ eventsByType, types: processor.contract.consumes }),
    emits: resolveEventDocs({ eventsByType, types: processor.contract.emits }),
    processorDeps: processor.contract.processorDeps
      .map((dep) => (hasProcessorSlug(dep) ? docsBySlug.get(dep.slug) : undefined))
      .filter((dep): dep is ProcessorDoc => dep != null),
  }));
}

function buildBaseProcessorDoc(contract: ProcessorContractForDocs): ProcessorDoc {
  const href = `/${contract.slug}/`;
  const events = Object.entries(contract.events).map(([type, event]) => ({
    processor: contract,
    type,
    eventSlug: eventSlugFromType({ processorSlug: contract.slug, type }),
    ...(event.description == null ? {} : { description: event.description }),
    payloadJsonSchema: eventPayloadJsonSchema(event.payloadSchema as z.ZodType),
    href: `${href}${eventSlugFromType({ processorSlug: contract.slug, type })}/`,
  }));

  return {
    contract,
    href,
    events,
    consumes: [],
    emits: [],
    processorDeps: [],
  };
}

function buildEventsByType(processors: readonly ProcessorDoc[]) {
  const eventsByType = new Map<string, ProcessorEventDoc>();
  for (const processor of processors) {
    for (const event of processor.events) {
      const existing = eventsByType.get(event.type);
      if (existing != null) {
        throw new Error(
          `Duplicate processor event type ${event.type} owned by ${existing.processor.slug} and ${processor.contract.slug}.`,
        );
      }

      eventsByType.set(event.type, event);
    }
  }

  return eventsByType;
}

function resolveEventDocs(args: {
  eventsByType: ReadonlyMap<string, ProcessorEventDoc>;
  types: readonly string[];
}) {
  return args.types
    .map((type) => args.eventsByType.get(type))
    .filter((event): event is ProcessorEventDoc => event != null);
}

function hasProcessorSlug(value: unknown): value is { slug: string } {
  return (
    typeof value === "object" && value !== null && "slug" in value && typeof value.slug === "string"
  );
}

function eventPayloadJsonSchema(payloadSchema: z.ZodType) {
  return z.toJSONSchema(payloadSchema, {
    io: "input",
    unrepresentable: "any",
  });
}

function eventSlugFromType(args: { processorSlug: string; type: string }) {
  const prefix = `events.iterate.com/${args.processorSlug}/`;
  if (args.type.startsWith(prefix)) return args.type.slice(prefix.length);
  return args.type.split("/").at(-1) ?? args.type;
}
