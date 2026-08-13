// ─────────────────────────────────────────────────────────────────────────────
// `iterate approve` — be the human in the loop for a project's egress (the
// terminal front-end).
//
// The project's egress door parks outbound requests that match a `hold` rule
// as an approval BATCH (a script run's concurrent burst coalesces into one;
// a lone request is a batch of one) and appends
// `project/human-approval-requested` to the project stream. This command
// live-tails those events, shows each held batch, and appends the verdict —
// ONE signed `human-approval-decided` covering every request (Touch ID on
// the enclave path). The moment the decision lands, the Project DO releases
// (or refuses) the held fetches, whose callers have been waiting.
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
  decide,
  enrollKey,
  EVENT,
  messageFor,
  reconcileBacklog,
  summarizeRequests,
  type RequestedPayload,
  type Settlement,
  type Verdict,
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
    if (key && key.kind !== "secure-enclave") {
      throw new Error(
        "--native needs a Secure Enclave key, but this project's local key is a software key. Revoke it (--revoke) and re-enroll on this Mac.",
      );
    }
    if (!key && input.enroll !== true) {
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
      `Enrolled ${key.kind} key ${key.keyId}. Approvals from this machine now require ${
        key.kind === "secure-enclave" ? "Touch ID" : "this key file"
      }.`,
    );
  }
  prompts.log.info(
    !key
      ? "No local approval key: decisions will be plain events. Run with --enroll to sign approvals."
      : `Approvals are signed with ${key.kind} key ${key.keyId} (${key.label}).`,
  );
  // Offer one held batch until a terminal outcome, or return "stop" if the
  // human cancels (Ctrl-C) so the caller can exit. Shared by the backlog pass
  // and the live tail. A decision the door ignores (unenrolled/revoked key →
  // "unsettled") is re-offered rather than dropped; declining leaves it held.
  const offerHeldBatch = async (
    offset: number,
    payload: RequestedPayload,
  ): Promise<"stop" | "next"> => {
    if (Date.parse(payload.expiresAt) <= Date.now()) {
      prompts.log.warn(`Skipping #${offset} ${summarizeRequests(payload.requests)} — expired.`);
      return "next";
    }

    renderHeldBatch(offset, payload);
    const allApprove = payload.requests.map((): Verdict => "approve");
    const allReject = payload.requests.map((): Verdict => "reject");

    while (Date.parse(payload.expiresAt) > Date.now()) {
      // The human moment. Native mode: one dialog whose Approve button leads
      // straight into the Touch ID sheet. Terminal mode: y/n, then sign.
      // Either way the whole batch gets one verdict set — approve all or
      // reject all (per-index splits are the mobile app's territory).
      let signature: string | undefined;
      if (native) {
        // A cancelled Touch ID sheet comes back as "ignored"; anything else
        // thrown is structural — broken helper, bad blob — and stops the loop.
        const verdict = await promptNativeApproval({
          key: key as Extract<StoredApprovalKey, { kind: "secure-enclave" }>,
          message: messageFor(input.projectId, offset, payload, allApprove),
          request: payload,
        });
        if (verdict.decision === "granted") {
          signature = verdict.signature;
        } else if (verdict.decision === "ignored") {
          prompts.log.info(`Ignored #${offset} — it can be answered elsewhere or expire.`);
          return "next";
        } else {
          await decide({
            stream,
            projectId: input.projectId,
            key,
            offset,
            payload,
            verdicts: allReject,
            reason: await promptRejectReason(),
          });
          prompts.log.warn(`Rejected #${offset}.`);
          return "next";
        }
      } else {
        const approved = await prompts.confirm({
          message: `Approve ${summarizeRequests(payload.requests)}?`,
          initialValue: false,
        });
        if (prompts.isCancel(approved)) {
          prompts.outro("Stopped. Held batches will auto-reject on their timeouts.");
          return "stop";
        }
        if (!approved) {
          await decide({
            stream,
            projectId: input.projectId,
            key,
            offset,
            payload,
            verdicts: allReject,
            reason: await promptRejectReason(),
          });
          prompts.log.warn(`Rejected #${offset}.`);
          return "next";
        }
      }

      // Native already signed inside the dialog (signature set); the terminal
      // path signs here, which is where Touch ID pops for an enclave key.
      const spinner = prompts.spinner();
      spinner.start(
        signature
          ? "Submitting…"
          : key?.kind === "secure-enclave"
            ? "Signing — check Touch ID..."
            : "Signing...",
      );
      try {
        await decide({
          stream,
          projectId: input.projectId,
          key,
          offset,
          payload,
          verdicts: allApprove,
          signature,
        });
        spinner.stop("Signed.");
      } catch (error) {
        spinner.stop("Signing failed.");
        prompts.log.error(error instanceof Error ? error.message : String(error));
        return "next";
      }

      // Deciding is a claim, not a fact — the door verifies and settles.
      const settlement = await settleWithRetry(stream, offset, allApprove);
      reportSettlement(offset, settlement);
      if (settlement.kind !== "unsettled") return "next"; // released / rejected → done

      // The door didn't accept the decision. Let the human retry or leave it held.
      const retry = await prompts.confirm({
        message: `Decision for #${offset} wasn't accepted (key enrolled? \`--keys\`). Retry?`,
        initialValue: false,
      });
      if (prompts.isCancel(retry) || !retry) {
        prompts.log.warn(`Left #${offset} held — it will expire on its timeout.`);
        return "next";
      }
    }
    return "next";
  };

  // A backlog batch that already carries a decision — don't offer a fresh
  // Approve/Reject (the door honors only the FIRST decision, so a second
  // would be dead weight at best). Wait for the door; only if it stays
  // unsettled — an ignored/unverifiable decision — offer it afresh.
  const awaitSubmitted = async (
    offset: number,
    payload: RequestedPayload,
    verdicts: Verdict[],
  ): Promise<"stop" | "next"> => {
    if (Date.parse(payload.expiresAt) <= Date.now()) return "next";
    prompts.log.info(
      `#${offset} ${summarizeRequests(payload.requests)} already has a decision — awaiting the egress door...`,
    );
    const settlement = await settleWithRetry(stream, offset, verdicts);
    reportSettlement(offset, settlement);
    return settlement.kind === "unsettled" ? offerHeldBatch(offset, payload) : "next";
  };

  // Answer batches already held before we connected (oldest first), THEN live-
  // tail new ones. Without this backlog pass a hold parked before the command
  // started would never surface — its caller's fetch left hanging until expiry.
  // The --json front-end reconciles through the same shared function.
  const { open, cursor: from } = await reconcileBacklog(stream);
  for (const batch of open) {
    const outcome = batch.submitted
      ? await awaitSubmitted(batch.offset, batch.payload, batch.verdicts!)
      : await offerHeldBatch(batch.offset, batch.payload);
    if (outcome === "stop") return;
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
    if ((await offerHeldBatch(event.offset, event.payload as RequestedPayload)) === "stop") {
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
    prompts.outro("No approval keys enrolled — decisions are plain events. Enroll with --enroll.");
    return;
  }
  for (const key of keys) {
    const marks = [
      key.keyId === input.localKey?.keyId ? "this machine" : null,
      !key.revokedAt ? null : `revoked ${key.revokedAt}`,
    ].filter((mark) => !!mark);
    prompts.log.info(
      `${key.keyId}  ${key.label}  added ${key.addedAt}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`,
    );
  }
  prompts.outro(`${keys.filter((key) => !key.revokedAt).length} active key(s).`);
}

