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
import {
  buildApprovalMessage,
  type HumanApprovalRequestedPayload,
} from "../../../apps/os/src/domains/projects/egress-approvals.ts";
import type { ItxAuthCredentials, Project, Stream, StreamEvent } from "./itx-api.generated.ts";
import {
  createApprovalKey,
  deleteApprovalKey,
  loadApprovalKey,
  promptNativeApproval,
  signApprovalMessage,
  type StoredApprovalKey,
} from "./approval-keys.ts";

const REQUESTED = "events.iterate.com/project/human-approval-requested";
const GRANTED = "events.iterate.com/project/human-approval-granted";
const REJECTED = "events.iterate.com/project/human-approval-rejected";
const SETTLED = "events.iterate.com/project/human-approval-settled";
const KEY_ADDED = "events.iterate.com/project/human-approval-key-added";
const KEY_REVOKED = "events.iterate.com/project/human-approval-key-revoked";

export async function runApprovalCli(input: {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  headers?: Record<string, string>;
  enroll?: boolean;
  softwareKey?: boolean;
  native?: boolean;
  revoke?: boolean;
  keys?: boolean;
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
  if (input.keys === true) return listKeys({ itx, localKey: key });
  if (input.revoke === true) return revokeKey({ key, projectId: input.projectId, stream });

  if (input.enroll === true) {
    key = await enroll({
      existing: key,
      projectId: input.projectId,
      softwareKey: input.softwareKey,
      stream,
    });
  }
  const native = input.native === true;
  if (native && key?.kind !== "secure-enclave") {
    throw new Error(
      "--native needs a Secure Enclave key: run `iterate approve --enroll` on this Mac (without --software-key).",
    );
  }
  prompts.log.info(
    key === null
      ? "No local approval key: grants will be plain events. Run with --enroll to sign approvals."
      : `Grants are signed with ${key.kind} key ${key.keyId} (${key.label}).`,
  );
  prompts.log.step(
    native
      ? "Waiting for held egress requests — approvals pop native dialogs... (Ctrl-C to stop)"
      : "Waiting for held egress requests... (Ctrl-C to stop)",
  );

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
    const payload = event.payload as HumanApprovalRequestedPayload;

    if (Date.parse(payload.expiresAt) <= Date.now()) {
      prompts.log.warn(`Skipping #${event.offset} ${payload.method} ${payload.url} — expired.`);
      continue;
    }

    renderHeldRequest(event.offset, payload);
    const message = buildApprovalMessage({
      projectId: input.projectId,
      approvalRequestEventOffset: event.offset,
      requested: payload,
      decision: "granted",
    });

    // The human moment. Native mode: one dialog whose Approve button leads
    // straight into the Touch ID sheet — reading and signing are the same
    // gesture. Terminal mode: y/n, then sign.
    let verdict: { decision: "granted"; signature?: string } | { decision: "rejected" | "ignored" };
    if (native) {
      verdict = await promptNativeApproval({
        key: key as Extract<StoredApprovalKey, { kind: "secure-enclave" }>,
        message,
        request: payload as unknown as Record<string, unknown>,
      });
    } else {
      const approved = await prompts.confirm({
        message: `Approve ${payload.method} ${new URL(payload.url).host}?`,
        initialValue: false,
      });
      if (prompts.isCancel(approved)) {
        prompts.outro("Stopped. Held requests will auto-reject on their timeouts.");
        return;
      }
      verdict = { decision: approved ? "granted" : "rejected" };
      if (approved && key !== null) {
        const spinner = prompts.spinner();
        spinner.start(key.kind === "secure-enclave" ? "Signing — check Touch ID..." : "Signing...");
        try {
          verdict = { decision: "granted", signature: await signApprovalMessage(key, message) };
          spinner.stop("Signed.");
        } catch (error) {
          spinner.stop("Signing failed.");
          prompts.log.error(error instanceof Error ? error.message : String(error));
          continue;
        }
      }
    }

    if (verdict.decision === "ignored") {
      prompts.log.info(`Ignored #${event.offset} — it can be answered elsewhere or expire.`);
      continue;
    }
    if (verdict.decision === "rejected") {
      await stream.append({
        type: REJECTED,
        payload: { approvalRequestEventOffset: event.offset, reason: "human" },
      });
      prompts.log.warn(`Rejected #${event.offset}.`);
      continue;
    }
    await stream.append({
      type: GRANTED,
      payload: {
        approvalRequestEventOffset: event.offset,
        ...(key === null ? {} : { keyId: key.keyId, signature: verdict.signature }),
      },
    });
    // Granting is a claim, not a fact — the egress door verifies the
    // signature and settles the request. Report what actually happened.
    await reportSettlement({ approvalRequestEventOffset: event.offset, stream });
  }
}

