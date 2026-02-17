import type { appRouter } from "../trpc/root.ts";
import type { MachineType } from "../db/schema.ts";
import { waitUntil } from "../../env.ts";
import { type TrpcEventTypes, createConsumerClient } from "./pgmq-lib.ts";
import { queuer } from "./outbox-queuer.ts";

export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
  /** The daemon reported it is ready and the machine is provisioned (externalId exists). */
  "machine:daemon-ready": {
    machineId: string;
    projectId: string;
  };
  /** A readiness probe webchat message was successfully sent to the machine. */
  "machine:probe-sent": {
    machineId: string;
    projectId: string;
    threadId: string;
    messageId: string;
  };
  /** The readiness probe received a valid response. */
  "machine:probe-succeeded": {
    machineId: string;
    projectId: string;
    responseText: string;
  };
  /** The readiness probe failed (timeout or wrong answer). */
  "machine:probe-failed": {
    machineId: string;
    projectId: string;
    detail: string;
    attempt: number;
  };
  /** Machine provisioning failed (provider error). */
  "machine:provisioning-failed": {
    machineId: string;
    projectId: string;
    detail: string;
  };
  /** A user or system requested a machine/daemon restart. */
  "machine:restart-requested": {
    machineId: string;
    projectId: string;
  };
  /** Machine was promoted to active state. */
  "machine:activated": {
    machineId: string;
    projectId: string;
  };
  /** A request to archive a machine via the provider SDK. */
  "machine:archive-requested": {
    machineId: string;
    type: MachineType;
    externalId: string;
    metadata: Record<string, unknown>;
  };
};

type AppTrpcEventTypes = TrpcEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes & AppTrpcEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