/**
 * `--revoke`: stop the platform accepting this machine's key, then destroy the
 * local material. Order matters — the event is the act that changes what
 * approvals are accepted; local deletion is just hygiene after it.
 */
async function revokeKey(input: {
  key: StoredApprovalKey | null;
  projectId: string;
  stream: RpcStub<Stream>;
}): Promise<void> {
  if (!input.key) {
    prompts.outro("No local approval key for this project — nothing to revoke.");
    return;
  }
  await input.stream.append({ type: EVENT.keyRevoked, payload: { keyId: input.key.keyId } });
  await deleteApprovalKey(input.projectId);
  prompts.outro(
    `Revoked ${input.key.kind} key ${input.key.keyId} and destroyed the local material. ` +
      "If it was the last active key, approvals fall back to plain events.",
  );
}

/** Optional free-text rejection reason — rides the decided event into each
 * rejected fetch's 403 body so the calling agent reads WHY. Ctrl-C or empty
 * input means no reason; the rejection itself already happened by choice. */
async function promptRejectReason(): Promise<string | undefined> {
  const reason = await prompts.text({
    message: "Why? (optional — the calling agent sees this)",
    placeholder: "wrong recipient, try the staging host, …",
  });
  if (prompts.isCancel(reason) || !reason.trim()) return undefined;
  return reason.trim();
}

