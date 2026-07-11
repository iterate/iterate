import { z } from "zod";
import { AgentProcessorContract } from "~/domains/agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "~/domains/capability-host/capability-host-processor-contract.ts";
import { SlackAgentProcessorContract } from "~/domains/integrations/slack-agent-processor-contract.ts";
import { SlackProcessorContract } from "~/domains/integrations/slack-processor-contract.ts";
import { TelegramAgentProcessorContract } from "~/domains/integrations/telegram-agent-processor-contract.ts";
import { TelegramProcessorContract } from "~/domains/integrations/telegram-processor-contract.ts";
import { ProjectProcessorContract } from "~/domains/projects/project-processor-contract.ts";
import { RepoProcessorContract } from "~/domains/repos/repo-processor-contract.ts";
import { SandboxProcessorContract } from "~/domains/sandboxes/sandbox-processor-contract.ts";
import { SecretProcessorContract } from "~/domains/secrets/secret-processor-contract.ts";
import { BrowserFeedContract } from "~/domains/streams/client-libraries/processors/browser-feed/contract.ts";
import { BrowserRawEventsContract } from "~/domains/streams/client-libraries/processors/browser-raw-events/contract.ts";
import { CoreProcessorContract } from "~/domains/streams/core-processor-contract.ts";

const EVENT_TYPE_PREFIX = "events.iterate.com/";
const EVENT_TYPE_URL_PREFIX = "https://events.iterate.com/";
const PROCESSOR_DOCS_BASE_PATH = "/docs/streams/processors";

type EventDefinitionForDocs = {
  description?: string;
  examples?: readonly { description: string; payload: unknown }[];
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
  CapabilityHostProcessorContract,
  SecretProcessorContract,
  SandboxProcessorContract,
  SlackProcessorContract,
  SlackAgentProcessorContract,
  TelegramProcessorContract,
  TelegramAgentProcessorContract,
  BrowserRawEventsContract,
  BrowserFeedContract,
] as const satisfies readonly ProcessorContractForDocs[];

/**
 * The contracts the public event docs are generated from, in docs order —
 * exported so tests can validate documentation invariants (e.g. that every
 * example payload parses against its event's payload schema) against the same
 * list the site renders.
 */
export const documentedProcessorContracts: readonly ProcessorContractForDocs[] = processorContracts;

export type EventDoc = {
  /** Processors that list this event type in `consumes` (owner included; wildcard consumers excluded). */
  consumedBy: ProcessorReferenceDoc[];
  description?: string;
  /** Processors that list this event type in `emits`. */
  emittedBy: ProcessorReferenceDoc[];
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
  /** Contract slug of the processor that owns (defines) this event type. */
  ownerContractSlug?: string;
  routeParams?: EventRouteParams;
  type: string;
};

export type EventRouteParams = {
  _splat: string;
  processorSlug: string;
};

export type ProcessorDoc = ProcessorReferenceDoc & {
  consumes: EventReferenceDoc[];
  /** True when the contract's `consumes` includes the `"*"` wildcard. */
  consumesAllEvents: boolean;
  dependencies: ProcessorReferenceDoc[];
  /** Processors that list this contract in their `processorDeps`. */
  dependents: ProcessorReferenceDoc[];
  emits: EventReferenceDoc[];
  events: EventDoc[];
};

export type ProcessorReferenceDoc = {
  contractSlug: string;
  description?: string;
  docsPath: string;
  href: string;
  routeParams: { processorSlug: string };
  slug: string;
  version?: string;
};

type EventDocsRouteTarget =
  | { kind: "event"; event: EventDoc }
  | { kind: "processor"; processor: ProcessorDoc };

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

export function getEventDocByProcessorRoute(input: { eventPath: string; processorSlug: string }) {
  const processor = getProcessorDocByPath(input.processorSlug);
  if (!processor) return undefined;

  const event =
    getEventDocByPath(`${processor.slug}/${input.eventPath}`) ?? getEventDocByPath(input.eventPath);
  if (event?.processor.slug !== processor.slug) return undefined;
  return event;
}

export function getEventDocsRouteTarget(input: {
  _splat?: string | undefined;
  eventDocsProcessorSlug: string;
}) {
  if (!input._splat) {
    const processor = getProcessorDocByPath(input.eventDocsProcessorSlug);
    return processor ? ({ kind: "processor", processor } satisfies EventDocsRouteTarget) : null;
  }

  const event = getEventDocByProcessorRoute({
    processorSlug: input.eventDocsProcessorSlug,
    eventPath: input._splat,
  });
  return event ? ({ kind: "event", event } satisfies EventDocsRouteTarget) : null;
}

