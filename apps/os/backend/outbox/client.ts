import type { appRouter } from "../orpc/root.ts";
import type { MachineType } from "../db/schema.ts";
import { waitUntil } from "../../env.ts";
import { type RouterEventTypes, createConsumerClient } from "./pgmq-lib.ts";
import { queuer } from "./outbox-queuer.ts";

export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
  /** Machine DB record created — provision it via the sandbox provider. */
  "machine:created": {
    machineId: string;
  };
  /** The daemon called reportStatus (fired on every call, not just "ready"). */
  "machine:daemon-status-reported": {
    machineId: string;
    projectId: string;
    status: string;
    message: string;
    externalId: string | null;
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
  /** A user or system requested a machine/daemon restart. */
  "machine:restart-requested": {
    machineId: string;
    projectId: string;
  };
  /** Machine was promoted to active state. */
  "machine:activated": {
    machineId: string;
    projectId: string;
    detachedMachineIds: string[];
  };
  /** OS pushed setup data (env vars, repos) to the daemon via tool.writeFile/execCommand. */
  "machine:setup-pushed": {
    machineId: string;
    projectId: string;
  };
  /** A request to delete a machine via the provider SDK. */
  "machine:delete-requested": {
    machineId: string;
    type: MachineType;
    externalId: string;
    metadata: Record<string, unknown>;
  };
  /** A custom domain was set on a project — register it with Cloudflare for SaaS. */
  "project:custom-domain-set": {
    projectId: string;
    customDomain: string;
    /** The previous custom domain, if any (needs cleanup). */
    previousCustomDomain: string | null;
  };
  /** A custom domain was removed from a project — delete it from Cloudflare for SaaS. */
  "project:custom-domain-removed": {
    projectId: string;
    customDomain: string;
  };
};

type AppRouterEventTypes = RouterEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes & AppRouterEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
