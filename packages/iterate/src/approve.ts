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
import type { RpcStub } from "@iterate-com/capnweb";

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
  reconcileBacklog,
  reject,
  safeHost,
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
  // Offer one held request until a terminal outcome, or return "stop" if the
  // human cancels (Ctrl-C) so the caller can exit. Shared by the backlog pass
  // and the live tail. A grant the door ignores (unenrolled/revoked key →
  // "unsettled") is re-offered rather than dropped; declining leaves it held.
  const offerHeldRequest = async (
    offset: number,
    payload: RequestedPayload,
  ): Promise<"stop" | "next"> => {
    if (Date.parse(payload.expiresAt) <= Date.now()) {
      prompts.log.warn(`Skipping #${offset} ${payload.method} ${payload.url} — expired.`);
      return "next";
    }

    renderHeldRequest(offset, payload);

    while (Date.parse(payload.expiresAt) > Date.now()) {
      // The human moment. Native mode: one dialog whose Approve button leads
      // straight into the Touch ID sheet. Terminal mode: y/n, then sign.
      let signature: string | undefined;
      if (native) {
        // A cancelled Touch ID sheet comes back as "ignored"; anything else
        // thrown is structural — broken helper, bad blob — and stops the loop.
        const verdict = await promptNativeApproval({
          key: key as Extract<StoredApprovalKey, { kind: "secure-enclave" }>,
          message: messageFor(input.projectId, offset, payload),
          request: payload,
        });
        if (verdict.decision === "granted") {
          signature = verdict.signature;
        } else if (verdict.decision === "ignored") {
          prompts.log.info(`Ignored #${offset} — it can be answered elsewhere or expire.`);
          return "next";
        } else {
          await reject(stream, offset);
          prompts.log.warn(`Rejected #${offset}.`);
          return "next";
        }
      } else {
        const approved = await prompts.confirm({
          message: `Approve ${payload.method} ${safeHost(payload.url)}?`,
          initialValue: false,
        });
        if (prompts.isCancel(approved)) {
          prompts.outro("Stopped. Held requests will auto-reject on their timeouts.");
          return "stop";
        }
        if (!approved) {
          await reject(stream, offset);
          prompts.log.warn(`Rejected #${offset}.`);
          return "next";
        }
      }

      // Native already signed inside the dialog (signature set); the terminal
      // path signs here, which is where Touch ID pops for an enclave key.
      const spinner = prompts.spinner();
      spinner.start(
        signature !== undefined
          ? "Submitting…"
          : key?.kind === "secure-enclave"
            ? "Signing — check Touch ID..."
            : "Signing...",
      );
      try {
        await grant({ stream, projectId: input.projectId, key, offset, payload, signature });
        spinner.stop("Signed.");
      } catch (error) {
        spinner.stop("Signing failed.");
        prompts.log.error(error instanceof Error ? error.message : String(error));
        return "next";
      }

      // Granting is a claim, not a fact — the door verifies and settles.
      const settlement = await settleWithRetry(stream, offset);
      reportSettlement(offset, settlement);
      if (settlement.kind !== "unsettled") return "next"; // released / rejected → done

      // The door didn't accept the grant. Let the human retry or leave it held.
      const retry = await prompts.confirm({
        message: `Grant for #${offset} wasn't accepted (key enrolled? \`--keys\`). Retry?`,
        initialValue: false,
      });
      if (prompts.isCancel(retry) || !retry) {
        prompts.log.warn(`Left #${offset} held — it will expire on its timeout.`);
        return "next";
      }
    }
    return "next";
  };

  // A backlog request that already carries a grant — don't offer a fresh
  // Approve/Reject (a second approver rejecting or duplicate-granting could
  // race the door already honoring a valid grant). Wait for the door; only if
  // it stays unsettled — an ignored/unverifiable grant — offer it afresh.
  const awaitSubmitted = async (
    offset: number,
    payload: RequestedPayload,
  ): Promise<"stop" | "next"> => {
    if (Date.parse(payload.expiresAt) <= Date.now()) return "next";
    prompts.log.info(
      `#${offset} ${payload.method} ${safeHost(payload.url)} already has a grant — awaiting the egress door...`,
    );
    const settlement = await settleWithRetry(stream, offset);
    reportSettlement(offset, settlement);
    return settlement.kind === "unsettled" ? offerHeldRequest(offset, payload) : "next";
  };

  // Answer requests already held before we connected (oldest first), THEN live-
  // tail new ones. Without this backlog pass a hold halted before the command
  // started would never surface — its caller's fetch left hanging until expiry.
  // The --json front-end reconciles through the same shared function.
  const { open, cursor: from } = await reconcileBacklog(stream);
  for (const request of open) {
    const handle = request.submitted ? awaitSubmitted : offerHeldRequest;
    if ((await handle(request.offset, request.payload)) === "stop") return;
  }

  prompts.log.step(
    native
      ? "Waiting for held egress requests — approvals pop native dialogs... (Ctrl-C to stop)"
      : "Waiting for held egress requests... (Ctrl-C to stop)",
  );

  // Live tail from the reconciled cursor: after the first wait every
  // waitForEvent replays-from-offset, so nothing lands unseen while a prompt is
  // open. Bounded one-shots — a timeout just re-arms from the same cursor.
  let cursor = from;
  while (true) {
    let event: StreamEvent;
    try {
      event = await stream.waitForEvent({
        afterOffset: cursor,
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
    if ((await offerHeldRequest(event.offset, event.payload as RequestedPayload)) === "stop") {
      return;
    }
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

/** Back-off before re-arming a settlement watch after a transient read error. */
const SETTLEMENT_RETRY_MS = 2_000;

/**
 * awaitSettlement, but a transient read `error` re-arms rather than resolving.
 * A grant has been appended, so it still stands at the door — a blip reading the
 * outcome must not abandon the watch (and skip the ignored-grant retry path) as
 * if it had settled. Loops until a real outcome: released, delivery-failed,
 * rejected, or unsettled (the door ignored an unverifiable grant).
 */
async function settleWithRetry(
  stream: RpcStub<Stream>,
  offset: number,
): Promise<Exclude<Settlement, { kind: "error" }>> {
  while (true) {
    const settlement = await awaitSettlement(stream, offset);
    if (settlement.kind !== "error") return settlement;
    await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_RETRY_MS));
  }
}

function reportSettlement(offset: number, settlement: Exclude<Settlement, { kind: "error" }>) {
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
  const lines = [`${payload.method} ${payload.url}`];
  if (payload.secretPaths.length > 0) {
    const noun = payload.secretPaths.length > 1 ? "secrets" : "secret";
    lines.push(`spends ${noun}: ${payload.secretPaths.join(", ")}`);
  }
  if (payload.body) {
    let content = payload.body.content;
    if (payload.body.encoding === "base64") content = `[base64] ${content}`;
    if (payload.body.truncated || content.length > 200) content = `${content.slice(0, 200)}…`;
    lines.push(`body: ${content}`);
  }
  lines.push(`rule: ${payload.ruleKey}`, `expires: ${payload.expiresAt}`);
  prompts.note(lines.join("\n"), `Held egress request #${offset}`);
}