function buildProcessorDocs(): ProcessorDoc[] {
  const references = processorContracts.map((contract) => processorReferenceDoc(contract));
  const referencesByContractSlug = new Map(
    references.map((processor) => [processor.contractSlug, processor]),
  );

  // Cross-reference indexes over the full contract list, built before any
  // event doc so every event can link back to the processors that consume,
  // emit, or depend on it.
  const consumersByType = new Map<string, ProcessorReferenceDoc[]>();
  const emittersByType = new Map<string, ProcessorReferenceDoc[]>();
  const dependentsByContractSlug = new Map<string, ProcessorReferenceDoc[]>();
  processorContracts.forEach((contract, index) => {
    const reference = references[index];
    for (const type of contract.consumes) {
      if (type === "*") continue;
      pushMapArray(consumersByType, type, reference);
    }
    for (const type of contract.emits ?? []) {
      pushMapArray(emittersByType, type, reference);
    }
    for (const dep of contract.processorDeps ?? []) {
      pushMapArray(dependentsByContractSlug, dep.slug, reference);
    }
  });

  const eventReferencesByType = new Map<string, EventReferenceDoc>();

  const docs = processorContracts.map((contract: ProcessorContractForDocs, index) => {
    const processor = references[index];
    const events = Object.entries(contract.events)
      .map(([type, definition]) =>
        buildEventDoc({
          consumedBy: consumersByType.get(type) ?? [],
          definition,
          emittedBy: emittersByType.get(type) ?? [],
          processor,
          type,
        }),
      )
      .sort((a, b) => a.eventPath.localeCompare(b.eventPath));

    for (const event of events) {
      eventReferencesByType.set(event.type, eventReferenceDoc(event));
    }

    return {
      ...processor,
      consumes: [],
      consumesAllEvents: contract.consumes.includes("*"),
      dependencies: [],
      dependents: [],
      emits: [],
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
      dependents: dependentsByContractSlug.get(contract.slug) ?? [],
      emits: (contract.emits ?? [])
        .map((type) => eventReferencesByType.get(type))
        .filter((event): event is EventReferenceDoc => event != null),
    };
  });
}

function pushMapArray<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value) {
  const values = map.get(key);
  if (values === undefined) {
    map.set(key, [value]);
  } else {
    values.push(value);
  }
}

function processorReferenceDoc(contract: ProcessorContractForDocs): ProcessorReferenceDoc {
  const docsPath = processorDocsPath(contract);
  return {
    ...(contract.description == null ? {} : { description: contract.description }),
    ...(contract.version == null ? {} : { version: contract.version }),
    contractSlug: contract.slug,
    docsPath,
    href: processorDocsPathForSlug(docsPath),
    routeParams: { processorSlug: docsPath },
    slug: docsPath,
  };
}

function buildEventDoc(args: {
  consumedBy: ProcessorReferenceDoc[];
  definition: EventDefinitionForDocs;
  emittedBy: ProcessorReferenceDoc[];
  processor: ProcessorReferenceDoc;
  type: string;
}): EventDoc {
  const eventPath = eventPathFromType(args.type);
  const processorEventPath = eventPathForProcessor({
    eventPath,
    processorSlug: args.processor.slug,
  });
  return {
    ...(args.definition.description == null ? {} : { description: args.definition.description }),
    consumedBy: args.consumedBy,
    emittedBy: args.emittedBy,
    eventPath,
    examples: (args.definition.examples ?? []).map((example) => ({
      description: example.description,
      payload: example.payload,
    })),
    href: `${processorDocsPathForSlug(args.processor.slug)}/events/${processorEventPath}`,
    payloadJsonSchema: z.toJSONSchema(args.definition.payloadSchema, {
      io: "input",
      unrepresentable: "any",
    }),
    processor: args.processor,
    routeParams: {
      processorSlug: args.processor.slug,
      _splat: processorEventPath,
    },
    type: args.type,
  };
}

function eventReferenceDoc(event: EventDoc): EventReferenceDoc {
  return {
    ...(event.description == null ? {} : { description: event.description }),
    href: event.href,
    ownerContractSlug: event.processor.contractSlug,
    routeParams: event.routeParams,
    type: event.type,
  };
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

function processorDocsPathForSlug(processorSlug: string) {
  return `${PROCESSOR_DOCS_BASE_PATH}/${cleanEventPath(processorSlug)}`;
}

function eventPathForProcessor(input: { eventPath: string; processorSlug: string }) {
  const processorPrefix = `${input.processorSlug}/`;
  return input.eventPath.startsWith(processorPrefix)
    ? input.eventPath.slice(processorPrefix.length)
    : input.eventPath;
}
