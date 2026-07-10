// ─────────────────────────────────────────────────────────────────────────────
// `iterate approve` — be the human in the loop for a project's egress.
//
// The project's egress door parks outbound requests that match a `hold` rule
// and appends `project/human-approval-requested` to the project stream. This
// command is the other half: a tiny local stream processor that live-tails
// those events over normal itx, shows each held request, and appends the
// verdict — `human-approval-granted` (signed with the enrolled key when one
// exists; Touch ID on the enclave path) or `human-approval-rejected`. The
// moment the verdict lands, the Project DO releases (or refuses) the held
// fetch, whose caller has been waiting the whole time.
//
// The prompt deliberately blocks the loop: requests arriving while a human
// is deciding queue on the stream and replay from the cursor afterwards.
// ─────────────────────────────────────────────────────────────────────────────

import * as prompts from "@clack/prompts";
import type { RpcStub } from "capnweb";

import { connectItx } from "../../../apps/os/src/itx-client.ts";
import { buildApprovalMessage } from "../../../apps/os/src/domains/projects/egress-approvals.ts";
import type { ItxAuthCredentials, Project, Stream, StreamEvent } from "./itx-api.generated.ts";
import {
  createApprovalKey,
  loadApprovalKey,
  signApprovalMessage,
  type StoredApprovalKey,
} from "./approval-keys.ts";

const REQUESTED = "events.iterate.com/project/human-approval-requested";
const GRANTED = "events.iterate.com/project/human-approval-granted";
const REJECTED = "events.iterate.com/project/human-approval-rejected";
const KEY_ADDED = "events.iterate.com/project/human-approval-key-added";

/** The requested payload fields this UI renders and signs over. */
type RequestedPayload = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodySha256: string | null;
  bodyPreview: string | null;
  secretPaths: string[];
  ruleKey: string;
  expiresAt: string;
};

export async function runApprovalCli(input: {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  headers?: Record<string, string>;
  enroll?: boolean;
  softwareKey?: boolean;
}): Promise<void> {
  const itx = connectItx({
    auth: input.auth,
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    headers: input.headers,
  }) as RpcStub<Project>;
  const stream = itx.streams.get("/") as RpcStub<Stream>;

  prompts.intro(`iterate approve — project ${input.projectId}`);

  let key = await loadApprovalKey(input.projectId);
  if (input.enroll === true) {
    key = await enroll({
      existing: key,
      projectId: input.projectId,
      softwareKey: input.softwareKey,
      stream,
    });
  }
  prompts.log.info(
    key === null
      ? "No local approval key: grants will be plain events. Run with --enroll to sign approvals."
      : `Grants are signed with ${key.kind} key ${key.keyId} (${key.label}).`,
  );
  prompts.log.step("Waiting for held egress requests... (Ctrl-C to stop)");

  // Live tail from "now"; after the first event the cursor makes every
  // waitForEvent replay-from-offset, so nothing lands unseen while a prompt
  // is open. Each wait is a one-shot with a bounded timeout — timeouts just
  // re-arm from the same cursor.
  let cursor: number | undefined;
  while (true) {
    let event: StreamEvent;
    try {
      event = await stream.waitForEvent({
        ...(cursor === undefined ? {} : { afterOffset: cursor }),
        eventTypes: [REQUESTED],
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Timed out waiting for stream event")) {
        continue;
      }
      throw error;
    }
    cursor = event.offset;
    const payload = event.payload as RequestedPayload;

    if (Date.parse(payload.expiresAt) <= Date.now()) {
      prompts.log.warn(`Skipping #${event.offset} ${payload.method} ${payload.url} — expired.`);
      continue;
    }

    renderHeldRequest(event.offset, payload);
    const approved = await prompts.confirm({
      message: `Approve ${payload.method} ${new URL(payload.url).host}?`,
      initialValue: false,
    });
    if (prompts.isCancel(approved)) {
      prompts.outro("Stopped. Held requests will auto-reject on their timeouts.");
      return;
    }

    if (approved) {
      const grant: { approvalRequestEventOffset: number; keyId?: string; signature?: string } = {
        approvalRequestEventOffset: event.offset,
      };
      if (key !== null) {
        const spinner = prompts.spinner();
        spinner.start(key.kind === "secure-enclave" ? "Signing — check Touch ID..." : "Signing...");
        try {
          grant.keyId = key.keyId;
          grant.signature = await signApprovalMessage(
            key,
            buildApprovalMessage({
              projectId: input.projectId,
              approvalRequestEventOffset: event.offset,
              requested: payload,
              decision: "granted",
            }),
          );
          spinner.stop("Signed.");
        } catch (error) {
          spinner.stop("Signing failed.");
          prompts.log.error(error instanceof Error ? error.message : String(error));
          continue;
        }
      }
      await stream.append({ type: GRANTED, payload: grant });
      prompts.log.success(`Granted #${event.offset} — request released.`);
    } else {
      await stream.append({
        type: REJECTED,
        payload: { approvalRequestEventOffset: event.offset, reason: "human" },
      });
      prompts.log.warn(`Rejected #${event.offset}.`);
    }
  }
}

async function enroll(input: {
  existing: StoredApprovalKey | null;
  projectId: string;
  softwareKey?: boolean;
  stream: RpcStub<Stream>;
}): Promise<StoredApprovalKey> {
  const key =
    input.existing ??
    (await createApprovalKey({
      projectId: input.projectId,
      label: `${process.env.USER ?? "user"}@${process.platform}`,
      software: input.softwareKey,
      log: (message) => prompts.log.info(message),
    }));
  // Idempotent: re-running --enroll re-appends the same key and the reducer
  // ignores known keyIds.
  await input.stream.append({
    type: KEY_ADDED,
    payload: { keyId: key.keyId, publicKey: key.publicKey, label: key.label },
  });
  prompts.log.success(
    `Enrolled ${key.kind} key ${key.keyId}. Grants from this machine now require ${
      key.kind === "secure-enclave" ? "Touch ID" : "this key file"
    }.`,
  );
  return key;
}

function renderHeldRequest(offset: number, payload: RequestedPayload): void {
  const secretLine =
    payload.secretPaths.length === 0
      ? []
      : [
          `spends secret${payload.secretPaths.length > 1 ? "s" : ""}: ${payload.secretPaths.join(", ")}`,
        ];
  const preview =
    payload.bodyPreview !== null && payload.bodyPreview.length > 200
      ? `${payload.bodyPreview.slice(0, 200)}…`
      : payload.bodyPreview;
  const bodyLines =
    preview === null
      ? payload.bodySha256 === null
        ? []
        : [`body: sha256 ${payload.bodySha256.slice(0, 16)}…`]
      : [`body: ${preview}`];
  prompts.note(
    [
      `${payload.method} ${payload.url}`,
      ...secretLine,
      ...bodyLines,
      `rule: ${payload.ruleKey}`,
      `expires: ${payload.expiresAt}`,
    ].join("\n"),
    `Held egress request #${offset}`,
  );
}