/** `--keys`: the project's enrolled approval keys, with this machine's marked. */
async function listKeys(input: {
  itx: RpcStub<Project>;
  localKey: StoredApprovalKey | null;
}): Promise<void> {
  const snapshot = await input.itx.processor.snapshot();
  const keys = snapshot.state.humanApprovalKeys;
  if (keys.length === 0) {
    prompts.outro("No approval keys enrolled — grants are plain events. Enroll with --enroll.");
    return;
  }
  for (const key of keys) {
    const marks = [
      key.keyId === input.localKey?.keyId ? "this machine" : null,
      key.revokedAt === null ? null : `revoked ${key.revokedAt}`,
    ].filter((mark) => mark !== null);
    prompts.log.info(
      `${key.keyId}  ${key.label}  added ${key.addedAt}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`,
    );
  }
  prompts.outro(`${keys.filter((key) => key.revokedAt === null).length} active key(s).`);
}

/**
 * `--revoke`: stop the platform accepting this machine's key, then destroy
 * the local material. Order matters — the event is the act that changes what
 * grants are accepted; local deletion is just hygiene after it.
 */
async function revokeKey(input: {
  key: StoredApprovalKey | null;
  projectId: string;
  stream: RpcStub<Stream>;
}): Promise<void> {
  if (input.key === null) {
    prompts.outro("No local approval key for this project — nothing to revoke.");
    return;
  }
  await input.stream.append({ type: KEY_REVOKED, payload: { keyId: input.key.keyId } });
  await deleteApprovalKey(input.projectId);
  prompts.outro(
    `Revoked ${input.key.kind} key ${input.key.keyId} and destroyed the local material. ` +
      "If it was the last active key, grants fall back to plain events.",
  );
}

/**
 * Watch for the held request's settlement and report the truth: released
 * with an upstream status, failed delivery, rejected meanwhile, or — if
 * nothing lands in time — that the platform hasn't accepted the grant (an
 * unverifiable signature is silently ignored server-side by design).
 */
async function reportSettlement(input: {
  approvalRequestEventOffset: number;
  stream: RpcStub<Stream>;
}): Promise<void> {
  const spinner = prompts.spinner();
  spinner.start("Waiting for the egress door to settle the request...");
  try {
    const settled = await input.stream.waitForEvent({
      afterOffset: input.approvalRequestEventOffset,
      eventTypes: [SETTLED, REJECTED],
      predicate: (candidate) =>
        (candidate.payload as { approvalRequestEventOffset?: number })
          .approvalRequestEventOffset === input.approvalRequestEventOffset,
      timeoutMs: 30_000,
    });
    const outcome = settled.payload as { status?: number; error?: string; reason?: string };
    if (settled.type === SETTLED && outcome.error === undefined) {
      spinner.stop(`Released #${input.approvalRequestEventOffset} — upstream ${outcome.status}.`);
    } else if (settled.type === SETTLED) {
      spinner.stop(
        `Released #${input.approvalRequestEventOffset} but delivery failed: ${outcome.error}`,
      );
    } else {
      spinner.stop(
        `#${input.approvalRequestEventOffset} was rejected (${outcome.reason}) before the grant landed.`,
      );
    }
  } catch {
    spinner.stop(
      `Grant appended, but #${input.approvalRequestEventOffset} has not settled — the egress door may have ignored an unverifiable signature, or the hold already expired.`,
    );
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
