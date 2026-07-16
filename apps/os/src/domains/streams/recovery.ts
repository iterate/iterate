import { z } from "zod";
import { StreamEvent } from "./schemas.ts";

export const STREAM_RECOVERY_FORMAT = "iterate-stream-recovery" as const;
export const STREAM_RECOVERY_VERSION = 1 as const;

const StreamRecoveryCoordinate = z
  .object({
    projectId: z.string().trim().min(1).nullable(),
    path: z.string().trim().min(1),
  })
  .strict();

/** One byte- and count-bounded page from the storage-level recovery export of a stream. */
export const StreamRecoveryExportPage = z
  .object({
    format: z.literal(STREAM_RECOVERY_FORMAT),
    version: z.literal(STREAM_RECOVERY_VERSION),
    stream: StreamRecoveryCoordinate,
    events: z.array(StreamEvent),
    /** Fixed export boundary and allocator floor, including offsets of evicted rows. */
    throughOffset: z.number().int().nonnegative(),
    /** False means another request may be needed; an exactly-full final page may yield one empty page. */
    complete: z.boolean(),
  })
  .strict();

/** The complete normalized log supplied to the storage-level recovery restore. */
export const StreamRecoveryRestoreInput = z
  .object({
    format: z.literal(STREAM_RECOVERY_FORMAT),
    version: z.literal(STREAM_RECOVERY_VERSION),
    stream: StreamRecoveryCoordinate,
    events: z.array(StreamEvent).min(1),
    /** Highest offset ever assigned in the source stream, including evicted rows. */
    highestAssignedOffset: z.number().int().nonnegative(),
  })
  .strict();

/** One bounded page of a stream's storage-level recovery export. */
export type StreamRecoveryExportPage = z.infer<typeof StreamRecoveryExportPage>;

/** Acknowledged page sink used by one long-running recovery export RPC. */
export type StreamRecoveryExportSink = {
  write(page: StreamRecoveryExportPage): Promise<void>;
};

/** Small result returned after every exported page has been acknowledged. */
export type StreamRecoveryExportSummary = {
  format: "iterate-stream-recovery";
  version: 1;
  stream: { projectId: string | null; path: string };
  throughOffset: number;
  exportedEventCount: number;
  pageCount: number;
  lastExportedOffset: number;
  complete: boolean;
};

/** A complete normalized stream log accepted by storage-level recovery restore. */
export type StreamRecoveryRestoreInput = z.infer<typeof StreamRecoveryRestoreInput>;

/**
 * Recovery is deliberately stricter than an ordinary historical stream read:
 * exact offsets and coordinates are the reason encrypted secret events remain
 * decryptable after restore.
 */
export function assertValidStreamRecoveryLog(
  input: StreamRecoveryRestoreInput,
  expected: { projectId: string | null; path: string },
): void {
  if (input.stream.projectId !== expected.projectId || input.stream.path !== expected.path) {
    throw new Error(
      `recovery stream coordinate mismatch: expected ${coordinateLabel(expected)}, got ${coordinateLabel(input.stream)}`,
    );
  }

  const first = input.events[0]!;
  if (first.offset !== 1 || first.type !== "events.iterate.com/stream/created") {
    throw new Error("recovery log must begin with stream/created at offset 1");
  }
  if (first.payload?.projectId !== expected.projectId || first.payload?.path !== expected.path) {
    throw new Error("recovery log's stream/created payload does not match its coordinate");
  }

  let previousOffset = 0;
  const idempotencyKeys = new Set<string>();
  for (const event of input.events) {
    if (event.path !== expected.path) {
      throw new Error(
        `recovery event at offset ${event.offset} belongs to ${event.path}, not ${expected.path}`,
      );
    }
    if (event.offset <= previousOffset) {
      throw new Error("recovery event offsets must be unique and strictly increasing");
    }
    if (event.idempotencyKey !== undefined) {
      if (idempotencyKeys.has(event.idempotencyKey)) {
        throw new Error(`duplicate recovery idempotency key: ${event.idempotencyKey}`);
      }
      idempotencyKeys.add(event.idempotencyKey);
    }
    previousOffset = event.offset;
  }
  if (input.highestAssignedOffset < previousOffset) {
    throw new Error("recovery highestAssignedOffset cannot precede the last surviving event");
  }
}

function coordinateLabel(coordinate: { projectId: string | null; path: string }): string {
  return `${coordinate.projectId ?? "deployment"}:${coordinate.path}`;
}
