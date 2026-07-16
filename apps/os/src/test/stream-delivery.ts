import type { StreamEvent } from "../domains/streams/schemas.ts";

type TestDelivery = {
  events: readonly StreamEvent[];
  streamMaxOffset: number;
  scannedAfterOffset: number;
  scannedThroughOffset: number;
};

type TestDeliveryInput = Omit<TestDelivery, "scannedAfterOffset" | "scannedThroughOffset"> &
  Partial<Pick<TestDelivery, "scannedAfterOffset" | "scannedThroughOffset">>;

type TestProcessor = {
  readonly checkpointOffset?: number;
  ingest(args: TestDelivery): Promise<void>;
};

/**
 * Gives direct processor tests the same explicit raw-log scan envelope used by
 * every real transport. Tests for invalid coordinates can override either
 * inferred value deliberately.
 */
export function ingestTestBatch(processor: TestProcessor, input: TestDeliveryInput): Promise<void> {
  const checkpointOffset = processor.checkpointOffset ?? 0;
  const eventOffsets = input.events.map((event) => event.offset);
  const firstEventOffset = eventOffsets[0];
  const lastEventOffset = eventOffsets.at(-1);
  const scannedAfterOffset =
    firstEventOffset === undefined
      ? checkpointOffset
      : Math.min(checkpointOffset, firstEventOffset - 1);
  const scannedThroughOffset =
    lastEventOffset === undefined
      ? input.streamMaxOffset
      : Math.max(checkpointOffset, lastEventOffset);

  return processor.ingest({
    ...input,
    scannedAfterOffset: input.scannedAfterOffset ?? scannedAfterOffset,
    scannedThroughOffset: input.scannedThroughOffset ?? scannedThroughOffset,
  });
}
