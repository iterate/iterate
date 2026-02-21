import {
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  parseStreamMetadataUpdatedPayload as parseStreamMetadataUpdatedPayloadFromContract,
  type StreamMetadataUpdatedPayload,
} from "@iterate-com/services-contracts/events";

import { Event, EventInput, StreamPath } from "./domain.ts";

export const EVENTS_META_STREAM_PATH = StreamPath.make("events/_meta");

export const parseStreamMetadataUpdatedPayload = (
  payload: unknown,
): StreamMetadataUpdatedPayload | undefined =>
  parseStreamMetadataUpdatedPayloadFromContract(payload);

export const isStreamMetadataUpdatedEvent = (event: Event | EventInput): boolean =>
  String(event.type) === STREAM_METADATA_UPDATED_TYPE;

export { STREAM_CREATED_TYPE, STREAM_METADATA_UPDATED_TYPE };
