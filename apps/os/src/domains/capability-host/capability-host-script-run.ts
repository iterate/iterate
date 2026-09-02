import type { StreamEvent, StreamEventInput, StreamEventReadInput } from "iterate/processors";
import type { CapabilityHost } from "../../itx-api.generated.ts";
import { isStreamWaitTimeoutError } from "../streams/stream-unavailable.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import {
  SCRIPT_COMPLETION_OBSERVATION_GRACE_MS,
  ScriptExecutionSettlement,
} from "./script-execution-settlement.ts";

const CREATED = "events.iterate.com/capability-host/created";
const SCRIPT_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const SCRIPT_SETTLED = "events.iterate.com/capability-host/script-run-settled";

/** Stable identity minted outside the processor-hosting Durable Object. */
export type RunScriptCommand = {
  code: string;
  executionId: string;
  expiresAt: number;
};

/** The small stream surface needed by the public script-run protocol. */
export type CapabilityHostScriptStream = {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  getEvent(
    input: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined>;
  getEvents(input: StreamEventReadInput): Promise<StreamEvent[]>;
  waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent>;
};

/**
 * Journal one script obligation and observe its terminal fact directly on the
 * scope stream.
 *
 * This deliberately runs at the stateless RPC boundary, not inside the
 * CapabilityHost Durable Object. Script execution may outlive an incarnation;
 * the successor then records an orphan/expiry settlement on the durable
 * stream. Keeping the public waiter on the old incarnation would lose that
 * settlement if workerd silently orphaned the in-flight DO RPC.
 */
export async function runCapabilityHostScript(input: {
  command: RunScriptCommand;
  now?: () => number;
  path: string;
  stream: CapabilityHostScriptStream;
}): Promise<Awaited<ReturnType<CapabilityHost["runScript"]>>> {
  const { command, path, stream } = input;
  const now = input.now ?? Date.now;
  if (now() >= command.expiresAt) {
    throw new Error(`Script execution "${command.executionId}" expired before it was requested.`);
  }

  const [created] = await stream.getEvents({
    eventTypes: [CREATED],
    limit: 1,
  });
  if (created === undefined) {
    throw new Error(`capability host at ${path} has not been created`);
  }

  const [requested] = await stream.append(
    CapabilityHostProcessorContract.buildEvent({
      type: SCRIPT_REQUESTED,
      idempotencyKey: `capability-host/script-run-requested@${command.executionId}`,
      payload: command,
    }),
  );
  if (requested === undefined) {
    throw new Error(`Script execution "${command.executionId}" committed no request event.`);
  }

  const settlementIdempotencyKey = `capability-host/script-run-settled@${command.executionId}`;
  const timeoutMs = command.expiresAt + SCRIPT_COMPLETION_OBSERVATION_GRACE_MS - now();
  let completedEvent: StreamEvent;
  if (timeoutMs <= 0) {
    // A slow append acknowledgement can arrive after the observation window
    // even though the processor already committed the keyed settlement. One
    // point read preserves that authoritative outcome without opening a new
    // unbounded wait after the absolute deadline.
    const committedSettlement = await stream.getEvent({
      idempotencyKey: settlementIdempotencyKey,
    });
    if (committedSettlement === undefined) {
      throw new Error(
        `Script execution "${command.executionId}" did not settle before its absolute deadline.`,
      );
    }
    completedEvent = committedSettlement;
  } else {
    // Replay from the durable request offset. A settlement that committed
    // before the append acknowledgement or before this wait opened cannot fall
    // into a cursor-less subscription gap.
    try {
      completedEvent = await stream.waitForEvent({
        afterOffset: requested.offset,
        eventTypes: [SCRIPT_SETTLED],
        predicate: (event) => event.idempotencyKey === settlementIdempotencyKey,
        timeoutMs,
      });
    } catch (error) {
      if (!isStreamWaitTimeoutError(error)) throw error;
      throw new Error(
        `Script execution "${command.executionId}" did not settle before its absolute deadline.`,
        { cause: error },
      );
    }
  }
  if (
    completedEvent.type !== SCRIPT_SETTLED ||
    completedEvent.payload?.executionId !== command.executionId
  ) {
    throw new Error(`Script execution "${command.executionId}" completed with a malformed event.`);
  }
  const parsed = ScriptExecutionSettlement.safeParse(completedEvent.payload.settlement);
  if (!parsed.success) {
    throw new Error(`Script execution "${command.executionId}" has a malformed settlement event.`);
  }
  if (parsed.data.status === "failed") throw new Error(parsed.data.error);
  if (parsed.data.result === undefined && parsed.data.oversized !== undefined) {
    // The script ran to completion; only its return value was dropped. A
    // silent `null` here would look like the script chose to return nothing.
    throw new Error(
      `Script execution "${command.executionId}" succeeded but its result ` +
        `(${parsed.data.oversized.serializedChars} chars of JSON) was too large to retain. ` +
        `Write large data to workspace files (itx.workspace) or return a summary.`,
    );
  }
  return {
    completedEvent,
    executionId: command.executionId,
    result: parsed.data.result ?? null,
    scriptEvent: requested,
  };
}
