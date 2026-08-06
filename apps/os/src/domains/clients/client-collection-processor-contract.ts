// The client-collection CONTRACT: the per-project roster of CLIENTS — logical
// endpoints (a browser, a CLI, a desk robot) identified by a caller-chosen
// stream path — reduced from facts copied off the individual client streams.
// A client's presence IS its stream's `stream/connection-opened` /
// `connection-closed` facts: `projects.connect` opens an ordinary stream
// connection on the client's own stream, so the existing connection machinery
// appends those facts (including `departed` when the socket dies and
// `replaced` for an exclusive knock-out). The collection therefore owns only
// its own birth and each client stream's `client/created` birth fact; the
// connection vocabulary resolves through `processorDeps:
// [CoreProcessorContract]`. Ordinary stream watchers also open connections on
// client streams — only openers carrying the descriptor's `client` marker
// count as client presence.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import {
  ConnectionOpenerDescriptor,
  CoreProcessorContract,
} from "../streams/core-processor-contract.ts";

/** One connection on a client stream, as the roster shows it. */
const ClientConnectionRecord = z.object({
  openedAt: z
    .string()
    .meta({ description: "Source-stream commit time of the connection-opened fact." }),
  description: z
    .string()
    .optional()
    .meta({ description: "The opener's self-description, e.g. \"Jonas's Chrome\"." }),
  user: ConnectionOpenerDescriptor.shape.user.meta({
    description: "Self-reported display identity of the connected human, when one rode openedBy.",
  }),
  hasCapabilities: z.boolean().meta({
    description:
      "True when the connection carries a live capabilities target that " +
      "itx.clients.get(path).capabilities.* calls fan out to.",
  }),
  dormant: z
    .boolean()
    .optional()
    .meta({
      description:
        "True after an idle close: the subscriber is parked on its hibernatable wake " +
        "socket, not departed. Cleared by the wake re-dial's next connection-opened.",
    }),
});
type ClientConnectionRecord = z.infer<typeof ClientConnectionRecord>;

/** One client in the roster: a logical endpoint keyed by its stream path. */
const ClientCatalogRecord = z.object({
  path: z.string().meta({ description: "The client's identity — its stream path." }),
  description: z
    .string()
    .optional()
    .meta({ description: "The latest connection's description; the path is the identity." }),
  createdAt: z
    .string()
    .meta({ description: "Source-stream commit time of the client/created birth fact." }),
  connections: z
    .record(z.string(), ClientConnectionRecord)
    .default({})
    .meta({
      description:
        "Open (or dormant) connections keyed by connectionKey. Last-known presence: the " +
        "paired opened/closed facts are best-effort, so capability dispatch consults the " +
        "client stream's live runtime table, never this projection.",
    }),
  lastDisconnectedAt: z
    .string()
    .optional()
    .meta({ description: "Source-stream commit time of the newest non-idle connection close." }),
});
type ClientCatalogRecord = z.infer<typeof ClientCatalogRecord>;

export const ClientCollectionProcessorContract = defineProcessorContract({
  slug: "client-collection",
  version: "0.1.0",
  description:
    "Reduces client stream births and copied connection presence facts into the project's client roster.",
  stateSchema: z.strictObject({
    birthCertificate: z
      .strictObject({})
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until client-collection/created reduces. The payload is " +
          "empty — the collection's identity is its stream path.",
      }),
    clients: z
      .record(z.string(), ClientCatalogRecord)
      .default({})
      .meta({
        description:
          "The client roster: one record per client stream, keyed by path, reduced from " +
          "copied client/created and connection presence facts. Timestamps preserve " +
          "SOURCE-stream chronology, never collection ingest time.",
      }),
  }),
  processorDeps: [CoreProcessorContract],
  events: {
    "events.iterate.com/client-collection/created": {
      description: "Creates the singleton client collection processor for a project.",
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/client/created": {
      description:
        "Births one client stream: appended (idempotently, keyed on the stream path) by " +
        "every projects.connect, so the roster learns the path on the first connect.",
      payloadSchema: z.strictObject({
        path: z.string().meta({ description: "The client's stream path, e.g. /clients/chrome." }),
      }),
    },
  },
  consumes: [
    "events.iterate.com/client-collection/created",
    "events.iterate.com/client/created",
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
  ],
  emits: ["events.iterate.com/client-collection/created"],
});
export type ClientCollectionProcessorContract = typeof ClientCollectionProcessorContract;

/** The singleton client collection processor's reduced roster state. */
export type ClientCollectionProcessorState = ProcessorState<ClientCollectionProcessorContract>;

/** The one canonical stream path a project's client collection lives at. */
export const CLIENT_COLLECTION_PATH = "/clients";
export const CLIENT_COLLECTION_SUBSCRIPTION_KEY = "client-collection";
export const CLIENT_COLLECTION_CREATED_EVENT_TYPE = "events.iterate.com/client-collection/created";
