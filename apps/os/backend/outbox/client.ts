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
  };
  /** OS pushed setup data (env vars, repos) to the daemon via tool.writeFile/execCommand. */
  "machine:setup-pushed": {
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

  // ── Email-bot auto-provisioning pipeline ──────────────────────────────
  //
  // email:received-unknown-sender → createEmailBotUser
  //   → email:user-created → createEmailBotOrg
  //     → email:org-created → createEmailBotProject
  //       → email:project-created → provisionEmailBotInfra
  //         → (enters existing machine:created pipeline)
  //           → machine:activated → forwardPendingEmail (via email:pending-forward)

  /** Inbound email from a sender with no user account — triggers auto-provisioning. */
  "email:received-unknown-sender": {
    senderEmail: string;
    senderName: string;
    resendEmailId: string;
    resendPayload: Record<string, unknown>;
    recipientEmail: string;
  };
  /** User account created for an email-bot sender. */
  "email:user-created": {
    userId: string;
    senderEmail: string;
    resendEmailId: string;
    resendPayload: Record<string, unknown>;
    recipientEmail: string;
  };
  /** Organisation created for an email-bot user. */
  "email:org-created": {
    userId: string;
    organizationId: string;
    resendEmailId: string;
    resendPayload: Record<string, unknown>;
    recipientEmail: string;
  };
  /** Project created for an email-bot user — provision infra next. */
  "email:project-created": {
    userId: string;
    organizationId: string;
    projectId: string;
    resendEmailId: string;
    resendPayload: Record<string, unknown>;
    recipientEmail: string;
  };
  /** Machine activated — forward the queued email that triggered provisioning. */
  "email:pending-forward": {
    projectId: string;
    machineId: string;
    resendEmailId: string;
    resendPayload: Record<string, unknown>;
    recipientEmail: string;
    userId: string;
  };
};

type AppRouterEventTypes = RouterEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes & AppRouterEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
