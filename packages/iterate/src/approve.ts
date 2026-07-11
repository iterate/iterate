// ─────────────────────────────────────────────────────────────────────────────
// `iterate approve` — be the human in the loop for a project's egress (the
// terminal front-end).
//
// The project's egress door parks outbound requests that match a `hold` rule
// and appends `project/human-approval-requested` to the project stream. This
// command live-tails those events, shows each held request, and appends the
// verdict — a signed `human-approval-granted` (Touch ID on the enclave path)
// or `human-approval-rejected`. The moment the verdict lands, the Project DO
// releases (or refuses) the held fetch, whose caller has been waiting.
//
// Transport, signing, and stream logic live in approve-core.ts; this file is
// only the clack rendering. The machine (menu-bar) front-end is approve-json.ts.
// ─────────────────────────────────────────────────────────────────────────────

import * as prompts from "@clack/prompts";
import type { RpcStub } from "capnweb";

import type { ItxAuthCredentials, Project, Stream, StreamEvent } from "./itx-api.generated.ts";
import {
  deleteApprovalKey,
  loadApprovalKey,
  promptNativeApproval,
  type StoredApprovalKey,
} from "./approval-keys.ts";
import {
  awaitSettlement,
  connectApproval,
  enrollKey,
  EVENT,
  grant,
  messageFor,
  reject,
  type RequestedPayload,
  type Settlement,
} from "./approve-core.ts";

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
  const { project, stream } = await connectApproval(input);

  prompts.intro(`iterate approve — project ${input.projectId}`);

  let key = await loadApprovalKey(input.projectId);
  if (input.keys === true) return listKeys({ project, localKey: key });
  if (input.revoke === true) return revokeKey({ key, projectId: input.projectId, stream });

  // --native preconditions come BEFORE --enroll: failing after enrolling
  // would leave a key side effect the human didn't ask for.
  const native = input.native === true;
  if (native) {
    if (process.platform !== "darwin") throw new Error("--native is macOS-only.");
    if (input.softwareKey === true) {
      throw new Error("--native needs a Secure Enclave key; drop --software-key.");
    }
    if (key !== null && key.kind !== "secure-enclave") {
      throw new Error(
        "--native needs a Secure Enclave key, but this project's local key is a software key. Revoke it (--revoke) and re-enroll on this Mac.",
      );
    }
    if (key === null && input.enroll !== true) {
      throw new Error("--native needs an enrolled Secure Enclave key: run with --enroll first.");
    }
  }

  if (input.enroll === true) {
    key = await enrollKey({
      existing: key,
      projectId: input.projectId,
      softwareKey: input.softwareKey,
      stream,
      log: (message) => prompts.log.info(message),
    });
    prompts.log.success(
      `Enrolled ${key.kind} key ${key.keyId}. Grants from this machine now require ${
        key.kind === "secure-enclave" ? "Touch ID" : "this key file"
      }.`,
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
        eventTypes: [EVENT.requested],
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

    // The human moment. Native mode: one dialog whose Approve button leads
    // straight into the Touch ID sheet — reading and signing are the same
    // gesture. Terminal mode: y/n, then sign.
    if (native) {
      // A cancelled Touch ID sheet comes back as "ignored"; anything else
      // thrown is structural — broken helper, bad blob — and stops the loop.
      const verdict = await promptNativeApproval({
        key: key as Extract<StoredApprovalKey, { kind: "secure-enclave" }>,
        message: messageFor(input.projectId, event.offset, payload),
        request: payload,
      });
      if (verdict.decision === "ignored") {
        prompts.log.info(`Ignored #${event.offset} — it can be answered elsewhere or expire.`);
        continue;
      }
      if (verdict.decision === "rejected") {
        await reject(stream, event.offset);
        prompts.log.warn(`Rejected #${event.offset}.`);
        continue;
      }
      await grant({
        stream,
        projectId: input.projectId,
        key,
        offset: event.offset,
        payload,
        signature: verdict.signature,
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
      if (!approved) {
        await reject(stream, event.offset);
        prompts.log.warn(`Rejected #${event.offset}.`);
        continue;
      }
      const spinner = prompts.spinner();
      spinner.start(key?.kind === "secure-enclave" ? "Signing — check Touch ID..." : "Signing...");
      try {
        await grant({ stream, projectId: input.projectId, key, offset: event.offset, payload });
        spinner.stop("Signed.");
      } catch (error) {
        spinner.stop("Signing failed.");
        prompts.log.error(error instanceof Error ? error.message : String(error));
        continue;
      }
    }

    // Granting is a claim, not a fact — the egress door verifies the signature
    // and settles the request. Report what actually happened.
    reportSettlement(event.offset, await awaitSettlement(stream, event.offset));
  }
}

/** `--keys`: the project's enrolled approval keys, with this machine's marked. */
async function listKeys(input: {
  project: RpcStub<Project>;
  localKey: StoredApprovalKey | null;
}): Promise<void> {
  const keys = (await input.project.processor.snapshot()).state.humanApprovalKeys;
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
 * `--revoke`: stop the platform accepting this machine's key, then destroy the
 * local material. Order matters — the event is the act that changes what
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
  await input.stream.append({ type: EVENT.keyRevoked, payload: { keyId: input.key.keyId } });
  await deleteApprovalKey(input.projectId);
  prompts.outro(
    `Revoked ${input.key.kind} key ${input.key.keyId} and destroyed the local material. ` +
      "If it was the last active key, grants fall back to plain events.",
  );
}

function reportSettlement(offset: number, settlement: Settlement) {
  switch (settlement.kind) {
    case "released":
      return prompts.log.success(`Released #${offset} — upstream ${settlement.status}.`);
    case "delivery-failed":
      return prompts.log.error(`Released #${offset} but delivery failed: ${settlement.error}`);
    case "rejected":
      return prompts.log.warn(
        `#${offset} was rejected (${settlement.reason}) before the grant landed.`,
      );
    case "unsettled":
      return prompts.log.warn(
        `Grant appended, but #${offset} has not settled — the egress door may have ignored an unverifiable signature, or the hold already expired.`,
      );
  }
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