/** Back-off before re-arming a settlement watch after a transient read error. */
const SETTLEMENT_RETRY_MS = 2_000;

/**
 * awaitSettlement, but a transient read `error` re-arms rather than resolving.
 * A decision has been appended, so it still stands at the door — a blip reading
 * the outcome must not abandon the watch (and skip the ignored-decision retry
 * path) as if it had settled. Loops until a real outcome: released, rejected,
 * or unsettled (the door ignored an unverifiable decision).
 */
async function settleWithRetry(
  stream: RpcStub<Stream>,
  offset: number,
  verdicts: readonly Verdict[],
): Promise<Exclude<Settlement, { kind: "error" }>> {
  while (true) {
    const settlement = await awaitSettlement(stream, offset, verdicts);
    if (settlement.kind !== "error") return settlement;
    await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_RETRY_MS));
  }
}

function reportSettlement(offset: number, settlement: Exclude<Settlement, { kind: "error" }>) {
  switch (settlement.kind) {
    case "released": {
      const failures = settlement.outcomes.filter((outcome) => !!outcome.error);
      if (failures.length === 0) {
        const statuses = [...new Set(settlement.outcomes.map((outcome) => outcome.status))];
        return prompts.log.success(
          `Released #${offset} — ${settlement.outcomes.length} request${settlement.outcomes.length === 1 ? "" : "s"}, upstream ${statuses.join(", ")}.`,
        );
      }
      return prompts.log.error(
        `Released #${offset} but ${failures.length}/${settlement.outcomes.length} deliveries failed: ${failures
          .map((failure) => `[${failure.index}] ${failure.error}`)
          .join("; ")}`,
      );
    }
    case "rejected":
      return prompts.log.warn(
        settlement.decidedBy === "expiry"
          ? `#${offset} expired before the decision landed.`
          : `Rejected #${offset}.${settlement.reason ? ` Reason: ${settlement.reason}` : ""}`,
      );
    case "unsettled":
      return prompts.log.warn(
        `Decision appended, but #${offset} has not settled — the egress door may have ignored an unverifiable signature, or the hold already expired.`,
      );
  }
}

function renderHeldBatch(offset: number, payload: RequestedPayload): void {
  const lines: string[] = [];
  for (const request of payload.requests.slice(0, 6)) {
    lines.push(`${request.method} ${request.url}`);
  }
  if (payload.requests.length > 6) lines.push(`… and ${payload.requests.length - 6} more`);
  const secretPaths = [...new Set(payload.requests.flatMap((request) => request.secretPaths))];
  if (secretPaths.length > 0) {
    const noun = secretPaths.length > 1 ? "secrets" : "secret";
    lines.push(`spends ${noun}: ${secretPaths.join(", ")}`);
  }
  const only = payload.requests.length === 1 ? payload.requests[0]! : null;
  if (only?.body) {
    let content = only.body.content;
    if (only.body.encoding === "base64") content = `[base64] ${content}`;
    if (only.body.truncated || content.length > 200) content = `${content.slice(0, 200)}…`;
    lines.push(`body: ${content}`);
  }
  lines.push(`rule: ${payload.ruleKey}`, `expires: ${payload.expiresAt}`);
  const noun = payload.requests.length === 1 ? "request" : `batch (${payload.requests.length})`;
  prompts.note(lines.join("\n"), `Held egress ${noun} #${offset}`);
}
